/**
 * Layout orchestration.
 *
 * THE CONTAINER-OVERLAP ROOT CAUSE, AND WHY IT IS NOW IMPOSSIBLE
 * -------------------------------------------------------------
 * The previous ELK path fed ELK the *input* sizes of group nodes (an unmeasured
 * group was just the 480x280 default), let ELK space the siblings using those
 * numbers, and only afterwards recomputed each group's real size from its
 * children's bounding box. The recomputed size was almost always far larger than
 * what ELK had assumed, so the sibling spacing ELK had chosen was invalidated
 * and the enlarged containers stacked on top of each other.
 *
 * Every algorithm now goes through ONE pipeline, `layoutContainers`, which lays
 * containers out DEEPEST-FIRST. When a container is placed among its siblings,
 * the size used to space it is the size that was already computed from its own
 * laid-out children. There is no post-hoc resize step left in the codebase, so
 * "the size used for spacing" and "the size that gets rendered" are the same
 * number by construction — including for ELK, which now runs per container on a
 * flat graph instead of once over the whole hierarchy.
 */

import ELK from 'elkjs/lib/elk-api.js';
// Vite bundles the ELK worker inline (base64 blob) so it runs OFF the UI thread
// and loads under the webview CSP (worker-src blob:). See extension/media/index.html.
// @ts-ignore -- Vite worker import has no type declaration
import ElkWorker from 'elkjs/lib/elk-worker.min.js?worker&inline';
import dagre from 'dagre';
import { Node, Edge } from 'reactflow';
import { Box, Engine, EngineContext, Pt, normalize } from './layout/types';
import { radialEngine } from './layout/radial';

export type LayoutAlgo = 'radial' | 'elk' | 'dagre' | 'force';

/** Accepts the legacy 'custom' alias from older persisted state / commands. */
export function normalizeAlgo(value: string | undefined): LayoutAlgo {
    switch (value) {
        case 'elk': return 'elk';
        case 'dagre': return 'dagre';
        case 'force': return 'force';
        case 'radial':
        case 'custom':
        default: return 'radial';
    }
}

// Run ELK inside a Web Worker so elk.layout never blocks the main thread.
const elk = new ELK({ workerFactory: () => new ElkWorker() });

// A single source of truth for group geometry, shared by BOTH layout math and
// the rendered group style, so containers always fully wrap their children.
const GROUP_HEADER = 44; // top gutter reserving space for the folder label + chevron
const GROUP_PAD = 24;    // left / right / bottom padding inside a group
const DEFAULT_W = 480;
const DEFAULT_H = 280;
const MIN_GROUP_W = 240;
const MIN_GROUP_H = 180;

const elkLayeredOptions: Record<string, string> = {
    'elk.algorithm': 'layered',
    'elk.direction': 'RIGHT',
    'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    'elk.layered.nodeRanking.strategy': 'NETWORK_SIMPLEX',
    'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
    'elk.spacing.nodeNode': '120',
    'elk.layered.spacing.nodeNodeBetweenLayers': '160',
    'elk.spacing.componentComponent': '200',
};

// ---------------------------------------------------------------------------
// Shared hierarchy model
// ---------------------------------------------------------------------------

interface Hierarchy {
    parentOf: Map<string, string | undefined>;
    childrenOf: Map<string | undefined, string[]>; // undefined key == canvas root
    sizeOf: Map<string, Box>;
    typeOf: Map<string, string>;
    groupIdsDeepestFirst: string[];
}

function buildHierarchy(nodes: Node[]): Hierarchy {
    const parentOf = new Map<string, string | undefined>();
    const childrenOf = new Map<string | undefined, string[]>();
    const sizeOf = new Map<string, Box>();
    const typeOf = new Map<string, string>();

    for (const n of nodes) {
        const pid = (n as any).parentId as string | undefined;
        parentOf.set(n.id, pid);
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid)!.push(n.id);
        sizeOf.set(n.id, { w: (n as any).width ?? DEFAULT_W, h: (n as any).height ?? DEFAULT_H });
        typeOf.set(n.id, (n as any).type ?? 'file');
    }

    const depthOf = (id: string): number => {
        let d = 0;
        let cur = parentOf.get(id);
        let guard = 0;
        while (cur && guard++ < 10000) { d++; cur = parentOf.get(cur); }
        return d;
    };
    const groupIdsDeepestFirst = nodes
        .filter(n => typeOf.get(n.id) === 'group')
        .map(n => n.id)
        .sort((a, b) => depthOf(b) - depthOf(a));

    return { parentOf, childrenOf, sizeOf, typeOf, groupIdsDeepestFirst };
}

