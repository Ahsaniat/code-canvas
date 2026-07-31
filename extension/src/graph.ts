import fg from 'fast-glob';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type { AutoDescriptions, EdgeLink, Graph, GraphNode } from './util';
import { getDocumentSymbols } from './lsp';
import { parseJsTsImports, parsePyImports, type ImportBinding } from './imports';
import { describeFile, describeFolder, extractDocSummary, extractExportedSymbols, type FileImportDetail, type SourceLang } from './describe';

const JS_GLOB = ['**/*.{js,jsx,ts,tsx}'];
const PY_GLOB = ['**/*.py'];

// Normalize paths to a canonical absolute form used for all map/set keys
function normalizePath(p: string): string {
    try {
        let out = path.resolve(p);
        if (process.platform === 'win32') {
            out = path.normalize(out);
            // Lowercase drive letter for consistency
            out = out.replace(/^([A-Z]):\\/, (m, d) => `${d.toLowerCase()}:\\`);
        }
        return out;
    } catch {
        return p;
    }
}

/** An import binding tagged with the source line the statement appeared on. */
type PlacedBinding = ImportBinding & { line: number };

export type Index = {
    nodes: Set<string>;
    imports: Map<string, Set<string>>; // file -> imported file paths (resolved)
    importLines: Map<string, Map<string, number[]>>; // file -> (resolved -> lines)
    // Bindings carried by each resolved import, so an edge can name the symbols
    // that actually cross the module boundary (requirement: edge hover info).
    importBindings: Map<string, Map<string, PlacedBinding[]>>; // file -> (resolved -> bindings)
    lang: Map<string, SourceLang>;
    // Captured during the single read pass so auto-descriptions never re-read disk.
    exports: Map<string, string[]>;
    doc: Map<string, string>;
};

export async function buildIndex(root: string): Promise<Index> {
    const excludes: string[] = vscode.workspace.getConfiguration('codeCanvas').get('excludeGlobs') || [];
    const rawFiles = Array.from(new Set([
        ...await fg(JS_GLOB, { cwd: root, absolute: true, ignore: excludes }),
        ...await fg(PY_GLOB, { cwd: root, absolute: true, ignore: excludes }),
    ]));
    const files = rawFiles.map(f => normalizePath(f));

    const lang = new Map<string, SourceLang>();
    for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        lang.set(
            f,
            ext === '.py' ? 'py'
                : (ext === '.ts' || ext === '.tsx') ? 'ts'
                    : (ext === '.js' || ext === '.jsx') ? 'js'
                        : 'other'
        );
    }

    const imports = new Map<string, Set<string>>();
    const importLines = new Map<string, Map<string, number[]>>();
    const importBindings = new Map<string, Map<string, PlacedBinding[]>>();
    const exports = new Map<string, string[]>();
    const doc = new Map<string, string>();
    // Per-build cache of fs.existsSync probes (module resolution tries up to ~9
    // candidate paths per import) so we never stat the same path twice. Scoped to
    // this build so a later reload re-probes fresh (P2-5).
    const existsCache = new Map<string, boolean>();

    // P2-5: read files asynchronously with bounded concurrency instead of a
    // sequential wall of blocking readFileSync calls.
    const sources = await mapWithConcurrency(files, 24, async f => [f, await safeReadAsync(f)] as const);
    for (const [f, src] of sources) {
        const fileLang = lang.get(f) ?? 'other';
        const specs = fileLang === 'py' ? parsePyImports(src) : parseJsTsImports(src);
        const targets = new Set<string>();
        const lineMap = new Map<string, number[]>();
        const bindingMap = new Map<string, PlacedBinding[]>();
        for (const { spec, line, bindings } of specs) {
            const r = fileLang === 'py' ? resolvePy(root, f, spec, existsCache) : resolveJsTs(f, spec, existsCache);
            if (!r) continue;
            const rNorm = normalizePath(r);
            targets.add(rNorm);
            const arr = lineMap.get(rNorm) || [];
            arr.push(line);
            lineMap.set(rNorm, arr);
            const acc = bindingMap.get(rNorm) || [];
            for (const b of bindings) acc.push({ ...b, line });
            bindingMap.set(rNorm, acc);
        }
        imports.set(f, targets);
        importLines.set(f, lineMap);
        importBindings.set(f, bindingMap);
        exports.set(f, extractExportedSymbols(src, fileLang));
        const summary = extractDocSummary(src, fileLang);
        if (summary) doc.set(f, summary);
    }

    return { nodes: new Set(files), imports, importLines, importBindings, lang, exports, doc };
}

