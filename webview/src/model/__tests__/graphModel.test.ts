import { describe, expect, it } from 'vitest';
import {
    buildModel,
    expandWithAncestors,
    initialExpansion,
    projectGraph,
    unhideChain,
    type RawEdge,
    type RawNode,
} from '../graphModel';

function fixture(): { nodes: RawNode[]; edges: RawEdge[] } {
    return {
        nodes: [
            { id: 'root', label: 'ws', type: 'group', path: '/ws' },
            { id: 'a', label: 'a', type: 'group', path: '/ws/a', parentId: 'root' },
            { id: 'a1', label: 'a1.ts', type: 'file', path: '/ws/a/a1.ts', parentId: 'a' },
            { id: 'a2', label: 'a2.ts', type: 'file', path: '/ws/a/a2.ts', parentId: 'a' },
            { id: 'b', label: 'b', type: 'group', path: '/ws/b', parentId: 'root' },
            { id: 'b1', label: 'b1.ts', type: 'file', path: '/ws/b/b1.ts', parentId: 'b' },
        ],
        edges: [
            { id: 'e1', source: 'a1', target: 'b1' },
            { id: 'e2', source: 'a2', target: 'b1' },
            { id: 'e3', source: 'a1', target: 'a2' }, // internal to folder a
        ],
    };
}

describe('buildModel', () => {
    it('elides the single root wrapper from displayRoots', () => {
        const { nodes, edges } = fixture();
        const model = buildModel(nodes, edges);
        expect([...model.displayRoots].sort()).toEqual(['a', 'b']);
    });

    it('counts descendant files per folder', () => {
        const { nodes, edges } = fixture();
        const model = buildModel(nodes, edges);
        expect(model.nodes.get('a')!.fileCount).toBe(2);
        expect(model.nodes.get('b')!.fileCount).toBe(1);
    });
});

describe('projectGraph', () => {
    it('aggregates collapsed descendants onto the folder chip', () => {
        const { nodes, edges } = fixture();
        const model = buildModel(nodes, edges);
        const projection = projectGraph(model, new Set());
        expect(projection.nodes.map((n) => n.id).sort()).toEqual(['a', 'b']);
        const ab = projection.edges.find((e) => e.source === 'a' && e.target === 'b');
        expect(ab).toBeDefined();
        expect(ab!.relationships.length).toBe(2); // a1->b1 and a2->b1
        // The folder-internal edge must not survive as a self-loop.
        expect(projection.edges.some((e) => e.source === e.target)).toBe(false);
    });

    it('keeps every parent before its children', () => {
        const { nodes, edges } = fixture();
        const model = buildModel(nodes, edges);
        const projection = projectGraph(model, new Set(['a', 'b']));
        const index = new Map(projection.nodes.map((n, i) => [n.id, i]));
        for (const n of projection.nodes) {
            if (!n.parentId) continue;
            expect(index.get(n.parentId)!).toBeLessThan(index.get(n.id)!);
        }
    });

    it('drops hidden subtrees', () => {
        const { nodes, edges } = fixture();
        const model = buildModel(nodes, edges);
        const projection = projectGraph(model, new Set(['a', 'b']), new Set(['a']));
        expect(projection.nodes.some((n) => n.id === 'a' || n.id === 'a1' || n.id === 'a2')).toBe(false);
    });
});

describe('initialExpansion', () => {
    it('opens a view that has at least one edge', () => {
        const { nodes, edges } = fixture();
        const model = buildModel(nodes, edges);
        const projection = projectGraph(model, initialExpansion(model));
        expect(projection.edges.length).toBeGreaterThan(0);
    });
});

describe('reveal invariant', () => {
    it('every indexed node can be brought onto the canvas', () => {
        const { nodes, edges } = fixture();
        const model = buildModel(nodes, edges);
        for (const id of model.nodes.keys()) {
            const node = model.nodes.get(id)!;
            // The elided root wrapper is intentionally unreachable.
            if (!node.parentId && !model.displayRoots.includes(id)) continue;
            const expanded = node.parentId ? expandWithAncestors(model, new Set(), node.parentId) : new Set<string>();
            const hidden = unhideChain(model, new Set(['a', 'a1']), id);
            const projection = projectGraph(model, expanded, hidden);
            expect(projection.nodes.some((n) => n.id === id), `missing ${id}`).toBe(true);
        }
    });
});
