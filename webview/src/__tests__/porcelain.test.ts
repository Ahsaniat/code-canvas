import { describe, expect, it } from 'vitest';
import { parsePorcelain } from '../../../extension/src/porcelain';

describe('parsePorcelain', () => {
    it('extracts modified and untracked paths', () => {
        expect(parsePorcelain(' M src/a.ts\n?? src/b.ts\n')).toEqual(['src/a.ts', 'src/b.ts']);
    });

    it('takes the new path from rename entries', () => {
        expect(parsePorcelain('R  old/name.ts -> new/name.ts\n')).toEqual(['new/name.ts']);
    });

    it('dedupes and tolerates empty output', () => {
        expect(parsePorcelain('')).toEqual([]);
        expect(parsePorcelain(' M a.ts\n M a.ts\n')).toEqual(['a.ts']);
    });
});
