/**
 * Radial layout: orphans packed in the middle, everything else distributed
 * across CONCENTRIC RINGS growing outward from that middle.
 *
 * Rings, plural, is the point. Seating every connected node on one circle makes
 * the radius grow with the node COUNT (radius = totalArc / 2pi), which on a real
 * repo produces one enormous hoop with a small orphan block marooned at the
 * centre and a vast empty annulus in between. Instead each ring's radius is
 * fixed by the geometry immediately inside it, that radius sets a hard
 * circumference budget, and nodes that do not fit start the next ring further
 * out. The disc fills; it does not inflate.
 *
 * Non-overlap remains a property of the arithmetic, not of a post-pass:
 *
 *  - Each ring node is allocated an arc equal to its own diagonal plus a gap, so
 *    a ring only ever accepts nodes its circumference can actually seat at their
 *    true size. Because arc >= chord, a verification pass then grows the radius
 *    until the CHORD between neighbours also clears both diagonals. Only
 *    adjacent pairs need checking: angles are monotonic around the circle, so
 *    non-adjacent nodes are strictly farther apart.
 *
 *  - Ring k+1 starts at ring k's radius plus both rings' half-diagonals plus a
 *    gap, so consecutive rings cannot touch either.
 *
 *  - The orphan block is packed FIRST and sets the innermost ring's floor, so no
 *    ring can cut into the middle.
 *
 * Radii are therefore dynamically responsive to content: expanding a folder
 * grows its box, which grows its arc allocation and its ring's half-diagonal
 * clearance, which pushes every ring outside it outward by exactly as much as it
 * needs and no more.
 *
 * Using the node DIAGONAL (rather than width or height) makes the guarantee hold
 * at every angle without having to special-case the ring's tangent direction.
 */

import { Box, EngineContext, Pt, normalize } from './types';

const RING_GAP = 90;         // clear space between neighbouring ring nodes
const ORPHAN_GAP = 48;       // clear space between orphans in the centre block
const MIN_RADIUS = 260;
// Rotating each successive ring by an irrational-ish fraction of a turn keeps
// nodes on different rings from lining up into radial spokes.
const RING_PHASE = 0.6180339887;
const REFINEMENT_SWEEPS = 2; // barycentre + swap passes; enough, and bounded
const MAX_SWAP_NODES = 240;  // above this the swap refinement is skipped

const diagonalOf = (b: Box): number => Math.hypot(b.w, b.h);

/**
 * Pack orphans into a compact grid centred on the origin.
 *
 * Uniform cells (max width x max height) make non-overlap trivially true; the
 * column count is chosen so the block is roughly square in PIXELS, not in cell
 * counts, which keeps the middle from becoming a long thin strip.
 */
function packOrphans(ids: string[], sizeOf: (id: string) => Box): { pos: Map<string, Pt>; w: number; h: number } {
    const pos = new Map<string, Pt>();
    if (!ids.length) return { pos, w: 0, h: 0 };

    let cellW = 0;
    let cellH = 0;
    for (const id of ids) {
        const s = sizeOf(id);
        cellW = Math.max(cellW, s.w);
        cellH = Math.max(cellH, s.h);
    }
    cellW += ORPHAN_GAP;
    cellH += ORPHAN_GAP;

    const cols = Math.min(ids.length, Math.max(1, Math.round(Math.sqrt((ids.length * cellH) / cellW))));
    const rows = Math.ceil(ids.length / cols);
    const blockW = cols * cellW - ORPHAN_GAP;
    const blockH = rows * cellH - ORPHAN_GAP;

    ids.forEach((id, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const s = sizeOf(id);
        pos.set(id, {
            x: -blockW / 2 + col * cellW + (cellW - ORPHAN_GAP - s.w) / 2,
            y: -blockH / 2 + row * cellH + (cellH - ORPHAN_GAP - s.h) / 2,
        });
    });

    return { pos, w: blockW, h: blockH };
}

/** Adjacency restricted to the ring members. */
function buildAdjacency(ring: string[], edges: Array<[string, string]>): Map<string, string[]> {
    const inRing = new Set(ring);
    const adj = new Map<string, Set<string>>(ring.map(id => [id, new Set<string>()]));
    for (const [a, b] of edges) {
        if (a === b || !inRing.has(a) || !inRing.has(b)) continue;
        adj.get(a)!.add(b);
        adj.get(b)!.add(a);
    }
    return new Map(Array.from(adj, ([id, set]) => [id, Array.from(set).sort()]));
}

/**
 * Seed the ring order so connected components sit contiguously (a component
 * split across the circle guarantees long crossing chords).
 */
