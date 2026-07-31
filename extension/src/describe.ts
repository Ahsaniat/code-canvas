/**
 * Heuristic, dependency-free description generation.
 *
 * There is no LLM available in-process, so a description is derived from what is
 * statically observable: a leading doc comment / module docstring when the author
 * wrote one, otherwise a summary built from the file's exported symbols and its
 * position in the import graph.
 *
 * Every function here is total: malformed input yields `undefined` or a degraded
 * summary, never an exception.
 */

export type SourceLang = 'js' | 'ts' | 'py' | 'other';

const MAX_SUMMARY_CHARS = 240;
const MAX_LISTED_SYMBOLS = 4;

/** Comment blocks that are legal boilerplate rather than a description. */
const BOILERPLATE = /\b(copyright|licen[cs]ed?\s+under|SPDX-License-Identifier|all rights reserved|eslint-disable|@ts-nocheck|prettier-ignore)\b/i;

function clamp(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (flat.length <= MAX_SUMMARY_CHARS) return flat;
    return flat.slice(0, MAX_SUMMARY_CHARS - 1).replace(/\s+\S*$/, '') + '…';
}

/** First sentence of a paragraph, falling back to the whole (clamped) text. */
function firstSentence(text: string): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    if (!flat) return '';
    const m = /^(.*?[.!?])(\s|$)/.exec(flat);
    return clamp(m ? m[1] : flat);
}

// ---------------------------------------------------------------------------
// Doc / docstring extraction
// ---------------------------------------------------------------------------

/** Strip the decorative leading `*` column from a JSDoc body. */
function stripBlockCommentBody(body: string): string {
    return body
        .split(/\r?\n/)
        .map(l => l.replace(/^\s*\*+\s?/, '').trim())
        .join('\n')
        .trim();
}

/** Cut a doc body at the first block tag (`@param`, `:param`, `Args:` …). */
function beforeTags(body: string): string {
    const idx = body.search(/(^|\n)\s*(@\w+|:\w+:|Args:|Returns:|Raises:|Attributes:)/);
    return (idx >= 0 ? body.slice(0, idx) : body).trim();
}

function extractJsDoc(source: string): string | undefined {
    let i = 0;
    if (source.startsWith('#!')) {
        const nl = source.indexOf('\n');
        i = nl < 0 ? source.length : nl + 1;
    }
    // Walk consecutive leading comments; skip boilerplate ones and stop at code.
    for (let guard = 0; guard < 16; guard++) {
        while (i < source.length && /\s/.test(source[i])) i++;
        if (source.startsWith("'use strict'", i) || source.startsWith('"use strict"', i)) {
            const semi = source.indexOf('\n', i);
            i = semi < 0 ? source.length : semi + 1;
            continue;
        }
        if (source.startsWith('/*', i)) {
            const end = source.indexOf('*/', i + 2);
            if (end < 0) return undefined;
            const raw = source.slice(i + (source.startsWith('/**', i) ? 3 : 2), end);
            i = end + 2;
            const body = beforeTags(stripBlockCommentBody(raw));
            if (body && !BOILERPLATE.test(body)) return body;
            continue;
        }
        if (source.startsWith('//', i)) {
            const lines: string[] = [];
            while (source.startsWith('//', i)) {
                const nl = source.indexOf('\n', i);
                const line = source.slice(i + 2, nl < 0 ? source.length : nl);
                lines.push(line.trim());
                i = nl < 0 ? source.length : nl + 1;
                while (i < source.length && /[ \t]/.test(source[i])) i++;
            }
            const body = beforeTags(lines.join(' ').trim());
            if (body && !BOILERPLATE.test(body)) return body;
            continue;
        }
        return undefined;
    }
    return undefined;
}

function extractPyDocstring(source: string): string | undefined {
    let i = 0;
    if (source.startsWith('#!')) {
        const nl = source.indexOf('\n');
        i = nl < 0 ? source.length : nl + 1;
    }
    const comments: string[] = [];
    for (let guard = 0; guard < 64; guard++) {
        while (i < source.length && /\s/.test(source[i])) i++;
        if (source.startsWith('#', i)) {
            const nl = source.indexOf('\n', i);
            comments.push(source.slice(i + 1, nl < 0 ? source.length : nl).trim());
            i = nl < 0 ? source.length : nl + 1;
            continue;
        }
        break;
    }
    for (const quote of ['"""', "'''"]) {
        if (source.startsWith(quote, i)) {
            const end = source.indexOf(quote, i + 3);
            if (end < 0) break;
            const body = beforeTags(source.slice(i + 3, end).trim());
            if (body) return body;
        }
    }
    const joined = beforeTags(comments.join(' ').trim());
    return joined && !BOILERPLATE.test(joined) ? joined : undefined;
}

