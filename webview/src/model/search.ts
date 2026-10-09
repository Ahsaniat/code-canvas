/**
 * Node search over the FULL model, not the projection.
 *
 * This distinction is the whole point. The canvas is collapse-first, so at any
 * moment most of the repository is folded inside a collapsed folder and never
 * reaches React Flow. Searching what is rendered would therefore only ever find
 * what the user can already see. The index below is built from `GraphModel`,
 * which holds every indexed file whether or not it is currently drawn — so a hit
 * can be *revealed* by expanding its ancestors.
 *
 * Matching is plain case-insensitive substring plus a subsequence fallback on
 * the filename. Deliberately not a fuzzy ranker: predictable beats clever when
 * the result decides what the canvas expands.
 */

import type { GraphModel, ModelNode } from './graphModel';

/** Which part of a node produced the hit. Shown as the result's badge. */
export type MatchField = 'name' | 'path' | 'symbol' | 'tag';

export interface SearchHit {
    id: string;
    label: string;
    path?: string;
    kind: 'file' | 'folder';
    /** Which field matched. */
    field: MatchField;
    /** The exact symbol or tag that matched, when that is what hit. */
    detail?: string;
    score: number;
}

/** One node, pre-lowercased so a keystroke costs only `indexOf` calls. */
interface IndexEntry {
    id: string;
    label: string;
    labelLower: string;
    path?: string;
    pathLower: string;
    kind: 'file' | 'folder';
    symbols: string[];
    symbolsLower: string[];
}

export interface SearchIndex {
    entries: IndexEntry[];
}

/** Field qualifiers: `tag:api`, `sym:useStore`, `path:src/`, `name:index`. */
const QUALIFIERS: Record<string, MatchField> = {
    name: 'name',
    file: 'name',
    path: 'path',
    dir: 'path',
    sym: 'symbol',
    symbol: 'symbol',
    export: 'symbol',
    tag: 'tag',
};

export interface ParsedQuery {
    /** `undefined` means "search every field". */
    field?: MatchField;
    term: string;
    termLower: string;
}

export function parseQuery(raw: string): ParsedQuery | null {
    const trimmed = (raw ?? '').trim();
    if (!trimmed) return null;

    const match = /^([a-z]+):\s*(.*)$/i.exec(trimmed);
    if (match) {
        const field = QUALIFIERS[match[1].toLowerCase()];
        // An unknown prefix is not a qualifier — `http://x` must stay a literal.
        if (field) {
            const term = match[2].trim();
            if (!term) return null;
            return { field, term, termLower: term.toLowerCase() };
        }
    }
    return { term: trimmed, termLower: trimmed.toLowerCase() };
}

/**
  Build the lowercase index. Rebuilt only when the model changes, so typing
  never re-walks the tree or re-lowercases a string.
 
  Indexed from `displayRoots` DOWN, not from `model.nodes`, because the two are
  not the same set: `buildModel` elides the workspace-root wrapper, which stays
  in `nodes` but can never be projected. Indexing it produced a result that
  looked ordinary and then silently failed to reveal — a hit must always be
  something the canvas can actually show.
 **/
export function buildSearchIndex(model: GraphModel): SearchIndex {
    const provided = providedSymbols(model);
    const entries: IndexEntry[] = [];
    const stack = [...model.displayRoots];
    const seen = new Set<string>();
    while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const node = model.nodes.get(id);
        if (!node) continue;
        entries.push(toEntry(node, provided.get(id)));
        for (const child of node.childIds) stack.push(child);
    }
    // Stable, readable ordering for equal scores.
    entries.sort((a, b) => a.labelLower.localeCompare(b.labelLower) || a.id.localeCompare(b.id));
    return { entries };
}

/**
 Names each file is known to provide, harvested from its INCOMING edges.

 The declared-export scanner can only report what a regex can name, and the
 dominant CommonJS idiom — `module.exports = mongoose.model('User', schema)` —
 exports a symbol that appears nowhere as a declaration. Its importers name it
 for us (`const User = require('./user')`), and that binding is already on the
 edge. So the exporter side and the consumer side are unioned: either one
 finding the name is enough.
 **/
function providedSymbols(model: GraphModel): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const edge of model.edges) {
        for (const link of edge.links ?? []) {
            const name = link.symbolName ?? link.alias;
            if (!name || name === '*' || name.startsWith('(')) continue;
            let list = out.get(edge.target);
            if (!list) { list = []; out.set(edge.target, list); }
            if (!list.includes(name)) list.push(name);
        }
    }
    return out;
}

function toEntry(node: ModelNode, providedNames?: string[]): IndexEntry {
    const symbols = node.kind === 'file' ? unionSymbols(node.symbols ?? [], providedNames) : [];
    return {
        id: node.id,
        label: node.label,
        labelLower: node.label.toLowerCase(),
        path: node.path,
        pathLower: (node.path ?? '').toLowerCase(),
        kind: node.kind,
        symbols,
        symbolsLower: symbols.map(s => s.toLowerCase()),
    };
}

// Score tiers. The gaps are wide enough that no combination of tie-breaks can
// reorder two different tiers.
const S_NAME_EXACT = 1000;
const S_NAME_PREFIX = 800;
const S_NAME_SUBSTR = 600;
const S_SYMBOL_EXACT = 520;
const S_SYMBOL_PREFIX = 440;
const S_SYMBOL_SUBSTR = 380;
const S_TAG_EXACT = 340;
const S_TAG_SUBSTR = 300;
const S_PATH_SUBSTR = 200;
const S_NAME_SUBSEQ = 100;