/** Number of indexed files that import `file`. */
function countImporters(index: Index, file: string): number {
    let n = 0;
    for (const outs of index.imports.values()) if (outs.has(file)) n++;
    return n;
}

// Build a subgraph with BFS from seeds up to max nodes/edges.
export async function subgraph(index: Index, seeds: string[], maxNodes: number): Promise<Graph> {
    const seen = new Set<string>();
    const q: string[] = [];
    for (const s of seeds) {
        const sNorm = normalizePath(s);
        if (index.nodes.has(sNorm)) { seen.add(sNorm); q.push(sNorm); }
    }

    // If no valid seeds, pick up to 10 random-ish files to start
    if (q.length === 0) {
        for (const f of Array.from(index.nodes).slice(0, Math.min(10, index.nodes.size))) {
            seen.add(f); q.push(f);
        }
    }

    while (q.length && seen.size < maxNodes) {
        const cur = q.shift()!;
        const out = index.imports.get(cur) || new Set();
        for (const t of out) {
            if (seen.size >= maxNodes) break;
            const tNorm = normalizePath(t);
            if (!index.nodes.has(tNorm)) continue;
            if (!seen.has(tNorm)) { seen.add(tNorm); q.push(tNorm); }
        }
        // add a bit of reverse reachability (files importing cur)
        for (const [f, outs] of index.imports) {
            if (outs.has(cur) && !seen.has(f)) {
                if (seen.size >= maxNodes) break;
                seen.add(f); q.push(f);
            }
        }
    }

    // The walk above only follows import edges, so it can never leave the seed's
    // connected component. A repo whose frontend never imports its backend would
    // therefore render as the backend alone — which is what "my frontend is
    // missing" looks like. Top up with whatever else the workspace holds so
    // disconnected parts of the tree still show up, budget permitting.
    if (seen.size < maxNodes) {
        for (const f of index.nodes) {
            if (seen.size >= maxNodes) break;
            seen.add(f);
        }
    }

    // Build recursive group hierarchy from workspace root
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!wsFolder) return { nodes: [], edges: [] };
    const rootDir = normalizePath(wsFolder);

    const groupByDir = new Map<string, { id: string; parent?: string; label: string }>();
    const ensureGroup = (dir: string): { id: string; parent?: string; label: string } => {
        const norm = normalizePath(dir);
        if (groupByDir.has(norm)) return groupByDir.get(norm)!;
        if (norm === rootDir) {
            // Represent root as a group as well so deeper folders can attach
            const rootGroup = { id: `group_${makeSafeId(norm)}`, parent: undefined, label: path.basename(norm) || norm };
            groupByDir.set(norm, rootGroup);
            return rootGroup;
        }
        const parentDir = path.dirname(norm);
        const parent = ensureGroup(parentDir);
        const label = path.basename(norm) || path.relative(parentDir, norm) || norm;
        const node = { id: `group_${makeSafeId(norm)}`, parent: parent?.id, label };
        groupByDir.set(norm, node);
        return node;
    };

    ensureGroup(rootDir);
    const fileNodes = Array.from(seen).map(f => {
        const fileDir = path.dirname(f);
        // Ensure all ancestors from root to this file's dir are present
        let cur = fileDir;
        while (cur && cur.startsWith(rootDir)) {
            ensureGroup(cur);
            if (cur === rootDir) break;
            const next = path.dirname(cur);
            if (next === cur) break;
            cur = next;
        }
        const parent = groupByDir.get(normalizePath(fileDir));
        return {
            id: makeSafeId(f),
            label: path.basename(f),
            path: f,
            lang: (index.lang.get(f) || 'other') as any,
            type: 'file' as const,
            parentId: parent?.id,
        };
    });

    // Emit unique group nodes including the root wrapper
    const groupNodes = Array.from(groupByDir.entries())
        .map(([dir, info]) => ({
            id: info.id,
            label: info.label,
            type: 'group' as const,
            path: dir,
            parentId: info.parent, // root has undefined parent, others point up the chain
        }));

    // P0-1: React Flow v11 requires every parent node to appear BEFORE its
    // children. Emit groups first, then sort the combined list by hierarchy depth
    // so a parent (lower depth) always strictly precedes its descendants.
    const combined = [...groupNodes, ...fileNodes];
    const nodeById = new Map(combined.map(n => [n.id, n] as const));
    const depthOf = (id: string): number => {
        let d = 0;
        let cur = nodeById.get(id)?.parentId;
        let guard = 0;
        while (cur && guard++ < 10000) { d++; cur = nodeById.get(cur)?.parentId; }
        return d;
    };
    const allNodes = combined
        .map((n, i) => ({ n, i, d: depthOf(n.id) }))
        .sort((a, b) => (a.d - b.d) || (a.i - b.i))
        .map(x => x.n);

    const nodeIdByPath = new Map<string, string>();
    for (const n of fileNodes) {
        if (n.path) nodeIdByPath.set(n.path, n.id);
    }

    const edges: Graph['edges'] = [];
    // Symbols are fetched at most once per target file and reused across every
    // edge that points at it.
    const symbolCache = new Map<string, Awaited<ReturnType<typeof getDocumentSymbols>>>();
    const getSymbols = async (file: string) => {
        if (!symbolCache.has(file)) {
            symbolCache.set(file, await getDocumentSymbols(vscode.Uri.file(file)));
        }
        return symbolCache.get(file)!;
    };

    for (const s of seen) {
        const lineMap = index.importLines.get(s) || new Map<string, number[]>();
        const bindingMap = index.importBindings.get(s) || new Map<string, PlacedBinding[]>();
        for (const t of (index.imports.get(s) || new Set<string>())) {
            if (!seen.has(t)) continue;
            const sid = nodeIdByPath.get(s)!;
            const tid = nodeIdByPath.get(t)!;
            const lines = lineMap.get(t) || [];
            const sourceLine = lines.length ? lines[0] : undefined;
            const links = await buildEdgeLinks(bindingMap.get(t) || [], () => getSymbols(t));
            edges.push({
                id: `e_${hashString(s + '->' + t + '#' + (sourceLine ?? -1))}`,
                source: sid,
                target: tid,
                kind: 'import',
                sourceLine,
                targetLine: links[0]?.targetLine ?? 0,
                links,
            });
        }
    }

    return { nodes: allNodes, edges };
}