// Walk an endpoint up the parent chain to the direct child of `container`
// (undefined container == canvas root). Returns null when unrelated.
function toDirectChild(parentOf: Map<string, string | undefined>, container: string | undefined, id: string): string | null {
    let cur: string | undefined = id;
    let guard = 0;
    while (cur !== undefined && guard++ < 10000) {
        const p = parentOf.get(cur);
        if (p === container) return cur;
        cur = p;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Assemble the final React Flow node array.
//
// Child positions are relative to their parent (v11 requirement); top-level
// nodes are relative to the canvas. Style width/height is written for EVERY
// node from the exact same size source the layout used, so nothing can drift
// between what was spaced and what is painted.
// ---------------------------------------------------------------------------

function assemble(nodes: Node[], relPos: Map<string, Pt>, sizeOf: (id: string) => Box): Node[] {
    return nodes.map(node => {
        const pos = relPos.get(node.id) ?? { x: 0, y: 0 };
        const size = sizeOf(node.id);
        return {
            ...node,
            position: pos,
            style: { ...(node as any).style, width: size.w, height: size.h },
        } as Node;
    });
}

// ---------------------------------------------------------------------------
// The one pipeline
// ---------------------------------------------------------------------------

async function layoutContainers(nodes: Node[], edges: Edge[], engine: Engine): Promise<Node[]> {
    const h = buildHierarchy(nodes);
    const relPos = new Map<string, Pt>();
    const groupSize = new Map<string, Box>();

    // Deepest-first ordering means a group's size is already final by the time
    // its parent asks for it. This is the invariant that makes stacking impossible.
    const sizeForLayout = (id: string): Box => groupSize.get(id) ?? h.sizeOf.get(id) ?? { w: DEFAULT_W, h: DEFAULT_H };

    const layoutContainer = async (container: string | undefined) => {
        const childIds = h.childrenOf.get(container) ?? [];
        if (!childIds.length) {
            if (container) groupSize.set(container, { w: MIN_GROUP_W, h: MIN_GROUP_H });
            return;
        }
        const childSet = new Set(childIds);
        const { internal, degree } = analyseEdges(h, edges, container, childSet);

        let raw: Map<string, Pt>;
        try {
            raw = await engine({
                childIds,
                sizeOf: sizeForLayout,
                edges: internal,
                degreeOf: (id: string) => degree.get(id) ?? 0,
            });
        } catch (err) {
            console.warn('[code-canvas] layout engine failed for container', container, err);
            raw = gridFallback(childIds, sizeForLayout);
        }
        raw = enforceNoOverlap(childIds, raw, sizeForLayout);

        const offsetX = container ? GROUP_PAD : 0;
        const offsetY = container ? GROUP_HEADER : 0;
        let contentW = 0;
        let contentH = 0;
        for (const id of childIds) {
            const p = raw.get(id) ?? { x: 0, y: 0 };
            relPos.set(id, { x: p.x + offsetX, y: p.y + offsetY });
            const s = sizeForLayout(id);
            contentW = Math.max(contentW, p.x + s.w);
            contentH = Math.max(contentH, p.y + s.h);
        }
        if (container) {
            groupSize.set(container, {
                w: Math.max(MIN_GROUP_W, Math.ceil(contentW + 2 * GROUP_PAD)),
                h: Math.max(MIN_GROUP_H, Math.ceil(contentH + GROUP_HEADER + GROUP_PAD)),
            });
        }
    };

    for (const gid of h.groupIdsDeepestFirst) await layoutContainer(gid);
    await layoutContainer(undefined);

    return assemble(nodes, relPos, sizeForLayout);
}

/**
 * Project every edge onto this container's direct children.
 *
 * `internal` holds edges whose BOTH endpoints live in the container (what the
 * engine draws with). `degree` counts every connection a child has, including
 * links that leave the container — so a file whose only import points outside
 * its folder is correctly treated as connected, not as an orphan.
 */
function analyseEdges(
    h: Hierarchy,
    edges: Edge[],
    container: string | undefined,
    childIds: Set<string>
): { internal: Array<[string, string]>; degree: Map<string, number> } {
    const seen = new Set<string>();
    const internal: Array<[string, string]> = [];
    const degree = new Map<string, number>();
    const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);

    for (const e of edges) {
        const a = toDirectChild(h.parentOf, container, e.source);
        const b = toDirectChild(h.parentOf, container, e.target);
        const aIn = !!a && childIds.has(a);
        const bIn = !!b && childIds.has(b);
        if (!aIn && !bIn) continue;
        if (aIn && bIn) {
            if (a === b) continue; // internal to a single child; invisible here
            const key = `${a}->${b}`;
            if (!seen.has(key)) { seen.add(key); internal.push([a!, b!]); }
            bump(a!);
            bump(b!);
            continue;
        }
        bump((aIn ? a : b)!);
    }
    return { internal, degree };
}

const SEPARATION_GAP = 48;
const SEPARATION_ITERATIONS = 80;
const OVERLAP_CHECK_LIMIT = 320; // above this the O(n^2) audit is skipped

function rectsOverlap(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function hasOverlap(childIds: string[], pos: Map<string, Pt>, sizeOf: (id: string) => Box): boolean {
    for (let i = 0; i < childIds.length; i++) {
        const a = pos.get(childIds[i]);
        const sa = sizeOf(childIds[i]);
        if (!a) continue;
        for (let j = i + 1; j < childIds.length; j++) {
            const b = pos.get(childIds[j]);
            const sb = sizeOf(childIds[j]);
            if (!b) continue;
            if (rectsOverlap(a.x, a.y, sa.w, sa.h, b.x, b.y, sb.w, sb.h)) return true;
        }
    }
    return false;
}

/**
 * Guarantee requirement 1 ("containers must never overlap") at the pipeline
 * level rather than trusting each engine.
 *
 * Engines that reason about node sizes (radial, dagre, ELK) pass the audit
 * untouched, so this costs one O(n^2) scan and nothing else. An engine that
 * treats nodes as points — the force layout does — gets a deterministic
 * push-apart relaxation, and if that still cannot separate everything the
 * container falls back to a grid, which cannot overlap by construction.
 *
 * This runs BEFORE the container is sized, so it can never invalidate sibling
 * spacing the way the old post-hoc group resize did.
 */
function enforceNoOverlap(childIds: string[], raw: Map<string, Pt>, sizeOf: (id: string) => Box): Map<string, Pt> {
    if (childIds.length < 2 || childIds.length > OVERLAP_CHECK_LIMIT) return raw;
    if (!hasOverlap(childIds, raw, sizeOf)) return raw;

    const pos = new Map<string, Pt>();
    for (const [id, p] of raw) pos.set(id, { x: p.x, y: p.y });
    for (let iteration = 0; iteration < SEPARATION_ITERATIONS; iteration++) {
        let moved = false;
        for (let i = 0; i < childIds.length; i++) {
            const a = pos.get(childIds[i]);
            const sa = sizeOf(childIds[i]);
            if (!a) continue;
            for (let j = i + 1; j < childIds.length; j++) {
                const b = pos.get(childIds[j]);
                const sb = sizeOf(childIds[j]);
                if (!b) continue;
                const dx = (b.x + sb.w / 2) - (a.x + sa.w / 2);
                const dy = (b.y + sb.h / 2) - (a.y + sa.h / 2);
                const needX = (sa.w + sb.w) / 2 + SEPARATION_GAP - Math.abs(dx);
                const needY = (sa.h + sb.h) / 2 + SEPARATION_GAP - Math.abs(dy);
                if (needX <= 0 || needY <= 0) continue;
                // Push along the axis of least penetration; ties resolve on x so
                // the result stays deterministic.
                if (needX <= needY) {
                    const push = (needX / 2) * (dx === 0 ? 1 : Math.sign(dx) || 1);
                    a.x -= push; b.x += push;
                } else {
                    const push = (needY / 2) * (dy === 0 ? 1 : Math.sign(dy) || 1);
                    a.y -= push; b.y += push;
                }
                moved = true;
            }
        }
        if (!moved) break;
    }

    if (hasOverlap(childIds, pos, sizeOf)) {
        console.warn('[code-canvas] separation did not converge; using grid placement for this container');
        return gridFallback(childIds, sizeOf);
    }
    return normalize(pos);
}

/** Last-resort placement when an engine throws: a plain non-overlapping grid. */
function gridFallback(childIds: string[], sizeOf: (id: string) => Box): Map<string, Pt> {
    const cols = Math.max(1, Math.ceil(Math.sqrt(childIds.length)));
    let cellW = 0;
    let cellH = 0;
    for (const id of childIds) {
        const s = sizeOf(id);
        cellW = Math.max(cellW, s.w);
        cellH = Math.max(cellH, s.h);
    }
    const pos = new Map<string, Pt>();
    childIds.forEach((id, i) => {
        pos.set(id, { x: (i % cols) * (cellW + 60), y: Math.floor(i / cols) * (cellH + 60) });
    });
    return pos;
}

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

const dagreEngine: Engine = ({ childIds, sizeOf, edges }: EngineContext) => {
    const g = new (dagre as any).graphlib.Graph();
    g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 140, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const id of childIds) {
        const s = sizeOf(id);
        g.setNode(id, { width: s.w, height: s.h });
    }
    for (const [a, b] of edges) g.setEdge(a, b);
    (dagre as any).layout(g);

    const pos = new Map<string, Pt>();
    for (const id of childIds) {
        const n = g.node(id);
        const s = sizeOf(id);
        // dagre reports node centers; convert to top-left.
        pos.set(id, { x: (n?.x ?? 0) - s.w / 2, y: (n?.y ?? 0) - s.h / 2 });
    }
    return normalize(pos);
};

/**
 * ELK, run per container on a FLAT graph of that container's direct children.
 *
 * Running it flat (instead of once over the nested hierarchy) is what removes
 * the post-hoc resize: the sizes handed to ELK here are already final, so ELK's
 * sibling spacing stays valid.
 */
const elkEngine: Engine = async ({ childIds, sizeOf, edges }: EngineContext) => {
    const graph = {
        id: 'root',
        layoutOptions: elkLayeredOptions,
        children: childIds.map(id => {
            const s = sizeOf(id);
            return { id, width: s.w, height: s.h };
        }),
        edges: edges.map(([a, b], i) => ({ id: `e${i}`, sources: [a], targets: [b] })),
    };
    const laid: any = await elk.layout(graph as any);
    const pos = new Map<string, Pt>();
    for (const child of laid?.children ?? []) pos.set(child.id, { x: child.x ?? 0, y: child.y ?? 0 });
    for (const id of childIds) if (!pos.has(id)) pos.set(id, { x: 0, y: 0 });
    return normalize(pos);
};

// Deterministic force-directed layout for a small set of sibling boxes.
const forceEngine: Engine = ({ childIds, edges }: EngineContext) => {
    const n = childIds.length;
    const pos: Pt[] = [];
    // Deterministic seed on a grid so results are stable across runs.
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    for (let i = 0; i < n; i++) {
        pos.push({ x: (i % cols) * 600, y: Math.floor(i / cols) * 400 });
    }
    const index = new Map<string, number>(childIds.map((id, i) => [id, i]));
    const K = 500;        // ideal separation
    const iterations = n > 1 ? 250 : 0;
    for (let it = 0; it < iterations; it++) {
        const disp: Pt[] = pos.map(() => ({ x: 0, y: 0 }));
        // Repulsion between every pair.
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                let dx = pos[i].x - pos[j].x;
                let dy = pos[i].y - pos[j].y;
                const dist = Math.hypot(dx, dy) || 0.01;
                const rep = (K * K) / dist;
                dx /= dist; dy /= dist;
                disp[i].x += dx * rep; disp[i].y += dy * rep;
                disp[j].x -= dx * rep; disp[j].y -= dy * rep;
            }
        }
        // Attraction along edges.
        for (const [a, b] of edges) {
            const ia = index.get(a); const ib = index.get(b);
            if (ia == null || ib == null) continue;
            let dx = pos[ia].x - pos[ib].x;
            let dy = pos[ia].y - pos[ib].y;
            const dist = Math.hypot(dx, dy) || 0.01;
            const att = (dist * dist) / K;
            dx /= dist; dy /= dist;
            disp[ia].x -= dx * att; disp[ia].y -= dy * att;
            disp[ib].x += dx * att; disp[ib].y += dy * att;
        }
        const temp = K * (1 - it / iterations);
        for (let i = 0; i < n; i++) {
            const d = Math.hypot(disp[i].x, disp[i].y) || 0.01;
            pos[i].x += (disp[i].x / d) * Math.min(d, temp);
            pos[i].y += (disp[i].y / d) * Math.min(d, temp);
        }
    }
    const out = new Map<string, Pt>();
    childIds.forEach((id, i) => out.set(id, pos[i]));
    return normalize(out);
};

const ENGINES: Record<LayoutAlgo, Engine> = {
    radial: radialEngine,
    dagre: dagreEngine,
    force: forceEngine,
    elk: elkEngine,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getLayoutedElements(nodes: Node[], edges: Edge[], algo: LayoutAlgo = 'radial'): Promise<Node[]> {
    const engine = ENGINES[algo] ?? radialEngine;
    if (algo !== 'elk') return layoutContainers(nodes, edges, engine);
    try {
        return await layoutContainers(nodes, edges, engine);
    } catch (err) {
        // A restrictive host can block the ELK worker entirely; dagre keeps the
        // same nesting guarantees without leaving the main thread.
        console.warn('[code-canvas] ELK unavailable, falling back to dagre:', err);
        return layoutContainers(nodes, edges, dagreEngine);
    }
}
