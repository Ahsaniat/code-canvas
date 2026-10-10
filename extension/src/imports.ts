/**
 * Regex-based import/export scanners.
 *
 * This codebase deliberately avoids a full parser: the scanners must stay fast
 * enough to run over an entire workspace and must never throw on malformed or
 * partially-written source. Every pattern is bounded (no unbounded `[\s\S]*`)
 * so a stray quote cannot make a match span the rest of the file.
 */

import type { ImportKind } from './util';

export type ImportBinding = {
    /** Name as exported by the target module (`default` / `*` for the special forms). */
    name: string;
    /** Local name in the importing module, only when it differs from `name`. */
    alias?: string;
    kind: ImportKind;
};

export type ImportSpec = {
    spec: string;
    line: number;
    bindings: ImportBinding[];
};

/**
 * Offsets of every line start, built once per file so converting a match index
 * to a line number is a binary search instead of a full re-scan. The naive
 * `code.slice(0, idx).split('\n').length` costs O(file) *and* an allocation per
 * match, which is O(file x imports) over a workspace.
 */
function buildLineStarts(code: string): number[] {
    const starts = [0];
    for (let i = 0; i < code.length; i++) {
        if (code.charCodeAt(i) === 10) starts.push(i + 1);
    }
    return starts;
}

function lineAt(starts: number[], index: number): number {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo;
}

/** Merge duplicate (spec, line) hits produced by overlapping patterns. */
function collect(): { add: (spec: string, line: number, bindings: ImportBinding[]) => void; done: () => ImportSpec[] } {
    const byKey = new Map<string, ImportSpec>();
    return {
        add(spec, line, bindings) {
            if (!spec) return;
            const key = `${line}\u0000${spec}`;
            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, { spec, line, bindings: bindings.slice() });
                return;
            }
            const seen = new Set(existing.bindings.map(b => `${b.kind}:${b.name}:${b.alias ?? ''}`));
            for (const b of bindings) {
                const k = `${b.kind}:${b.name}:${b.alias ?? ''}`;
                if (!seen.has(k)) { seen.add(k); existing.bindings.push(b); }
            }
        },
        done() {
            return Array.from(byKey.values()).sort((a, b) => a.line - b.line);
        },
    };
}

/** Parse the `{ a, b as c }` portion of an import/export clause. */
function parseNamedList(inner: string, kind: ImportKind): ImportBinding[] {
    const out: ImportBinding[] = [];
    for (const rawPart of inner.split(',')) {
        const part = rawPart.replace(/^\s*type\s+/, '').trim();
        if (!part) continue;
        const asMatch = /^([A-Za-z_$][\w$]*|default)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
        if (asMatch) {
            out.push({ name: asMatch[1], alias: asMatch[2], kind });
            continue;
        }
        if (/^[A-Za-z_$][\w$]*$/.test(part)) out.push({ name: part, kind });
    }
    return out;
}

/**
 * Parse the clause between `import`/`export` and `from`, e.g.
 * `React, { useMemo, useRef as r }` or `* as ns`.
 */
function parseClause(clause: string, defaultKind: ImportKind): ImportBinding[] {
    const out: ImportBinding[] = [];
    let rest = clause;

    const braces = /\{([^}]*)\}/.exec(rest);
    if (braces) {
        out.push(...parseNamedList(braces[1], defaultKind === 'reexport' ? 'reexport' : 'named'));
        rest = rest.slice(0, braces.index) + rest.slice(braces.index + braces[0].length);
    }

    for (const rawPart of rest.split(',')) {
        const part = rawPart.replace(/^\s*type\s+/, '').trim();
        if (!part) continue;
        const ns = /^\*\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
        if (ns) { out.push({ name: '*', alias: ns[1], kind: 'namespace' }); continue; }
        if (part === '*') { out.push({ name: '*', kind: defaultKind === 'reexport' ? 'reexport' : 'namespace' }); continue; }
        if (/^[A-Za-z_$][\w$]*$/.test(part)) {
            out.push({ name: 'default', alias: part, kind: defaultKind === 'reexport' ? 'reexport' : 'default' });
        }
    }
    return out;
}