/** Leading JSDoc / block comment / Python module docstring, first sentence only. */
export function extractDocSummary(source: string, lang: SourceLang): string | undefined {
    try {
        if (!source) return undefined;
        const body = lang === 'py' ? extractPyDocstring(source) : extractJsDoc(source);
        if (!body) return undefined;
        const sentence = firstSentence(body);
        return sentence.length >= 12 ? sentence : undefined;
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Exported / top-level symbol extraction
// ---------------------------------------------------------------------------

const RE_JS_EXPORT_DECL = /^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;
const RE_JS_EXPORT_LIST = /^[ \t]*export\s*\{([^}]*)\}/gm;
const RE_JS_DEFAULT_ANON = /^[ \t]*export\s+default\s+(?:async\s+)?(?:function\s*\(|\(|class\s*\{)/m;
const RE_PY_DEF = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm;
const RE_PY_CLASS = /^class\s+([A-Za-z_]\w*)/gm;
const RE_PY_ALL = /^__all__\s*=\s*[\[(]([^\])]*)[\])]/m;

/** Top-level exported symbol names, in source order, deduped. */
export function extractExportedSymbols(source: string, lang: SourceLang): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (name: string) => {
        const n = name.trim();
        if (!n || seen.has(n) || n === 'default') return;
        seen.add(n);
        out.push(n);
    };
    try {
        if (!source) return out;
        if (lang === 'py') {
            const all = RE_PY_ALL.exec(source);
            if (all) {
                for (const raw of all[1].split(',')) push(raw.replace(/['"\s]/g, ''));
                if (out.length) return out;
            }
            let m: RegExpExecArray | null;
            RE_PY_CLASS.lastIndex = 0;
            while ((m = RE_PY_CLASS.exec(source))) push(m[1]);
            RE_PY_DEF.lastIndex = 0;
            while ((m = RE_PY_DEF.exec(source))) if (!m[1].startsWith('_')) push(m[1]);
            return out;
        }
        let m: RegExpExecArray | null;
        RE_JS_EXPORT_DECL.lastIndex = 0;
        while ((m = RE_JS_EXPORT_DECL.exec(source))) push(m[1]);
        RE_JS_EXPORT_LIST.lastIndex = 0;
        while ((m = RE_JS_EXPORT_LIST.exec(source))) {
            for (const part of m[1].split(',')) {
                const bits = part.replace(/\btype\b/g, '').trim().split(/\s+as\s+/);
                push((bits[1] ?? bits[0] ?? '').trim());
            }
        }
        if (RE_JS_DEFAULT_ANON.test(source)) push('default export');
        return out;
    } catch {
        return out;
    }
}

// ---------------------------------------------------------------------------
// Description composition
// ---------------------------------------------------------------------------

const LANG_NAME: Record<SourceLang, string> = {
    ts: 'TypeScript',
    js: 'JavaScript',
    py: 'Python',
    other: 'Source',
};

function formatSymbolList(symbols: string[]): string {
    const shown = symbols.slice(0, MAX_LISTED_SYMBOLS).map(s => `\`${s}\``).join(', ');
    const extra = symbols.length - MAX_LISTED_SYMBOLS;
    return extra > 0 ? `${shown} +${extra} more` : shown;
}

function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** One resolved import edge out of a file */
export interface FileImportDetail {
    /** Symbols pulled in. Empty means the whole module / a side-effect import. */
    symbols: string[];
    /** Display name of the imported file, e.g. `util.ts`. */
    from: string;
}

export interface FileDescriptionInput {
    fileName: string;
    lang: SourceLang;
    doc?: string;
    exportedSymbols: string[];
    imports: FileImportDetail[];
    importedByCount: number;
}

/**
 * Describe a file.
 *
 * Deliberately structured so the FIRST SENTENCE stands alone: the description
 * panel shows only up to the first full stop until it is expanded, so that
 * sentence has to be the useful one-liner. Everything after it is detail.
 *
 * Bare degree counts ("imports 7 modules") told the reader nothing actionable,
 * so the import side is enumerated in full: which symbols, from which file.
 */
export function describeFile(input: FileDescriptionInput): string {
    try {
        const lang = LANG_NAME[input.lang] ?? LANG_NAME.other;
        const parts: string[] = [];

        // Sentence 1 — the collapsed one-liner.
        if (input.doc) {
            parts.push(/[.!?]$/.test(input.doc) ? input.doc : `${input.doc}.`);
        } else {
            parts.push(input.exportedSymbols.length
                ? `${lang} module exporting ${formatSymbolList(input.exportedSymbols)}.`
                : `${lang} module with no top-level exports.`);
        }

        // The doc comment replaced the export summary above, so restate exports.
        if (input.doc && input.exportedSymbols.length) {
            parts.push(`Exports ${formatSymbolList(input.exportedSymbols)}.`);
        }

        if (input.importedByCount > 0) {
            parts.push(`Imported by ${plural(input.importedByCount, 'file')}.`);
        }

        if (input.imports.length) {
            const listed = input.imports.map((imp, i) => {
                const what = imp.symbols.length
                    ? imp.symbols.map(s => `\`${s}\``).join(', ')
                    : 'whole module';
                return `${i + 1}. ${what} from ${imp.from}`;
            });
            parts.push(`Imports: ${listed.join(', ')}.`);
        }

        // Not clamped: the full text is only ever revealed by expanding the
        // panel, and truncating it there would defeat the enumeration.
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    } catch {
        return `${input.fileName}`;
    }
}

export interface FolderDescriptionInput {
    folderName: string;
    /** Files sitting directly in this folder. */
    directFileCount: number;
    /** Folders sitting directly in this folder. */
    directSubfolderCount: number;
    /** Files anywhere beneath this folder, at any depth. */
    totalFileCount: number;
    langCounts: Partial<Record<SourceLang, number>>;
    externalInDegree: number;
    externalOutDegree: number;
}

/**
 * "mostly X" asserts a majority, so only say it when one language holds one.
 *
 * Ranking by plurality and calling the winner "mostly" overstates a near-even
 * split — a 34/33/33 tree is not "mostly" anything.
 */
function languagePhrase(langCounts: Partial<Record<SourceLang, number>>): string {
    const ranked = (Object.entries(langCounts) as Array<[SourceLang, number]>)
        .filter(([lang, n]) => n > 0 && lang !== 'other')
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
    if (!ranked.length) return '';

    const total = ranked.reduce((sum, [, n]) => sum + n, 0);
    const [topLang, topCount] = ranked[0];
    if (ranked.length === 1) return `, ${LANG_NAME[topLang]}`;
    if (topCount / total >= 0.6) return `, mostly ${LANG_NAME[topLang]}`;
    return `, mixed ${LANG_NAME[topLang]} and ${LANG_NAME[ranked[1][0]]}`;
}

/**
 * A one-line description of a folder.
 *
 * Counts are reported at a CONSISTENT depth: what you would see on expanding it
 * (direct children), with the deep total added only when nesting hides files.
 * Mixing a recursive file count with a direct subfolder count — as this did —
 * reads as a plain contradiction on any nested tree.
 */
export function describeFolder(input: FolderDescriptionInput): string {
    try {
        const parts: string[] = [];

        const counted: string[] = [];
        if (input.directFileCount > 0) counted.push(plural(input.directFileCount, 'file'));
        if (input.directSubfolderCount > 0) counted.push(plural(input.directSubfolderCount, 'subfolder'));
        const nested = input.totalFileCount > input.directFileCount
            ? ` (${input.totalFileCount} files in total)`
            : '';
        parts.push(counted.length
            ? `Contains ${counted.join(' and ')}${nested}${languagePhrase(input.langCounts)}.`
            : 'Empty folder.');

        // No "key exports" line: at folder level any ranking of a whole tree's
        // exports is a guess, and it pushed the genuinely useful counts out of
        // the collapsed one-liner.
        if (input.externalInDegree || input.externalOutDegree) {
            parts.push(`${plural(input.externalInDegree, 'incoming link')}, ${input.externalOutDegree} outgoing.`);
        }
        return clamp(parts.join(' '));
    } catch {
        return input.folderName;
    }
}