/**
 * Turn the bindings behind one file->file import into EdgeLinks, resolving each
 * binding to a line in the target by name-matching its DocumentSymbols. Falls
 * back to the target's most prominent top-level symbol when the name is unknown
 * (namespace imports, dynamic imports, side-effect imports).
 */
async function buildEdgeLinks(
    bindings: PlacedBinding[],
    symbolsOf: () => Promise<Awaited<ReturnType<typeof getDocumentSymbols>>>
): Promise<EdgeLink[]> {
    let symbols: Awaited<ReturnType<typeof getDocumentSymbols>> = [];
    try {
        symbols = await symbolsOf();
    } catch {
        symbols = [];
    }

    const byName = new Map<string, number>();
    for (const sym of symbols) {
        const line = sym.range?.start?.line;
        if (line == null || byName.has(sym.name)) continue;
        byName.set(sym.name, line);
    }
    const fallbackLine = pickPrimarySymbolLine(symbols);

    const out: EdgeLink[] = [];
    const seen = new Set<string>();
    for (const b of bindings) {
        const key = `${b.kind}:${b.name}:${b.alias ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const named = b.name && b.name !== '*' && b.name !== 'default' && b.name !== '(side effect)';
        out.push({
            symbolName: named ? b.name : undefined,
            alias: b.alias,
            kind: b.kind,
            sourceLine: b.line,
            targetLine: (named ? byName.get(b.name) : undefined) ?? fallbackLine,
        });
    }
    if (!out.length) out.push({ targetLine: fallbackLine, kind: 'module' });
    return out;
}

function pickPrimarySymbolLine(symbols: Awaited<ReturnType<typeof getDocumentSymbols>>): number {
    const topLevel = symbols.filter(sy => sy.range?.start?.line != null);
    if (!topLevel.length) return 0;
    if (topLevel.length === 1) return topLevel[0].range.start.line;
    const preferred = topLevel.find(sy =>
        sy.kind === vscode.SymbolKind.Class ||
        sy.kind === vscode.SymbolKind.Function ||
        sy.kind === vscode.SymbolKind.Method) || topLevel[0];
    return preferred.range.start.line;
}

// ---------------------------------------------------------------------------
// Automatic descriptions
// ---------------------------------------------------------------------------

/**
 * Derive an auto-description for every node in `graph`, using only data already
 * captured by `buildIndex` (no extra disk reads). These are stored separately
 * from user-authored descriptions and never overwrite them.
 */
export function describeGraph(index: Index, graph: Graph): AutoDescriptions {
    const out: AutoDescriptions = {};
    try {
        const importerCount = new Map<string, number>();
        for (const outs of index.imports.values()) {
            for (const t of outs) importerCount.set(t, (importerCount.get(t) ?? 0) + 1);
        }

        // Enumerate each file's imports as "which symbols, from which file".
        // Built from the graph edges so the names shown are the ones actually
        // resolved, not a re-parse of the specifier text.
        const nodeByIdForImports = new Map(graph.nodes.map(n => [n.id, n] as const));
        const importsByFile = new Map<string, FileImportDetail[]>();
        for (const e of graph.edges) {
            const sourcePath = nodeByIdForImports.get(e.source)?.path;
            const targetNode = nodeByIdForImports.get(e.target);
            if (!sourcePath || !targetNode?.path) continue;
            // For a named import the symbol is the name. For a default, namespace
            // or CommonJS `const X = require(...)` import there IS no exported
            // name to quote — the binding the reader recognises is the local
            // alias, so fall back to it rather than saying "whole module".
            const symbols = Array.from(new Set(
                (e.links ?? [])
                    .map(l => l.symbolName ?? l.alias)
                    .filter((s): s is string => !!s && s !== '*' && s !== '(side effect)')
            )).sort();
            const list = importsByFile.get(sourcePath) ?? [];
            list.push({ symbols, from: targetNode.label });
            importsByFile.set(sourcePath, list);
        }
        for (const list of importsByFile.values()) {
            list.sort((a, b) => a.from.localeCompare(b.from));
        }

        const fileNodes = graph.nodes.filter(n => n.type === 'file' && n.path);
        for (const n of fileNodes) {
            const p = n.path!;
            out[p] = {
                kind: 'file',
                autoDescription: describeFile({
                    fileName: n.label,
                    lang: index.lang.get(p) ?? 'other',
                    doc: index.doc.get(p),
                    exportedSymbols: index.exports.get(p) ?? [],
                    imports: importsByFile.get(p) ?? [],
                    importedByCount: importerCount.get(p) ?? countImporters(index, p),
                }),
            };
        }

        // Folder rollups: attribute each file to every ancestor folder in the graph.
        const folderNodes = graph.nodes.filter(n => n.type === 'group' && n.path);
        const byId = new Map(graph.nodes.map(n => [n.id, n] as const));

        const stats = new Map<string, {
            directFiles: number; directSubfolders: number; totalFiles: number;
            langCounts: Partial<Record<SourceLang, number>>;
        }>();
        for (const f of folderNodes) {
            stats.set(f.id, { directFiles: 0, directSubfolders: 0, totalFiles: 0, langCounts: {} });
        }
        for (const f of folderNodes) {
            const parent = f.parentId ? stats.get(f.parentId) : undefined;
            if (parent) parent.directSubfolders++;
        }
        for (const n of fileNodes) {
            const p = n.path!;
            const lang = index.lang.get(p) ?? 'other';

            const direct = n.parentId ? stats.get(n.parentId) : undefined;
            if (direct) direct.directFiles++;

            for (const ancestorId of ancestorsOf(byId, n.parentId)) {
                const st = stats.get(ancestorId);
                if (!st) continue;
                st.totalFiles++;
                st.langCounts[lang] = (st.langCounts[lang] ?? 0) + 1;
            }
        }

        const external = folderExternalDegrees(graph, byId);
        for (const f of folderNodes) {
            const st = stats.get(f.id)!;
            const deg = external.get(f.id) ?? { inDeg: 0, outDeg: 0 };
            out[f.path!] = {
                kind: 'folder',
                autoDescription: describeFolder({
                    folderName: f.label,
                    directFileCount: st.directFiles,
                    directSubfolderCount: st.directSubfolders,
                    totalFileCount: st.totalFiles,
                    langCounts: st.langCounts,
                    externalInDegree: deg.inDeg,
                    externalOutDegree: deg.outDeg,
                }),
            };
        }
    } catch {
        // A description is a nicety; never fail graph delivery because of one.
    }
    return out;
}

function ancestorsOf(byId: Map<string, GraphNode>, startId: string | undefined): string[] {
    const out: string[] = [];
    let cur = startId;
    let guard = 0;
    while (cur && guard++ < 10000) {
        out.push(cur);
        cur = byId.get(cur)?.parentId;
    }
    return out;
}

/** Count edges that cross each folder's boundary (both endpoints resolved to folders). */
function folderExternalDegrees(graph: Graph, byId: Map<string, GraphNode>): Map<string, { inDeg: number; outDeg: number }> {
    const result = new Map<string, { inDeg: number; outDeg: number }>();
    const ancestorSet = new Map<string, Set<string>>();
    const ancestorsFor = (id: string): Set<string> => {
        let s = ancestorSet.get(id);
        if (!s) {
            s = new Set(ancestorsOf(byId, byId.get(id)?.parentId));
            ancestorSet.set(id, s);
        }
        return s;
    };
    for (const e of graph.edges) {
        const srcAnc = ancestorsFor(e.source);
        const tgtAnc = ancestorsFor(e.target);
        for (const a of srcAnc) {
            if (tgtAnc.has(a)) continue; // internal to this folder
            const r = result.get(a) ?? { inDeg: 0, outDeg: 0 };
            r.outDeg++;
            result.set(a, r);
        }
        for (const a of tgtAnc) {
            if (srcAnc.has(a)) continue;
            const r = result.get(a) ?? { inDeg: 0, outDeg: 0 };
            r.inDeg++;
            result.set(a, r);
        }
    }
    return result;
}

async function safeReadAsync(p: string): Promise<string> {
    try { return await fs.promises.readFile(p, 'utf8'); } catch { return ''; }
}

// Run async tasks with a bounded number of them in flight at once.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    const count = Math.max(1, Math.min(limit, items.length));
    const workers = new Array(count).fill(0).map(async () => {
        for (let i = next++; i < items.length; i = next++) {
            results[i] = await fn(items[i]);
        }
    });
    await Promise.all(workers);
    return results;
}

function existsCached(p: string, cache?: Map<string, boolean>): boolean {
    if (!cache) return fs.existsSync(p);
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    const v = fs.existsSync(p);
    cache.set(p, v);
    return v;
}

function resolveJsTs(fromFile: string, spec: string, exists?: Map<string, boolean>): string | undefined {
    if (!spec.startsWith('.') && !spec.startsWith('/')) return; // skip packages
    const base = path.resolve(path.dirname(fromFile), spec);
    const tries = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    for (const t of tries) { const p = base + t; if (existsCached(p, exists)) return normalizePath(p); }
}
function resolvePy(root: string, _from: string, mod: string, exists?: Map<string, boolean>): string | undefined {
    const parts = mod.split('.');
    const candidates = [
        path.resolve(root, ...parts) + '.py',
        path.resolve(root, ...parts, '__init__.py')
    ];
    for (const p of candidates) if (existsCached(p, exists)) return normalizePath(p);
}

function hashString(input: string): string {
    let hash = 0 >>> 0;
    for (let i = 0; i < input.length; i++) {
        hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}

function makeSafeId(raw: string): string {
    const safe = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `n_${safe}_${hashString(raw)}`;
}