// A clause may not contain a quote or a semicolon, which bounds every match to a
// single statement even when the source is malformed.
const RE_IMPORT_FROM = /\bimport\s+(?:type\s+)?([^;'"`]*?)\s+from\s*['"]([^'"]+)['"]/g;
const RE_EXPORT_FROM = /\bexport\s+(?:type\s+)?([^;'"`]*?)\s+from\s*['"]([^'"]+)['"]/g;
const RE_IMPORT_BARE = /\bimport\s*['"]([^'"]+)['"]/g;
const RE_IMPORT_DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_REQUIRE_BOUND = /\b(?:const|let|var)\s+([^;='"`]{0,300}?)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const RE_REQUIRE_ANY = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Parse a CommonJS destructuring target: `{ a, b: c }` or a plain identifier. */
function parseRequireTarget(target: string): ImportBinding[] {
    const out: ImportBinding[] = [];
    const trimmed = target.trim();
    const braces = /^\{([^}]*)\}$/.exec(trimmed);
    if (braces) {
        for (const rawPart of braces[1].split(',')) {
            const part = rawPart.trim();
            if (!part) continue;
            const renamed = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(part);
            if (renamed) { out.push({ name: renamed[1], alias: renamed[2], kind: 'require' }); continue; }
            if (/^[A-Za-z_$][\w$]*$/.test(part)) out.push({ name: part, kind: 'require' });
        }
        return out;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) out.push({ name: '*', alias: trimmed, kind: 'require' });
    return out;
}

/**
 * Scan JS/TS source for module specifiers together with the bindings they carry.
 * Covers: `import d, { a, b as c } from`, `import * as ns from`, `import 'x'`,
 * `export { a } from`, `export * [as ns] from`, `import('x')` and `require('x')`.
 */
export function parseJsTsImports(code: string): ImportSpec[] {
    const acc = collect();
    if (!code) return acc.done();
    try {
        const starts = buildLineStarts(code);
        let m: RegExpExecArray | null;

        RE_IMPORT_FROM.lastIndex = 0;
        while ((m = RE_IMPORT_FROM.exec(code))) acc.add(m[2], lineAt(starts, m.index), parseClause(m[1], 'named'));

        RE_EXPORT_FROM.lastIndex = 0;
        while ((m = RE_EXPORT_FROM.exec(code))) acc.add(m[2], lineAt(starts, m.index), parseClause(m[1], 'reexport'));

        RE_IMPORT_BARE.lastIndex = 0;
        while ((m = RE_IMPORT_BARE.exec(code))) acc.add(m[1], lineAt(starts, m.index), [{ name: '(side effect)', kind: 'side-effect' }]);

        RE_IMPORT_DYNAMIC.lastIndex = 0;
        while ((m = RE_IMPORT_DYNAMIC.exec(code))) acc.add(m[1], lineAt(starts, m.index), [{ name: '*', kind: 'dynamic' }]);

        const boundRequires = new Set<string>();
        RE_REQUIRE_BOUND.lastIndex = 0;
        while ((m = RE_REQUIRE_BOUND.exec(code))) {
            const line = lineAt(starts, m.index);
            boundRequires.add(`${line}\u0000${m[2]}`);
            acc.add(m[2], line, parseRequireTarget(m[1]));
        }
        RE_REQUIRE_ANY.lastIndex = 0;
        while ((m = RE_REQUIRE_ANY.exec(code))) {
            const line = lineAt(starts, m.index);
            if (boundRequires.has(`${line}\u0000${m[1]}`)) continue;
            acc.add(m[1], line, [{ name: '(side effect)', kind: 'side-effect' }]);
        }
    } catch {
        // A pathological input must degrade to whatever was already collected.
    }
    return acc.done();
}

const RE_PY_IMPORT = /^[ \t]*import\s+([^\n#]+)/gm;
const RE_PY_FROM = /^[ \t]*from\s+([.\w]+)\s+import\s+([^\n#]+)/gm;

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

const RE_GO_IMPORT_SINGLE = /^[ \t]*import[ \t]+(?:([A-Za-z_.]\w*|\.|_)[ \t]+)?["`]([^"`\n]+)["`]/gm;
const RE_GO_IMPORT_BLOCK = /^[ \t]*import[ \t]*\(([^)]*)\)/gm;

/** `import "x"` and `import ( alias "x" ... )`. Import paths name packages. */
export function parseGoImports(code: string): ImportSpec[] {
    const acc = collect();
    if (!code) return acc.done();
    try {
        const starts = buildLineStarts(code);
        let m: RegExpExecArray | null;

        RE_GO_IMPORT_SINGLE.lastIndex = 0;
        while ((m = RE_GO_IMPORT_SINGLE.exec(code))) {
            const alias = m[1];
            const spec = m[2];
            const name = alias || spec.split('/').pop() || spec;
            acc.add(spec, lineAt(starts, m.index), [{ name, kind: 'module' }]);
        }

        RE_GO_IMPORT_BLOCK.lastIndex = 0;
        while ((m = RE_GO_IMPORT_BLOCK.exec(code))) {
            const baseLine = lineAt(starts, m.index);
            const lines = m[1].split('\n');
            const lineRe = /(?:([A-Za-z_.]\w*|\.|_)\s+)?"([^"\n]+)"/g;
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].replace(/\/\/.*$/, '');
                let q: RegExpExecArray | null;
                lineRe.lastIndex = 0;
                while ((q = lineRe.exec(line))) {
                    const alias = q[1];
                    const spec = q[2];
                    const name = alias || spec.split('/').pop() || spec;
                    acc.add(spec, baseLine + i, [{ name, kind: 'module' }]);
                }
            }
        }
    } catch {
        // See parseJsTsImports.
    }
    return acc.done();
}

// ---------------------------------------------------------------------------
// Rust
// ---------------------------------------------------------------------------

const RE_RS_MOD = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm;
const RE_RS_USE = /^[ \t]*(?:pub(?:\([^)]*\))?[ \t]+)?use[ \t]+([A-Za-z_][\w:]*)(?:::\{[^}\n]*\})?[ \t]*(?:as[ \t]+\w+)?[ \t]*;/gm;

