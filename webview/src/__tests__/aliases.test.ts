import { describe, expect, it } from 'vitest';
import * as path from 'path';
import { aliasCandidates, parseAliasConfig, stripJsonComments } from '../../../extension/src/aliases';

describe('stripJsonComments', () => {
    it('removes comments but leaves string contents alone', () => {
        const src = `{
  // baseUrl below
  "baseUrl": "./src", /* block */
  "urls": ["http://x//y", "a/*b"]
}`;
        const parsed = JSON.parse(stripJsonComments(src));
        expect(parsed.baseUrl).toBe('./src');
        expect(parsed.urls).toEqual(['http://x//y', 'a/*b']);
    });
});

describe('parseAliasConfig', () => {
    it('parses baseUrl and paths out of JSONC', () => {
        const cfg = `{
            // a comment
            "compilerOptions": {
                "baseUrl": ".",
                "paths": { "@/*": ["src/*"], "~/*": ["src/*"] }
            }
        }`;
        const map = parseAliasConfig(cfg, '/proj')!;
        expect(map.baseUrl).toBe('/proj');
        expect(map.paths['@/*']).toEqual(['src/*']);
    });

    it('returns undefined when nothing is configured', () => {
        expect(parseAliasConfig('{"compilerOptions":{}}', '/proj')).toBeUndefined();
        expect(parseAliasConfig('not json', '/proj')).toBeUndefined();
    });
});

describe('aliasCandidates', () => {
    it('expands the longest matching pattern first', () => {
        const map = parseAliasConfig(
            '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"],"@/ui/*":["ui/*"]}}}',
            '/proj',
        )!;
        expect(aliasCandidates('@/ui/Button', map)).toEqual([
            path.resolve('/proj', 'ui/Button'),
            path.resolve('/proj', 'src/ui/Button'),
        ]);
    });

    it('resolves exact patterns', () => {
        const exact = parseAliasConfig(
            '{"compilerOptions":{"baseUrl":".","paths":{"config":["src/config.ts"]}}}',
            '/proj',
        )!;
        expect(aliasCandidates('config', exact)).toEqual([path.resolve('/proj', 'src/config.ts')]);
    });

    it('falls back to baseUrl for bare specifiers', () => {
        const base = parseAliasConfig('{"compilerOptions":{"baseUrl":"."}}', '/proj')!;
        expect(aliasCandidates('src/util', base)).toEqual([path.resolve('/proj', 'src/util')]);
    });

    it('ignores unrelated specifiers', () => {
        const map = parseAliasConfig('{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}', '/proj')!;
        expect(aliasCandidates('react', map)).toEqual([path.resolve('/proj', 'react')]);
    });
});