function seedOrder(ring: string[], adj: Map<string, string[]>): string[] {
    const remaining = new Set(ring);
    const components: string[][] = [];
    for (const start of ring) {
        if (!remaining.has(start)) continue;
        const component: string[] = [];
        const stack = [start];
        remaining.delete(start);
        while (stack.length) {
            const id = stack.pop()!;
            component.push(id);
            for (const n of adj.get(id) ?? []) {
                if (remaining.delete(n)) stack.push(n);
            }
        }
        components.push(component);
    }
    components.sort((a, b) => b.length - a.length);
    return components.flat();
}

/** Angles derived purely from arc allocation, so they are radius-independent. */
function anglesFor(order: string[], arcOf: (id: string) => number): number[] {
    const total = order.reduce((sum, id) => sum + arcOf(id), 0) || 1;
    const angles: number[] = [];
    let cursor = 0;
    for (const id of order) {
        const arc = arcOf(id);
        angles.push(((cursor + arc / 2) / total) * Math.PI * 2);
        cursor += arc;
    }
    return angles;
}

const circularDelta = (a: number, b: number): number => {
    const d = Math.abs(a - b) % (Math.PI * 2);
    return d > Math.PI ? Math.PI * 2 - d : d;
};

/**
 * Reduce crossings with a barycentre sweep followed by an adjacent-swap sweep.
 *
 * Swapping two ADJACENT ring positions leaves every other node's angle
 * untouched (the pair's combined arc is unchanged, so the cumulative arc after
 * them is identical). The swap test therefore only has to re-score the edges
 * incident to those two nodes — O(degree), not O(edges) — which keeps the whole
 * refinement linear-ish rather than quadratic.
 */
function refineOrder(
    order: string[],
    adj: Map<string, string[]>,
    hasEdges: boolean,
    arcOf: (id: string) => number
): string[] {
    let current = order;
    const total = current.reduce((sum, id) => sum + arcOf(id), 0) || 1;
    const toAngle = (arcPosition: number) => (arcPosition / total) * Math.PI * 2;

    for (let sweep = 0; sweep < REFINEMENT_SWEEPS; sweep++) {
        // -- barycentre: move each node towards the circular mean of its neighbours
        const angles = anglesFor(current, arcOf);
        const indexOf = new Map(current.map((id, i) => [id, i] as const));
        const scored = current.map((id, i) => {
            let sx = 0;
            let sy = 0;
            let n = 0;
            for (const nb of adj.get(id) ?? []) {
                const j = indexOf.get(nb);
                if (j == null) continue;
                sx += Math.cos(angles[j]);
                sy += Math.sin(angles[j]);
                n++;
            }
            const key = n > 0 && (sx !== 0 || sy !== 0)
                ? (Math.atan2(sy, sx) + Math.PI * 2) % (Math.PI * 2)
                : angles[i];
            return { id, key, i };
        });
        scored.sort((a, b) => (a.key - b.key) || (a.i - b.i));
        current = scored.map(s => s.id);

        if (!hasEdges || current.length > MAX_SWAP_NODES || current.length < 3) continue;

        // -- adjacent swaps that strictly reduce the span of incident edges
        const prefix = new Array<number>(current.length + 1).fill(0);
        for (let i = 0; i < current.length; i++) prefix[i + 1] = prefix[i] + arcOf(current[i]);
        const angleOf = new Map<string, number>();
        for (let i = 0; i < current.length; i++) angleOf.set(current[i], toAngle(prefix[i] + arcOf(current[i]) / 2));

        for (let pass = 0; pass < 2; pass++) {
            let improved = false;
            for (let i = 0; i + 1 < current.length; i++) {
                const first = current[i];
                const second = current[i + 1];
                const arcFirst = arcOf(first);
                const arcSecond = arcOf(second);
                const base = prefix[i];
                const swapped = new Map<string, number>([
                    [second, toAngle(base + arcSecond / 2)],
                    [first, toAngle(base + arcSecond + arcFirst / 2)],
                ]);

                let before = 0;
                let after = 0;
                const counted = new Set<string>();
                for (const node of [first, second]) {
                    for (const neighbour of adj.get(node) ?? []) {
                        const key = node < neighbour ? `${node}|${neighbour}` : `${neighbour}|${node}`;
                        if (counted.has(key)) continue;
                        counted.add(key);
                        const na = angleOf.get(node)!;
                        const nb = angleOf.get(neighbour);
                        if (nb == null) continue;
                        before += circularDelta(na, nb);
                        after += circularDelta(swapped.get(node) ?? na, swapped.get(neighbour) ?? nb);
                    }
                }

                if (after < before - 1e-9) {
                    current[i] = second;
                    current[i + 1] = first;
                    prefix[i + 1] = base + arcSecond;
                    angleOf.set(second, swapped.get(second)!);
                    angleOf.set(first, swapped.get(first)!);
                    improved = true;
                }
            }
            if (!improved) break;
        }
    }

    return current;
}

interface Ring {
    ids: string[];
    radius: number;
    /** Largest node diagonal seated on this ring; drives clearance to the next. */
    maxDiagonal: number;
}

