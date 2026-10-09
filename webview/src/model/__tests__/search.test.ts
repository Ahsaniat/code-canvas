import { describe, expect, it } from 'vitest';
import { buildModel, expandWithAncestors, projectGraph, type RawEdge, type RawNode } from '../graphModel';
import { buildSearchIndex, matchedWithAncestors, parseQuery, searchNodes } from '../search';

function model() {
    const nodes: RawNode[] = [
        { id: 'root', label: 'ws', type: 'group', path: '/ws' },
        { id: 'src', label: 'src', type: 'group', path: '/ws/src', parentId: 'root' },
        { id: 'docs', label: 'docs', type: 'group', path: '/ws/docs', parentId: 'root' },
        { id: 'u', label: 'util.ts', type: 'file', path: '/ws/src/util.ts', parentId: 'src', symbols: ['parseThing'] },
        { id: 'g', label: 'graph.ts', type: 'file', path: '/ws/src/graph.ts', parentId: 'src', symbols: ['buildGraph'] },
        { id: 'n', label: 'notes.md', type: 'file', path: '/ws/docs/notes.md', parentId: 'docs' },
    ];
    const edges: RawEdge[] = [
        { id: 'e1', source: 'g', target: 'u', links: [{ symbolName: 'parseThing', targetLine: 1 }] },
    ];
    return buildModel(nodes, edges);
}

describe('parseQuery', () => {
    it('parses field qualifiers', () => {
        expect(parseQuery('name:index')).toMatchObject({ field: 'name', term: 'index' });
        expect(parseQuery('sym:useStore')).toMatchObject({ field: 'symbol', term: 'useStore' });
        expect(parseQuery('tag:api')).toMatchObject({ field: 'tag', term: 'api' });
        expect(parseQuery('path:src/')).toMatchObject({ field: 'path', term: 'src/' });
    });

    it('treats unknown prefixes as literal text', () => {
        const httpQuery = parseQuery('http://x');
        expect(httpQuery).toMatchObject({ term: 'http://x' });
        expect(httpQuery?.field).toBeUndefined();
    });

    it('returns null for empty input', () => {
        expect(parseQuery('   ')).toBeNull();
    });
});

describe('buildSearchIndex', () => {
    it('indexes from displayRoots down and excludes the elided wrapper', () => {
        const index = buildSearchIndex(model());
        const ids = index.entries.map((e) => e.id);
        expect(ids).not.toContain('root');
        expect(ids).toEqual(expect.arrayContaining(['src', 'docs', 'u', 'g', 'n']));
    });
});

describe('searchNodes', () => {
    it('ranks an exact name hit first', () => {
        const hits = searchNodes(buildSearchIndex(model()), 'graph.ts');
        expect(hits[0].id).toBe('g');
        expect(hits[0].field).toBe('name');
    });

    it('finds declared and consumer-observed symbols', () => {
        const index = buildSearchIndex(model());
        expect(searchNodes(index, 'parseThing')[0]).toMatchObject({ id: 'u', field: 'symbol' });
        expect(searchNodes(index, 'sym:buildGraph')[0]).toMatchObject({ id: 'g', field: 'symbol' });
    });

    it('matches paths and tags', () => {
        const index = buildSearchIndex(model());
        expect(searchNodes(index, 'path:notes')[0].id).toBe('n');
        const tagsOf = (p: string | undefined) => (p === '/ws/src/graph.ts' ? ['api'] : []);
        expect(searchNodes(index, 'tag:api', { tagsOf })[0]).toMatchObject({ id: 'g', field: 'tag' });
    });
});

describe('matchedWithAncestors', () => {
    it('keeps ancestors of a buried hit lit', () => {
        const m = model();
        const hits = searchNodes(buildSearchIndex(m), 'util.ts');
        const lit = matchedWithAncestors(m, hits);
        expect(lit.has('u')).toBe(true);
        expect(lit.has('src')).toBe(true);
    });
});

describe('reveal invariant', () => {
    it('every indexed entry projects after expanding its ancestors', () => {
        const m = model();
        const index = buildSearchIndex(m);
        for (const entry of index.entries) {
            const node = m.nodes.get(entry.id)!;
            const expanded = node.parentId ? expandWithAncestors(m, new Set(), node.parentId) : new Set<string>();
            const projection = projectGraph(m, expanded);
            expect(projection.nodes.some((n) => n.id === entry.id), `missing ${entry.label}`).toBe(true);
        }
    });
});
