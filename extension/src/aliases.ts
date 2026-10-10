/**
 * TypeScript `compilerOptions.paths` / `baseUrl` resolution.
 *
 * The indexer only ever resolved relative specifiers, so every project using
 * `@/components/...` rendered as disconnected islands. This module reads
 * `tsconfig.json` / `jsconfig.json` and turns a non-relative specifier into
 * candidate absolute bases (the caller probes extensions and index files).
 *
 * Kept free of `vscode` so it is directly testable.
 */

import * as fs from 'fs';
import * as path from 'path';

export type AliasMap = {
    /** Absolute directory non-relative specifiers fall back to. */
    baseUrl?: string;
    /** Pattern -> replacement paths, as written in the config. */
    paths: Record<string, string[]>;
};

/**
 * Strip `//` and block comments from JSONC while leaving string contents
 * alone. tsconfig files routinely carry comments, which JSON.parse rejects.
 */
export function stripJsonComments(text: string): string {
    let out = '';
    let inString = false;
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        const next = text[i + 1];
        if (inLine) {
            if (c === '\n') { inLine = false; out += c; }
            continue;
        }
        if (inBlock) {
            if (c === '*' && next === '/') { inBlock = false; i++; }
            continue;
        }
        if (inString) {
            out += c;
            if (c === '\\') { out += next ?? ''; i++; continue; }
            if (c === '"') inString = false;
            continue;
        }
        if (c === '"') { inString = true; out += c; continue; }
        if (c === '/' && next === '/') { inLine = true; i++; continue; }
        if (c === '/' && next === '*') { inBlock = true; i++; continue; }
        out += c;
    }
    return out;
}

/**
 * Parse tsconfig/jsconfig text. `configDir` is the directory the file lives in,
 * which `baseUrl` is relative to. Returns undefined when there is nothing to
 * resolve with (no baseUrl and no paths).
 */
export function parseAliasConfig(text: string, configDir: string): AliasMap | undefined {
    try {
        const parsed = JSON.parse(stripJsonComments(text)) as {
            compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
        };
        const co = parsed.compilerOptions;
        if (!co) return undefined;
        const paths = co.paths && typeof co.paths === 'object' ? co.paths : {};
        if (!co.baseUrl && !Object.keys(paths).length) return undefined;
        return {
            baseUrl: path.resolve(configDir, co.baseUrl ?? '.'),
            paths,
        };
    } catch {
        return undefined;
    }
}

/**
 * Absolute candidate bases for a non-relative specifier, without extension
 * probing. Longer (more specific) patterns are tried first, so `@/x/*` wins
 * over `@/*`. When nothing matches, `baseUrl` itself is the TS fallback.
 */
export function aliasCandidates(spec: string, aliases: AliasMap): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (p: string) => {
        if (!seen.has(p)) { seen.add(p); out.push(p); }
    };
    const baseUrl = aliases.baseUrl ?? '.';
    const entries = Object.entries(aliases.paths).sort((a, b) => b[0].length - a[0].length);
    for (const [pattern, targets] of entries) {
        const star = pattern.indexOf('*');
        if (star < 0) {
            if (spec === pattern) for (const t of targets) push(path.resolve(baseUrl, t));
            continue;
        }
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
        if (spec.length < prefix.length + suffix.length) continue;
        const middle = spec.slice(prefix.length, spec.length - suffix.length);
        for (const t of targets) push(path.resolve(baseUrl, t.replace('*', middle)));
    }
    if (!out.length && aliases.baseUrl) push(path.resolve(aliases.baseUrl, spec));
    return out;
}

/** Read `tsconfig.json` / `jsconfig.json` from the workspace root. */
export function loadAliases(root: string): AliasMap | undefined {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
        const p = path.join(root, name);
        try {
            if (!fs.existsSync(p)) continue;
            const map = parseAliasConfig(fs.readFileSync(p, 'utf8'), root);
            if (map) return map;
        } catch {
            // fall through to the next candidate
        }
    }
    return undefined;
}