/**
 * `mod name;` (a child module file) and `use [crate|self|super]::...;`.
 * The spec is prefixed so the resolver can tell the two forms apart.
 */
export function parseRustImports(code: string): ImportSpec[] {
    const acc = collect();
    if (!code) return acc.done();
    try {
        const starts = buildLineStarts(code);
        let m: RegExpExecArray | null;

        RE_RS_MOD.lastIndex = 0;
        while ((m = RE_RS_MOD.exec(code))) {
            acc.add(`mod:${m[1]}`, lineAt(starts, m.index), [{ name: m[1], kind: 'module' }]);
        }

        RE_RS_USE.lastIndex = 0;
        while ((m = RE_RS_USE.exec(code))) {
            const raw = m[1].replace(/::$/, '');
            acc.add(`use:${raw}`, lineAt(starts, m.index), [{ name: raw.split('::').pop() || raw, kind: 'module' }]);
        }
    } catch {
        // See parseJsTsImports.
    }
    return acc.done();
}

// ---------------------------------------------------------------------------
// Java
// ---------------------------------------------------------------------------

const RE_JAVA_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+(?:\.\*)?)[ \t]*;/gm;

/** `import a.b.C;` / `import a.b.*;` (static imports resolve to their type). */
export function parseJavaImports(code: string): ImportSpec[] {
    const acc = collect();
    if (!code) return acc.done();
    try {
        const starts = buildLineStarts(code);
        let m: RegExpExecArray | null;
        RE_JAVA_IMPORT.lastIndex = 0;
        while ((m = RE_JAVA_IMPORT.exec(code))) {
            const spec = m[1];
            const name = spec.endsWith('.*') ? '*' : spec.split('.').pop() || spec;
            acc.add(spec, lineAt(starts, m.index), [{ name, kind: 'named' }]);
        }
    } catch {
        // See parseJsTsImports.
    }
    return acc.done();
}

// ---------------------------------------------------------------------------
// C#
// ---------------------------------------------------------------------------

const RE_CS_USING = /^[ \t]*(?:global[ \t]+)?using[ \t]+(?:static[ \t]+)?([A-Za-z_][\w.]*)[ \t]*;/gm;

/** `using X.Y;` / `global using X.Y;` / `using static X.Y;` (aliases are skipped). */
export function parseCsImports(code: string): ImportSpec[] {
    const acc = collect();
    if (!code) return acc.done();
    try {
        const starts = buildLineStarts(code);
        let m: RegExpExecArray | null;
        RE_CS_USING.lastIndex = 0;
        while ((m = RE_CS_USING.exec(code))) {
            const spec = m[1];
            acc.add(spec, lineAt(starts, m.index), [{ name: spec.split('.').pop() || spec, kind: 'namespace' }]);
        }
    } catch {
        // See parseJsTsImports.
    }
    return acc.done();
}

/**
 * Scan Python source. Covers `import x`, `import x as y`, `import a, b`,
 * `from x import a, b as c` and the parenthesised multi-line form's first line.
 */
export function parsePyImports(code: string): ImportSpec[] {
    const acc = collect();
    if (!code) return acc.done();
    try {
        const starts = buildLineStarts(code);
        let m: RegExpExecArray | null;

        RE_PY_IMPORT.lastIndex = 0;
        while ((m = RE_PY_IMPORT.exec(code))) {
            const line = lineAt(starts, m.index);
            for (const rawPart of m[1].split(',')) {
                const part = rawPart.trim();
                if (!part) continue;
                const aliased = /^([.\w]+)\s+as\s+([A-Za-z_]\w*)$/.exec(part);
                if (aliased) { acc.add(aliased[1], line, [{ name: '*', alias: aliased[2], kind: 'module' }]); continue; }
                if (/^[.\w]+$/.test(part)) acc.add(part, line, [{ name: '*', kind: 'module' }]);
            }
        }

        RE_PY_FROM.lastIndex = 0;
        while ((m = RE_PY_FROM.exec(code))) {
            const line = lineAt(starts, m.index);
            const bindings: ImportBinding[] = [];
            for (const rawPart of m[2].replace(/[()]/g, '').split(',')) {
                const part = rawPart.trim();
                if (!part) continue;
                if (part === '*') { bindings.push({ name: '*', kind: 'namespace' }); continue; }
                const aliased = /^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/.exec(part);
                if (aliased) { bindings.push({ name: aliased[1], alias: aliased[2], kind: 'named' }); continue; }
                if (/^[A-Za-z_]\w*$/.test(part)) bindings.push({ name: part, kind: 'named' });
            }
            acc.add(m[1], line, bindings);
        }
    } catch {
        // See parseJsTsImports.
    }
    return acc.done();
}
