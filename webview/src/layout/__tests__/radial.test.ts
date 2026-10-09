import { describe, expect, it } from 'vitest';
import { radialEngine } from '../radial';

type Size = { w: number; h: number };

function context(ids: string[], edges: Array<[string, string]>, sizeOf?: (id: string) => Size) {
    const degree = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const [a, b] of edges) {
        degree.set(a, (degree.get(a) ?? 0) + 1);
        degree.set(b, (degree.get(b) ?? 0) + 1);
    }
    return {
        childIds: ids,
        sizeOf: sizeOf ?? (() => ({ w: 120, h: 80 })),
        edges,
        degreeOf: (id: string) => degree.get(id) ?? 0,
    };
}

function overlapPairs(pos: Map<string, { x: number; y: number }>, ids: string[], sizeOf: (id: string) => Size): string[] {
    const bad: string[] = [];
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = pos.get(ids[i])!;
            const b = pos.get(ids[j])!;
            const sa = sizeOf(ids[i]);
            const sb = sizeOf(ids[j]);
            if (a.x < b.x + sb.w && a.x + sa.w > b.x && a.y < b.y + sb.h && a.y + sa.h > b.y) {
                bad.push(`${ids[i]}/${ids[j]}`);
            }
        }
    }
    return bad;
}

describe('radialEngine', () => {
    it('packs all-orphan input without overlaps', () => {
        const ids = Array.from({ length: 12 }, (_, i) => `o${i}`);
        const pos = radialEngine(context(ids, []));
        expect(overlapPairs(pos, ids, () => ({ w: 120, h: 80 }))).toEqual([]);
    });

    it('keeps orphans strictly inside the innermost connected ring', () => {
        const connected = Array.from({ length: 6 }, (_, i) => `c${i}`);
        const orphans = Array.from({ length: 4 }, (_, i) => `o${i}`);
        const ids = [...connected, ...orphans];
        const edges: Array<[string, string]> = [
            ['c0', 'c1'], ['c1', 'c2'], ['c2', 'c3'], ['c3', 'c4'], ['c4', 'c5'],
        ];
        const pos = radialEngine(context(ids, edges));
        expect(overlapPairs(pos, ids, () => ({ w: 120, h: 80 }))).toEqual([]);

        // radialEngine normalizes min x/y to 0, so the pre-normalization origin
        // cannot be recovered from the bounds. The orphan block is centred on
        // that origin by construction, so its own bounding-box centre is it.
        const size = { w: 120, h: 80 };
        const orphanPos = orphans.map((id) => pos.get(id)!);
        const centreX = (Math.min(...orphanPos.map((p) => p.x)) + Math.max(...orphanPos.map((p) => p.x)) + size.w) / 2;
        const centreY = (Math.min(...orphanPos.map((p) => p.y)) + Math.max(...orphanPos.map((p) => p.y)) + size.h) / 2;
        const centreDistance = (id: string) => {
            const p = pos.get(id)!;
            return Math.hypot(p.x + size.w / 2 - centreX, p.y + size.h / 2 - centreY);
        };
        const maxOrphan = Math.max(...orphans.map(centreDistance));
        const minConnected = Math.min(...connected.map(centreDistance));
        expect(maxOrphan).toBeLessThan(minConnected);
    });

    it('separates varied node sizes', () => {
        const ids = ['big', 'tall', 'wide', 'small1', 'small2', 'small3'];
        const sizes: Record<string, Size> = {
            big: { w: 600, h: 420 },
            tall: { w: 160, h: 700 },
            wide: { w: 700, h: 140 },
            small1: { w: 90, h: 60 },
            small2: { w: 240, h: 180 },
            small3: { w: 120, h: 90 },
        };
        const sizeOf = (id: string) => sizes[id];
        const edges: Array<[string, string]> = [
            ['big', 'small1'], ['tall', 'small2'], ['wide', 'small3'], ['small1', 'small2'],
        ];
        const pos = radialEngine(context(ids, edges, sizeOf));
        expect(overlapPairs(pos, ids, sizeOf)).toEqual([]);
    });

    it('does not inflate into a single enormous ring', () => {
        const ids = Array.from({ length: 40 }, (_, i) => `n${i}`);
        const edges: Array<[string, string]> = ids.slice(1).map((id, i) => [ids[i], id]);
        const pos = radialEngine(context(ids, edges));
        const values = [...pos.values()];
        const width = Math.max(...values.map((p) => p.x)) - Math.min(...values.map((p) => p.x));
        const height = Math.max(...values.map((p) => p.y)) - Math.min(...values.map((p) => p.y));
        // A single ring holding all 40 nodes would need a radius of roughly
        // totalArc / 2pi ~= 1500; concentric rings keep this well under it.
        expect(Math.max(width, height)).toBeLessThan(2400);
    });
});