/** Minimum term length before the subsequence fallback is worth running. */
const SUBSEQ_MIN_TERM = 2;

export interface SearchOptions {
    /** Tags for a node path, from the meta store. */
    tagsOf?: (path: string | undefined) => string[];
    /** Cap on returned hits. Omit for all of them (filter mode wants all). */
    limit?: number;
}

/**
 * Run a query. Returns hits ordered best-first; each node appears at most once,
 * carrying its single strongest match.
 */
export function searchNodes(index: SearchIndex, raw: string, options: SearchOptions = {}): SearchHit[] {
    const parsed = parseQuery(raw);
    if (!parsed) return [];

    const { tagsOf, limit } = options;
    const hits: SearchHit[] = [];

    for (const entry of index.entries) {
        const hit = scoreEntry(entry, parsed, tagsOf);
        if (hit) hits.push(hit);
    }

    hits.sort((a, b) =>
        b.score - a.score ||
        a.label.length - b.label.length ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id));

    return limit != null && limit >= 0 ? hits.slice(0, limit) : hits;
}

function scoreEntry(
    entry: IndexEntry,
    parsed: ParsedQuery,
    tagsOf?: (path: string | undefined) => string[],
): SearchHit | null {
    const { field, termLower } = parsed;
    const any = field === undefined;

    let bestScore = 0;
    let bestField: MatchField = 'name';
    let bestDetail: string | undefined;
    const offer = (score: number, matchField: MatchField, detail?: string) => {
        if (score <= bestScore) return;
        bestScore = score;
        bestField = matchField;
        bestDetail = detail;
    };

    if (any || field === 'name') {
        const i = entry.labelLower.indexOf(termLower);
        if (entry.labelLower === termLower) offer(S_NAME_EXACT, 'name');
        else if (i === 0) offer(S_NAME_PREFIX, 'name');
        else if (i > 0) offer(S_NAME_SUBSTR, 'name');
    }

    if (any || field === 'symbol') {
        for (let s = 0; s < entry.symbolsLower.length; s++) {
            const sym = entry.symbolsLower[s];
            const i = sym.indexOf(termLower);
            if (i < 0) continue;
            const score = sym === termLower ? S_SYMBOL_EXACT : i === 0 ? S_SYMBOL_PREFIX : S_SYMBOL_SUBSTR;
            offer(score, 'symbol', entry.symbols[s]);
            if (score === S_SYMBOL_EXACT) break;
        }
    }

    if (any || field === 'tag') {
        for (const tag of tagsOf?.(entry.path) ?? []) {
            const lower = tag.toLowerCase();
            if (lower === termLower) offer(S_TAG_EXACT, 'tag', tag);
            else if (lower.includes(termLower)) offer(S_TAG_SUBSTR, 'tag', tag);
        }
    }

    if (any || field === 'path') {
        // The filename is part of the path, so a plain query would report every
        // name hit twice. Only score the directory part unless `path:` was asked
        // for explicitly.
        const haystack = any ? directoryPart(entry.pathLower) : entry.pathLower;
        if (haystack.includes(termLower)) offer(S_PATH_SUBSTR, 'path');
    }

    // Last resort, filenames only: `gm` -> `graphModel.ts`. Never applied to
    // paths, where a short term would subsequence-match nearly everything.
    if (bestScore === 0 && (any || field === 'name') && termLower.length >= SUBSEQ_MIN_TERM) {
        if (isSubsequence(termLower, entry.labelLower)) offer(S_NAME_SUBSEQ, 'name');
    }

    if (bestScore === 0) return null;
    return {
        id: entry.id,
        label: entry.label,
        path: entry.path,
        kind: entry.kind,
        field: bestField,
        detail: bestDetail,
        score: bestScore,
    };
}

/** Declared exports first (they are the file's own truth), then observed ones. */
function unionSymbols(declared: string[], observed?: string[]): string[] {
    if (!observed?.length) return declared;
    const out = declared.slice();
    const seen = new Set(declared);
    for (const name of observed) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push(name);
    }
    return out;
}

function directoryPart(pathLower: string): string {
    const cut = pathLower.lastIndexOf('/');
    return cut > 0 ? pathLower.slice(0, cut) : '';
}

function isSubsequence(term: string, target: string): boolean {
    let t = 0;
    for (let i = 0; i < target.length && t < term.length; i++) {
        if (target[i] === term[t]) t++;
    }
    return t === term.length;
}

/**
 * Hit ids plus every ancestor of every hit.
 *
 * Filter mode dims what does not match, and a match buried in a collapsed folder
 * has no node of its own on the canvas. Keeping its ancestors lit is what tells
 * the user "there is something in here" instead of dimming the only affordance
 * that could reveal it.
 */
export function matchedWithAncestors(model: GraphModel, hits: SearchHit[]): Set<string> {
    const out = new Set<string>();
    const stopAt = new Set(model.displayRoots);   // above these nothing is drawn
    for (const hit of hits) {
        let cur: string | undefined = hit.id;
        let guard = 0;
        while (cur && guard++ < 10000) {
            if (out.has(cur)) break;   // this chain is already recorded
            out.add(cur);
            if (stopAt.has(cur)) break;
            cur = model.nodes.get(cur)?.parentId;
        }
    }
    return out;
}