/**
 * Deal `order` into concentric rings, innermost first.
 *
 * A ring's radius is fixed by what sits immediately inside it (`innerFloor`)
 * plus its own widest node — crucially NOT by how many nodes it holds. That
 * makes `2 * pi * radius` a genuine capacity: once the accumulated arc would
 * exceed it, the ring closes and the next one starts further out. At least one
 * node is always seated per ring, so an oversized node cannot stall the loop.
 */
function assignRings(
    order: string[],
    arcOf: (id: string) => number,
    diagonalOf_: (id: string) => number,
    innerFloor: number
): Ring[] {
    const rings: Ring[] = [];
    let cursor = 0;
    let floor = innerFloor;

    while (cursor < order.length) {
        const ids: string[] = [];
        let arcSum = 0;
        let maxDiagonal = 0;
        let radius = MIN_RADIUS;

        while (cursor < order.length) {
            const id = order[cursor];
            const arc = arcOf(id);
            const candidateMaxDiagonal = Math.max(maxDiagonal, diagonalOf_(id));
            const candidateRadius = Math.max(MIN_RADIUS, floor + candidateMaxDiagonal / 2);
            // Capacity is independent of arcSum, so this is a real constraint.
            if (ids.length > 0 && arcSum + arc > 2 * Math.PI * candidateRadius) break;
            ids.push(id);
            arcSum += arc;
            maxDiagonal = candidateMaxDiagonal;
            radius = candidateRadius;
            cursor++;
        }

        rings.push({ ids, radius, maxDiagonal });
        floor = radius + maxDiagonal / 2 + RING_GAP;
    }

    return rings;
}

/**
 * Grow a ring's radius until every ADJACENT chord clears both node diagonals.
 * Angles are radius-independent, so this converges in very few passes.
 */
function clearChords(ids: string[], angles: number[], diagonals: number[], radius: number): number {
    if (ids.length < 2) return radius;
    let out = radius;
    for (let pass = 0; pass < 4; pass++) {
        let worst = 1;
        for (let i = 0; i < ids.length; i++) {
            const j = (i + 1) % ids.length;
            if (i === j) continue;
            const required = (diagonals[i] + diagonals[j]) / 2 + RING_GAP;
            const chord = 2 * out * Math.sin(circularDelta(angles[i], angles[j]) / 2);
            if (chord > 1e-6) worst = Math.max(worst, required / chord);
        }
        if (worst <= 1 + 1e-6) break;
        out *= worst * 1.02;
    }
    return out;
}

export function radialEngine({ childIds, sizeOf, edges, degreeOf }: EngineContext): Map<string, Pt> {
    if (!childIds.length) return new Map();

    const connected: string[] = [];
    const orphans: string[] = [];
    for (const id of childIds) (degreeOf(id) > 0 ? connected : orphans).push(id);

    const orphanBlock = packOrphans(orphans, sizeOf);

    if (!connected.length) return normalize(orphanBlock.pos);
    if (connected.length === 1 && !orphans.length) {
        return normalize(new Map([[connected[0], { x: 0, y: 0 }]]));
    }

    const arcOf = (id: string) => diagonalOf(sizeOf(id)) + RING_GAP;
    const adjacency = buildAdjacency(connected, edges);
    const hasInternalEdges = Array.from(adjacency.values()).some(list => list.length > 0);
    const order = refineOrder(seedOrder(connected, adjacency), adjacency, hasInternalEdges, arcOf);

    // The orphan block owns the middle; the innermost ring starts outside it.
    const orphanCircumradius = Math.hypot(orphanBlock.w, orphanBlock.h) / 2;
    const innerFloor = orphans.length ? orphanCircumradius + RING_GAP : 0;

    const rings = assignRings(order, arcOf, id => diagonalOf(sizeOf(id)), innerFloor);

    const pos = new Map<string, Pt>(orphanBlock.pos);
    let floor = innerFloor;

    rings.forEach((ring, ringIndex) => {
        const angles = anglesFor(ring.ids, arcOf);
        const diagonals = ring.ids.map(id => diagonalOf(sizeOf(id)));

        // Re-floor against the ring that actually landed inside this one, then
        // let the chord check grow it further if neighbours are still too close.
        const radius = clearChords(
            ring.ids,
            angles,
            diagonals,
            Math.max(ring.radius, MIN_RADIUS, floor + ring.maxDiagonal / 2)
        );

        const phase = ringIndex * RING_PHASE * Math.PI * 2;
        ring.ids.forEach((id, i) => {
            const s = sizeOf(id);
            const angle = angles[i] + phase;
            pos.set(id, {
                x: radius * Math.cos(angle) - s.w / 2,
                y: radius * Math.sin(angle) - s.h / 2,
            });
        });

        floor = radius + ring.maxDiagonal / 2 + RING_GAP;
    });

    return normalize(pos);
}
