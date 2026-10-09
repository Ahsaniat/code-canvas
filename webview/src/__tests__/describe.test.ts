import { describe, expect, it } from 'vitest';
import {
    describeFile,
    describeFolder,
    extractDocSummary,
    extractExportedSymbols,
} from '../../../extension/src/describe';

describe('extractDocSummary', () => {
    it('takes the first sentence of a leading JSDoc block', () => {
        const src = `/**\n * Resolve imports for one file. Handles aliases too.\n * @param x nope\n */\nexport const a = 1;`;
        expect(extractDocSummary(src, 'ts')).toBe('Resolve imports for one file.');
    });

    it('skips license boilerplate', () => {
        const src = `/* Copyright 2026 Someone. All rights reserved. */\nexport const a = 1;`;
        expect(extractDocSummary(src, 'ts')).toBeUndefined();
    });

    it('reads a Python module docstring', () => {
        const src = `"""Graph utilities. More detail follows.\n"""\nimport os`;
        expect(extractDocSummary(src, 'py')).toBe('Graph utilities.');
    });
});

describe('extractExportedSymbols', () => {
    it('captures declaration and list exports in source order', () => {
        const src = [
            `export function parse() {}`,
            `export const A = 1;`,
            `export { b as c };`,
            `export type T = string;`,
        ].join('\n');
        expect(extractExportedSymbols(src, 'ts')).toEqual(['parse', 'A', 'T', 'c']);
    });

    it('captures CommonJS object exports', () => {
        expect(extractExportedSymbols(`module.exports = { a, b: c };`, 'js')).toEqual(['a', 'b']);
    });
});

describe('describeFile', () => {
    it('prefers the doc comment and enumerates imports', () => {
        const text = describeFile({
            fileName: 'x.ts',
            lang: 'ts',
            doc: 'Does a thing',
            exportedSymbols: ['doThing'],
            imports: [{ symbols: ['helper'], from: 'util.ts' }],
            importedByCount: 2,
        });
        expect(text.startsWith('Does a thing.')).toBe(true);
        expect(text).toContain('Exports `doThing`');
        expect(text).toContain('Imported by 2 files');
        expect(text).toContain('`helper` from util.ts');
    });
});

describe('describeFolder', () => {
    it('reports direct counts and nesting', () => {
        const text = describeFolder({
            folderName: 'src',
            directFileCount: 2,
            directSubfolderCount: 1,
            totalFileCount: 7,
            langCounts: { ts: 7 },
            externalInDegree: 1,
            externalOutDegree: 2,
        });
        expect(text).toContain('2 files and 1 subfolder');
        expect(text).toContain('7 files in total');
        expect(text).toContain(', TypeScript.');
        expect(text).toContain('1 incoming link, 2 outgoing');
    });

    it('says "mostly" only for a real majority', () => {
        const mostly = describeFolder({
            folderName: 'src',
            directFileCount: 9,
            directSubfolderCount: 0,
            totalFileCount: 9,
            langCounts: { ts: 7, py: 2 },
            externalInDegree: 0,
            externalOutDegree: 0,
        });
        expect(mostly).toContain('mostly TypeScript');
    });
});
