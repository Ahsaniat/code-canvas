import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, { Background, Controls, MarkerType, MiniMap, applyNodeChanges } from 'reactflow';
import 'reactflow/dist/style.css';
import { nodeTypes, CanvasContext, CanvasContextValue, FolderNodeData } from './nodeTypes';
import { edgeTypes } from './edges/CircuitEdge';
import { getLayoutedElements, LayoutAlgo, normalizeAlgo } from './layout';
import { hashRects, routeEdges, ROUTE_CHUNK_SIZE, type Rect } from './edges/route';
import {
    buildModel, projectGraph, initialExpansion, expandWithAncestors, collapseWithDescendants,
    type GraphModel, type ProjectedEdge, type ProjectedNode, type RawEdge, type RawNode,
} from './model/graphModel';
import { useMetaStore } from './store/metaStore';
import { TagFilterToolbar } from './components/TagFilterToolbar';
import { HoverOverlay, HoverOverlayHandle } from './components/HoverOverlay';

// VS Code webview API
declare global { interface Window { acquireVsCodeApi: any; __CODE_CACHE?: Record<string, string>; vscode?: any; } }
const vscode = window.vscode || (window.vscode = window.acquireVsCodeApi?.());

type Node = { id: string; type?: 'file' | 'folder' | 'group'; position: { x: number; y: number }; data: any; style?: any; dragHandle?: string; parentId?: string; width?: number; height?: number; extent?: any; zIndex?: number; className?: string };

// A collapsed folder is a fixed-size chip: deterministic geometry means the
// layout can space siblings using the exact size that will be painted.
const FOLDER_W = 320;
const FOLDER_H = 168;
const GROUP_SEED_W = 320;
const GROUP_SEED_H = 200;

// React Flow v11 REQUIRES every parent node to appear BEFORE its children in the
// nodes array, otherwise children detach / mis-position (P0-1). Sort by hierarchy
// depth (ascending) with a stable tiebreak so a parent always precedes its
// descendants regardless of the order we assembled the array in.
function orderNodesParentsFirst<T extends { id: string; parentId?: string }>(list: T[]): T[] {
    const byId = new Map(list.map(n => [n.id, n]));
    const depth = new Map<string, number>();
    const depthOf = (n: T, guard = 0): number => {
        const cached = depth.get(n.id);
        if (cached != null) return cached;
        if (guard > 10000) return 0;
        const parent = n.parentId ? byId.get(n.parentId) : undefined;
        const d = parent ? depthOf(parent, guard + 1) + 1 : 0;
        depth.set(n.id, d);
        return d;
    };
    return list
        .map((n, i) => ({ n, i, d: depthOf(n) }))
        .sort((a, b) => (a.d - b.d) || (a.i - b.i))
        .map(x => x.n);
}

// Convert a VS Code URI string (e.g. file:///home/foo.ts) to a filesystem path.
function uriToPath(uri: string): string {
    try {
        if (uri.startsWith('file://')) {
            let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
            if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1); // Windows: /c:/... -> c:/...
            return p;
        }
        return decodeURIComponent(uri);
    } catch {
        return uri;
    }
}

/**
 * Deterministic file-node geometry from its content.
 *
 * This is the ONLY size source for a file node. The previous build measured the
 * rendered code block and wrote the result back into the node's style, which
 * changed node sizes AFTER the layout had already spaced them — the same class
 * of bug as the container resize. Sizes are now a pure function of content, so
 * a layout pass is reproducible and never invalidates itself.
 */
function computeStyleFromContent(content: string) {
    const text = content || '';
    const lines = text.split('\n');
    const maxLen = lines.reduce((m, l) => Math.max(m, l.length), 0);
    const rawWidth = Math.max(480, Math.floor(maxLen * 7 + 40));
    const rawHeight = Math.max(200, lines.length * 14 + 30);
    return { width: Math.min(rawWidth, 1400), height: Math.min(rawHeight, 900) } as const;
}

/**
 * Absolute (canvas-space) rectangles for edge routing.
 *
 * React Flow child positions are relative to the parent, so offsets accumulate
 * down the tree. Containers are returned in `rectById` (edges may terminate on
 * one) but are excluded from `obstacles` — a container must be enterable, or no
 * route into an expanded folder could exist.
 */
function absoluteRects(nodes: Node[]): { rectById: Map<string, Rect>; obstacles: Rect[] } {
    const rectById = new Map<string, Rect>();
    const obstacles: Rect[] = [];
    for (const n of nodes) {
        const parent = n.parentId ? rectById.get(n.parentId) : undefined;
        const w = n.style?.width ?? (n.type === 'group' ? GROUP_SEED_W : FOLDER_W);
        const h = n.style?.height ?? (n.type === 'group' ? GROUP_SEED_H : FOLDER_H);
        const rect: Rect = {
            id: n.id,
            x: (parent?.x ?? 0) + (n.position?.x ?? 0),
            y: (parent?.y ?? 0) + (n.position?.y ?? 0),
            w, h,
        };
        rectById.set(n.id, rect);
        if (n.type !== 'group') obstacles.push(rect);
    }
    return { rectById, obstacles };
}

/**
 * Union two raw graphs by id, keeping the incoming definition on a collision.
 * Ordering does not matter here: `buildModel` derives the hierarchy from
 * `parentId`, and the parents-first requirement is enforced on the projection.
 */
function mergeGraphs(
    current: { nodes: RawNode[]; edges: RawEdge[] },
    incoming: { nodes?: RawNode[]; edges?: RawEdge[] } | undefined,
): { nodes: RawNode[]; edges: RawEdge[] } {
    if (!incoming?.nodes?.length && !incoming?.edges?.length) return current;
    const nodes = new Map(current.nodes.map(n => [n.id, n] as const));
    for (const n of incoming.nodes ?? []) nodes.set(n.id, n);
    const edges = new Map(current.edges.map(e => [e.id, e] as const));
    for (const e of incoming.edges ?? []) edges.set(e.id, e);
    return { nodes: Array.from(nodes.values()), edges: Array.from(edges.values()) };
}

type PersistedState = { expanded?: string[]; algo?: string; hidden?: string[] };

export default function App() {
    const persisted: PersistedState = (() => {
        try { return (vscode?.getState?.() as PersistedState) ?? {}; } catch { return {}; }
    })();

    const [graph, setGraph] = useState<{ nodes: RawNode[]; edges: RawEdge[] }>({ nodes: [], edges: [] });
    const [nodes, setNodes] = useState<Node[]>([]);
    const [edges, setEdges] = useState<any[]>([]);
    const nodesRef = useRef<Node[]>([]);
    const edgesRef = useRef<any[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [emptyMsg, setEmptyMsg] = useState<string | undefined>(undefined);
    const [progress, setProgress] = useState<string | undefined>(undefined);

    // Collapse-first view state: the canvas renders only what is expanded, which
    // is what removes the nested-container bugs and most of the render cost.
    // The OPENING depth is chosen per graph by `initialExpansion` — see the note
    // there on why "collapse everything" is the one default that cannot work.
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set(persisted.expanded ?? []));
    const hadPersistedExpansionRef = useRef((persisted.expanded ?? []).length > 0);
    const autoExpandedRef = useRef(false);
    const [hidden, setHidden] = useState<Set<string>>(() => new Set(persisted.hidden ?? []));

    const [algo, setAlgo] = useState<LayoutAlgo>(() => normalizeAlgo(persisted.algo));
    const algoRef = useRef<LayoutAlgo>(algo);
    useEffect(() => { algoRef.current = algo; }, [algo]);

    const [showRefs, setShowRefs] = useState(true);
    const [refResults, setRefResults] = useState<{ at: { path: string; line: number; character: number }; refs: { uri: string; range: { start: { line: number; character: number } } }[] } | null>(null);
    const wheelCleanupRef = useRef<(() => void) | null>(null);
    const [wrap, setWrap] = useState(false);
    const [showEdges, setShowEdges] = useState(true);
    const [focusIds, setFocusIds] = useState<Set<string> | null>(null);
    const rfInstanceRef = useRef<any | null>(null);
    const viewportRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
    const [zoomOk, setZoomOk] = useState<boolean>(true);
    const codeCacheRef = useRef<Record<string, string>>({});
    const overlayRef = useRef<HoverOverlayHandle | null>(null);
    const zoomSmoothTimerRef = useRef<number | null>(null);
    const moveSamplesRef = useRef<Array<{ t: number; x: number; y: number }>>([]);
    const isFlingingRef = useRef<boolean>(false);
    const flingRafRef = useRef<number | null>(null);
    const velocityRef = useRef<{ vx: number; vy: number }>({ vx: 0, vy: 0 });
    const lastInputRef = useRef<'wheel' | 'drag' | null>(null);
    const zoomActiveRef = useRef<boolean>(false);
    const lastZoomTimeRef = useRef<number>(0);
    const prevVpRef = useRef<{ x: number; y: number; zoom: number } | null>(null);
    const gestureZoomedRef = useRef<boolean>(false);
    const gesturePannedRef = useRef<boolean>(false);
    const wheelCooldownUntilRef = useRef<number>(0);
    const isDraggingViewRef = useRef<boolean>(false);
    const moveFrameRef = useRef<number | null>(null);
    const pendingVpRef = useRef<any | null>(null);

    const WHEEL_COOLDOWN_MS = 450;   // ~ matches your 420ms smooth class removal
    const ZOOM_EPS = 1e-4;           // minimal zoom delta treated as "zoom happened"

    // -----------------------------------------------------------------------
    // Model + projection
    // -----------------------------------------------------------------------

    const model: GraphModel = useMemo(() => buildModel(graph.nodes, graph.edges), [graph]);
    const modelRef = useRef<GraphModel>(model);
    useEffect(() => { modelRef.current = model; }, [model]);

    // Seed the opening view once, the first time a non-empty graph arrives, and
    // only when the user has no saved expansion of their own to restore.
    useEffect(() => {
        if (autoExpandedRef.current || !model.nodes.size) return;
        autoExpandedRef.current = true;
        if (hadPersistedExpansionRef.current) return;
        const seed = initialExpansion(model);
        if (seed.size) setExpanded(seed);
    }, [model]);

    const projection = useMemo(() => projectGraph(model, expanded, hidden), [model, expanded, hidden]);

    useEffect(() => {
        try { vscode?.setState?.({ expanded: Array.from(expanded), hidden: Array.from(hidden), algo }); } catch { }
    }, [expanded, hidden, algo]);

    // -----------------------------------------------------------------------
    // Viewport kinetics (unchanged behaviour)
    // -----------------------------------------------------------------------

    function cancelFling(): void {
        if (flingRafRef.current != null) {
            try { cancelAnimationFrame(flingRafRef.current); } catch { }
            flingRafRef.current = null;
        }
        isFlingingRef.current = false;
    }

    function startFling(initialVx: number, initialVy: number): void {
        cancelFling();
        isFlingingRef.current = true;
        velocityRef.current = { vx: initialVx, vy: initialVy };
        let last = performance.now();
        const damping = 3.0; // s^-1 exponential decay
        const stopThreshold = 30; // px/s
        const axisStopMin = 15; // px/s per-axis stop to avoid tiny oscillations
        const step = () => {
            if (!isFlingingRef.current) return;
            const now = performance.now();
            const dt = Math.max(0, (now - last) / 1000);
            last = now;
            const v = velocityRef.current;
            const decay = Math.exp(-damping * dt);
            const prevVx = v.vx; const prevVy = v.vy;
            v.vx *= decay; v.vy *= decay;
            if (Math.sign(prevVx) !== 0 && Math.sign(prevVx) !== Math.sign(v.vx)) v.vx = 0;
            if (Math.abs(v.vx) < axisStopMin) v.vx = 0;
            if (Math.sign(prevVy) !== 0 && Math.sign(prevVy) !== Math.sign(v.vy)) v.vy = 0;
            if (Math.abs(v.vy) < axisStopMin) v.vy = 0;
            const speed = Math.hypot(v.vx, v.vy);
            const vp = viewportRef.current;
            let nextX = vp.x + v.vx * dt;
            let nextY = vp.y + v.vy * dt;
            if (speed < 80) { nextX = Math.round(nextX); nextY = Math.round(nextY); }
            try { rfInstanceRef.current?.setViewport?.({ x: nextX, y: nextY, zoom: vp.zoom }); } catch { }
            viewportRef.current = { x: nextX, y: nextY, zoom: vp.zoom };
            if (speed < stopThreshold) { cancelFling(); return; }
            flingRafRef.current = requestAnimationFrame(step);
        };
        flingRafRef.current = requestAnimationFrame(step);
    }

    // -----------------------------------------------------------------------
    // Host messages
    // -----------------------------------------------------------------------

    useEffect(() => {
        vscode?.postMessage({ type: 'requestGraph' });
        vscode?.postMessage({ type: 'requestChanged' });
        const listener = (e: MessageEvent) => {
            const msg = e.data;
            if (msg.type === 'empty') setEmptyMsg(msg.reason === 'no-workspace'
                ? 'Open a folder to analyze your code.' : 'No JS/TS/Python files found.');
            else if (msg.type === 'progress') setProgress(msg.msg || undefined);
            else if (msg.type === 'graph') {
                setEmptyMsg(undefined);
                setProgress(undefined);
                setGraph({ nodes: msg.graph?.nodes ?? [], edges: msg.graph?.edges ?? [] });
            }
            else if (msg.type === 'expandResult') {
                // Expanding a file pulls MORE of the import graph in; it must add
                // to what is already on the canvas rather than replace it.
                setEmptyMsg(undefined);
                setProgress(undefined);
                setGraph(prev => mergeGraphs(prev, msg.graph));
            }
            else if (msg.type === 'changedFiles' || msg.type === 'openChanged') revealFiles(msg.files);
            else if (msg.type === 'gitChanged') revealFiles(msg.files || []);
            else if (msg.type === 'layout') {
                const next = normalizeAlgo(msg.algo);
                setAlgo(next);
                algoRef.current = next;
                void runLayout(next);
            } else if (msg.type === 'toggleRefs') setShowRefs(s => !s);
            else if (msg.type === 'toggleEdges') setShowEdges(s => !s);
            else if (msg.type === 'code') {
                codeCacheRef.current[msg.path] = msg.content || '';
                onCodeArrived([msg.path]);
            } else if (msg.type === 'codeMany') {
                const updated: string[] = [];
                for (const { path, content } of (msg.entries || [])) {
                    codeCacheRef.current[path] = content || '';
                    updated.push(path);
                }
                onCodeArrived(updated);
            } else if (msg.type === 'docChanged') {
                if (msg.file) refreshCode([msg.file]);
            } else if (msg.type === 'refs') {
                setRefResults({ at: msg.at, refs: msg.refs || [] });
            } else if (msg.type === 'metaLoaded') {
                useMetaStore.getState().hydrate(msg.payload);
            } else if (msg.type === 'autoDescriptions') {
                useMetaStore.getState().applyAutoDescriptions(msg.entries || {});
            }
        };
        window.addEventListener('message', listener);
        vscode?.postMessage({ type: 'requestMeta' });
        return () => window.removeEventListener('message', listener);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // P1-8: remove the wheel listener registered in onInit when the app unmounts.
    useEffect(() => () => {
        wheelCleanupRef.current?.();
        wheelCleanupRef.current = null;
        refineTokenRef.current++;
        cancelRefinement();
        cancelFling();
        if (layoutTimerRef.current != null) window.clearTimeout(layoutTimerRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // -----------------------------------------------------------------------
    // Projection -> React Flow
    // -----------------------------------------------------------------------

    const sizeOfProjected = useCallback((n: ProjectedNode) => {
        if (n.kind === 'file') return computeStyleFromContent(codeCacheRef.current[n.path ?? ''] || '');
        if (n.kind === 'folder') return { width: FOLDER_W, height: FOLDER_H };
        return { width: GROUP_SEED_W, height: GROUP_SEED_H };
    }, []);

    const toRfNode = useCallback((n: ProjectedNode, previous?: Node): Node => {
        const size = sizeOfProjected(n);
        const folderData: FolderNodeData = {
            label: n.label,
            path: n.path,
            fileCount: n.fileCount,
            inDegree: n.inDegree,
            outDegree: n.outDegree,
            expandable: n.expandable,
            expanded: n.kind === 'group',
        };
        return {
            id: n.id,
            type: n.kind,
            // Reuse the previous position so a collapse/expand does not visually
            // teleport everything before the new layout lands.
            position: previous?.position ?? { x: 0, y: 0 },
            parentId: n.parentId,
            extent: n.parentId ? 'parent' : undefined,
            dragHandle: n.kind === 'file' ? '.file-node-header, .node-placeholder-body' : undefined,
            data: n.kind === 'file'
                ? { label: n.label, path: n.path, lang: n.lang, width: size.width }
                : folderData,
            style: size,
            zIndex: n.kind === 'group' ? 0 : 1,
        };
    }, [sizeOfProjected]);

    const toRfEdge = useCallback((e: ProjectedEdge) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'circuit',
        data: {
            relationships: e.relationships,
            aggregated: !e.direct || e.relationships.length > 1,
            sourceLine: e.sourceLine,
            targetLine: e.targetLine,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: 'rgba(255,255,255,0.85)' },
        style: { stroke: 'rgba(255,255,255,0.55)', strokeWidth: 1.2 },
    }), []);

    useEffect(() => {
        const previousById = new Map(nodesRef.current.map(n => [n.id, n] as const));
        const rfNodes = orderNodesParentsFirst(projection.nodes.map(n => toRfNode(n, previousById.get(n.id))));
        const rfEdges = projection.edges.map(toRfEdge);
        nodesRef.current = rfNodes;
        edgesRef.current = rfEdges;
        setNodes(rfNodes);
        setEdges(rfEdges);
        requestCode(projection.visibleFilePaths);
        if (rfNodes.length) scheduleLayout(60);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [projection, toRfNode, toRfEdge]);

    useEffect(() => { nodesRef.current = nodes; }, [nodes]);
    useEffect(() => { edgesRef.current = edges; }, [edges]);

    // -----------------------------------------------------------------------
    // Code fetching — only for files actually on the canvas
    // -----------------------------------------------------------------------

    const pendingCodePathsRef = useRef<Set<string>>(new Set());

    function requestCode(paths: string[]) {
        const toRequest = (paths || []).filter(p => p && codeCacheRef.current[p] === undefined && !pendingCodePathsRef.current.has(p));
        if (!toRequest.length) return;
        toRequest.forEach(p => pendingCodePathsRef.current.add(p));
        vscode?.postMessage({ type: 'requestCodeMany', paths: toRequest });
    }

    function refreshCode(paths: string[]) {
        const present = new Set(nodesRef.current.filter(n => n.type === 'file').map(n => (n.data as any)?.path));
        const toRequest = (paths || []).filter(p => present.has(p));
        if (toRequest.length) vscode?.postMessage({ type: 'requestCodeMany', paths: toRequest });
    }

    function onCodeArrived(paths: string[]) {
        let any = false;
        for (const p of paths) if (pendingCodePathsRef.current.delete(p)) any = true;
        // File node sizes are derived from content, so a batch of arrivals means
        // the geometry changed: relayout once, debounced, never per file.
        if (any && pendingCodePathsRef.current.size === 0) {
            nodesRef.current = nodesRef.current.map(n => n.type === 'file'
                ? { ...n, style: computeStyleFromContent(codeCacheRef.current[(n.data as any).path] || '') }
                : n);
            setNodes(nodesRef.current);
            scheduleLayout(120);
        }
    }

    // -----------------------------------------------------------------------
    // Layout + routing
    // -----------------------------------------------------------------------

    const layoutTimerRef = useRef<number | null>(null);
    const layoutTokenRef = useRef(0);

    function scheduleLayout(delayMs = 150) {
        if (layoutTimerRef.current != null) window.clearTimeout(layoutTimerRef.current);
        layoutTimerRef.current = window.setTimeout(() => {
            layoutTimerRef.current = null;
            void runLayout();
        }, delayMs);
    }

    // Progressive routing. The synchronous slice is time-boxed so a big graph can
    // never stall a frame; whatever it had to skip is finished during idle time.
    const refineHandleRef = useRef<number | null>(null);
    const refineTokenRef = useRef(0);
    const MAX_REFINE_CHUNKS = 12;
    const REFINE_BUDGET_MS = 30;

    function cancelRefinement() {
        if (refineHandleRef.current == null) return;
        const cancel = (window as any).cancelIdleCallback ?? window.clearTimeout;
        try { cancel(refineHandleRef.current); } catch { }
        refineHandleRef.current = null;
    }

    function scheduleIdle(fn: () => void) {
        const request = (window as any).requestIdleCallback;
        refineHandleRef.current = request
            ? request(fn, { timeout: 400 })
            : window.setTimeout(fn, 32);
    }

    /**
     * Bake freshly computed circuit routes into the edge array.
     *
     * Never called from a render body — only after a layout settles or a node
     * drag ends, so routing cost is per-interaction, not per-frame.
     */
    function applyRoutes(nodeList: Node[], edgeList: any[]): any[] {
        cancelRefinement();
        if (!edgeList.length) return edgeList;
        try {
            const { rectById, obstacles } = absoluteRects(nodeList);
            const geometryHash = hashRects(obstacles);
            const inputs = edgeList.map(e => ({ id: e.id, source: e.source, target: e.target }));
            const { paths, degraded } = routeEdges(inputs, rectById, obstacles, geometryHash);
            const merged = mergeRoutes(edgeList, paths);

            if (degraded.length) {
                const token = ++refineTokenRef.current;
                const remaining = new Set(degraded);
                let chunk = 0;
                const step = () => {
                    refineHandleRef.current = null;
                    if (token !== refineTokenRef.current || !remaining.size || chunk++ >= MAX_REFINE_CHUNKS) return;
                    // Slice to ROUTE_CHUNK_SIZE: an oversized batch trips the
                    // router's cheap-only guard and could never upgrade.
                    const batch = inputs.filter(i => remaining.has(i.id)).slice(0, ROUTE_CHUNK_SIZE);
                    const result = routeEdges(batch, rectById, obstacles, geometryHash, REFINE_BUDGET_MS);
                    for (const i of batch) remaining.delete(i.id);
                    for (const id of result.degraded) remaining.add(id);
                    edgesRef.current = mergeRoutes(edgesRef.current, result.paths);
                    setEdges(edgesRef.current);
                    if (remaining.size) scheduleIdle(step);
                };
                scheduleIdle(step);
            }
            return merged;
        } catch (err) {
            console.warn('[code-canvas] edge routing failed, keeping previous paths:', err);
            return edgeList;
        }
    }

    /** Rebuild the edge array, reusing object identity wherever the path is unchanged. */
    function mergeRoutes(edgeList: any[], paths: Map<string, string>): any[] {
        let changed = false;
        const next = edgeList.map(e => {
            const d = paths.get(e.id);
            if (d === undefined || d === e.data?.d) return e;
            changed = true;
            return { ...e, data: { ...e.data, d } };
        });
        return changed ? next : edgeList;
    }

    async function runLayout(algoOverride?: LayoutAlgo) {
        const source = nodesRef.current;
        if (!source.length) return;
        const token = ++layoutTokenRef.current;
        const nodesToLayout = source.map(n => ({
            ...n,
            width: n.style?.width ?? FOLDER_W,
            height: n.style?.height ?? FOLDER_H,
        }));
        try {
            const layouted = await getLayoutedElements(nodesToLayout as any, edgesRef.current, algoOverride ?? algoRef.current);
            if (token !== layoutTokenRef.current) return; // superseded
            const ordered = orderNodesParentsFirst(layouted as any) as Node[];
            nodesRef.current = ordered;
            const routed = applyRoutes(ordered, edgesRef.current);
            edgesRef.current = routed;
            setNodes(ordered);
            setEdges(routed);
        } catch (error) {
            console.warn('[code-canvas] layout failed:', error);
        }
    }

    function rerouteFromCurrentPositions() {
        const routed = applyRoutes(nodesRef.current, edgesRef.current);
        if (routed !== edgesRef.current) {
            edgesRef.current = routed;
            setEdges(routed);
        }
    }

    /**
     * Drop the baked circuit geometry for the duration of a drag.
     *
     * `data.d` is a path frozen at the last routing pass, so while a node is
     * moving it describes where that node USED to be: the wire visibly detaches
     * and only snaps back on release. Clearing it makes CircuitEdge fall back to
     * React Flow's own path, which is recomputed from live node positions every
     * frame, so edges track the node as it moves. The circuit routes come back
     * via the reroute on drag stop.
     *
     * Routing itself is untouched — this only removes stale geometry, so the
     * "never route per frame" rule still holds.
     */
    function releaseBakedRoutes() {
        let changed = false;
        const next = edgesRef.current.map((e: any) => {
            if (!e.data?.d) return e;
            changed = true;
            return { ...e, data: { ...e.data, d: undefined } };
        });
        if (!changed) return;
        edgesRef.current = next;
        setEdges(next);
    }

    // -----------------------------------------------------------------------
    // Expansion
    // -----------------------------------------------------------------------

    const toggleFolder = useCallback((id: string) => {
        setExpanded(prev => prev.has(id)
            ? collapseWithDescendants(modelRef.current, prev, id)
            : expandWithAncestors(modelRef.current, prev, id));
    }, []);

    /**
     * `Expand (E)`: toggles the selected folders. A selected FILE still asks the
     * host to pull more of the import graph in, which is what E used to do.
     */
    function expandSelection() {
        const ids = selectedIds.length ? selectedIds : (nodesRef.current.filter((n: any) => n.selected).map((n: any) => n.id));
        if (!ids.length) return;
        const folderIds = ids.filter(id => modelRef.current.nodes.get(id)?.kind === 'folder');
        const fileIds = ids.filter(id => modelRef.current.nodes.get(id)?.kind === 'file');
        if (folderIds.length) {
            setExpanded(prev => {
                let next = prev;
                for (const id of folderIds) {
                    next = next.has(id)
                        ? collapseWithDescendants(modelRef.current, next, id)
                        : expandWithAncestors(modelRef.current, next, id);
                }
                return next;
            });
        }
        if (fileIds.length) vscode?.postMessage({ type: 'expand', ids: fileIds });
    }

    function expandAllTopLevel() {
        setExpanded(prev => {
            const next = new Set(prev);
            const roots = modelRef.current.displayRoots;
            const allOpen = roots.every(id => next.has(id) || modelRef.current.nodes.get(id)?.kind !== 'folder');
            for (const id of roots) {
                if (modelRef.current.nodes.get(id)?.kind !== 'folder') continue;
                if (allOpen) next.delete(id); else next.add(id);
            }
            return next;
        });
    }

    /** Surface files the host flagged (changed / git) by expanding their folders. */
    function revealFiles(paths: string[]) {
        if (!paths?.length) return;
        const currentModel = modelRef.current;
        const wanted = new Set(paths);
        setExpanded(prev => {
            let next = prev;
            for (const node of currentModel.nodes.values()) {
                if (node.kind !== 'file' || !node.path || !wanted.has(node.path)) continue;
                if (node.parentId) next = expandWithAncestors(currentModel, next, node.parentId);
            }
            return next;
        });
    }

    // -----------------------------------------------------------------------
    // Interaction
    // -----------------------------------------------------------------------

    const openFileByPath = useCallback((path: string) => { vscode?.postMessage({ type: 'openFile', path }); }, []);

    function handleTokenClick({ path, line, character }: any) {
        if (!showRefs) return;
        vscode?.postMessage({ type: 'requestRefs', path, line, character });
        vscode?.postMessage({ type: 'requestDefOpen', path, line, character });
        const base = nodesRef.current.find(n => (n.data as any)?.path === path);
        if (base) focusNodesForId(base.id);
    }
    const tokenClickRef = useRef(handleTokenClick);
    tokenClickRef.current = handleTokenClick;
    const onTokenClick = useCallback((payload: any) => tokenClickRef.current(payload), []);

    /** Focus = dim + edge filtering ONLY. Repositioning would break the layout. */
    function focusNodesForId(baseId: string) {
        const neighbours = new Set<string>([baseId]);
        for (const e of edgesRef.current) {
            if (e.source === baseId) neighbours.add(e.target);
            if (e.target === baseId) neighbours.add(e.source);
        }
        setFocusIds(neighbours);
    }

    function clearFocus() { setFocusIds(null); }

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
            if (e.key === 'e' || e.key === 'E') expandSelection();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedIds]);

    useEffect(() => {
        const down = (e: KeyboardEvent) => { if (e.code === 'Space') { try { rfInstanceRef.current?.setPaneDragging?.(true); } catch { } } };
        const up = (e: KeyboardEvent) => { if (e.code === 'Space') { try { rfInstanceRef.current?.setPaneDragging?.(false); } catch { } } };
        window.addEventListener('keydown', down);
        window.addEventListener('keyup', up);
        return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
    }, []);

    // Delete hides nodes from the projection (and with them their descendants),
    // rather than mutating the React Flow array, so the next re-projection does
    // not resurrect them.
    useEffect(() => {
        const onDelete = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
            if (e.key !== 'Delete' || !selectedIds.length) return;
            e.preventDefault();
            setHidden(prev => {
                const next = new Set(prev);
                for (const id of selectedIds) next.add(id);
                return next;
            });
            setSelectedIds([]);
        };
        window.addEventListener('keydown', onDelete);
        return () => window.removeEventListener('keydown', onDelete);
    }, [selectedIds]);

    const VISIBLE_ZOOM_THRESHOLD = 0.65; // below this, render placeholder

    const codeRefs = useRef<Record<string, React.RefObject<import('./code/CodeCard').CodeCardHandle>>>({});

    // Node hover deliberately shows NOTHING. A file's or folder's description is
    // already on the node itself, so a floating banner only repeated it while
    // covering whatever sat behind. Edges still get a tooltip — a wire has
    // nowhere to render its own symbol list.

    // Edge hover is throttled to one update per frame and goes
    // straight to the overlay ref — it never touches App state, so the canvas is
    // not re-rendered while the pointer tracks a wire.
    const edgeHoverFrameRef = useRef<number | null>(null);
    const pendingEdgeHoverRef = useRef<{ edge: any; x: number; y: number } | null>(null);

    function showEdgeTooltip(event: React.MouseEvent, edge: any) {
        pendingEdgeHoverRef.current = { edge, x: event.clientX, y: event.clientY };
        if (edgeHoverFrameRef.current != null) return;
        edgeHoverFrameRef.current = requestAnimationFrame(() => {
            edgeHoverFrameRef.current = null;
            const pending = pendingEdgeHoverRef.current;
            pendingEdgeHoverRef.current = null;
            if (!pending) return;
            const source = nodesRef.current.find(n => n.id === pending.edge.source);
            const target = nodesRef.current.find(n => n.id === pending.edge.target);
            overlayRef.current?.showEdge({
                sourceLabel: (source?.data as any)?.label ?? pending.edge.source,
                targetLabel: (target?.data as any)?.label ?? pending.edge.target,
                aggregated: !!pending.edge?.data?.aggregated,
                relationships: pending.edge?.data?.relationships ?? [],
                x: Math.round(pending.x + 16),
                y: Math.round(pending.y + 16),
            });
        });
    }

    function hideEdgeTooltip() {
        pendingEdgeHoverRef.current = null;
        if (edgeHoverFrameRef.current != null) {
            cancelAnimationFrame(edgeHoverFrameRef.current);
            edgeHoverFrameRef.current = null;
        }
        overlayRef.current?.showEdge(null);
    }

    const canvasCtx = useMemo<CanvasContextValue>(() => ({
        zoomOk, wrap,
        codeCacheRef, codeRefs,
        onTokenClick, onOpenFile: openFileByPath, onToggleFolder: toggleFolder,
    }), [zoomOk, wrap, onTokenClick, openFileByPath, toggleFolder]);

    // P1-2: selective store subscriptions rather than the whole store.
    const activeTagFilters = useMetaStore(s => s.activeTagFilters);
    const tagFilterMode = useMetaStore(s => s.tagFilterMode);
    const files = useMetaStore(s => s.files);

    const dimmedIds = useMemo(() => {
        if (activeTagFilters.length === 0) return new Set<string>();
        return new Set(
            nodes
                .filter((node: any) => {
                    const filePath = node.data?.path;
                    const tags = filePath ? (files[filePath]?.tags ?? []) : [];
                    if (tagFilterMode === 'OR') return !activeTagFilters.some((t) => tags.includes(t));
                    if (tagFilterMode === 'AND') return !activeTagFilters.every((t) => tags.includes(t));
                    return false;
                })
                .map((n: any) => n.id)
        );
    }, [nodes, activeTagFilters, tagFilterMode, files]);

    const displayNodes = useMemo(() => {
        const dimming = dimmedIds.size > 0 || !!focusIds;
        let base = nodes as any[];
        if (dimming) {
            base = base.map(n => {
                const dim = dimmedIds.has(n.id) || (focusIds ? !focusIds.has(n.id) : false);
                return dim === !!n.data.dim ? n : { ...n, data: { ...n.data, dim } };
            });
        }
        if (selectedIds.length === 0) return base;
        const selectedSet = new Set(selectedIds);
        const linked = new Set<string>(selectedSet);
        for (const e of edges as any[]) {
            if (selectedSet.has(e.source)) linked.add(e.target);
            if (selectedSet.has(e.target)) linked.add(e.source);
        }
        return base.map(n => linked.has(n.id)
            ? { ...n, className: `${n.className ? n.className + ' ' : ''}node-linked` }
            : n);
    }, [nodes, dimmedIds, selectedIds, edges, focusIds]);

    const displayEdges = useMemo(() => {
        if (!showEdges) return [];
        const base = focusIds
            ? (edges as any[]).filter(e => focusIds.has(e.source) && focusIds.has(e.target))
            : (edges as any[]);
        if (selectedIds.length === 0) return base;
        const selectedSet = new Set(selectedIds);
        return base.map(e => (selectedSet.has(e.source) || selectedSet.has(e.target))
            ? { ...e, className: `${e.className ? e.className + ' ' : ''}edge-linked` }
            : e);
    }, [edges, showEdges, focusIds, selectedIds]);

    const expandLabel = model.displayRoots.some(id => expanded.has(id)) ? 'Collapse All' : 'Expand All';

    return (
        <div className="root">
            <div className="toolbar">
                <TagFilterToolbar />
                <button onClick={() => runLayout()}>Relayout</button>
                <button onClick={expandAllTopLevel}>{expandLabel}</button>
                <button onClick={() => vscode?.postMessage({ type: 'loadMore' })}>Load 25 more</button>
                <button onClick={() => vscode?.postMessage({ type: 'requestChanged' })}>Open Changed (⇧O)</button>
                <button onClick={() => vscode?.postMessage({ type: 'requestGraph' })}>Reload</button>
                <button onClick={expandSelection}>Expand (E)</button>
                <button onClick={() => vscode?.postMessage({ type: 'toggleRefs' })}>Refs (R)</button>
                <button onClick={() => setWrap(w => !w)}>{wrap ? 'Unwrap' : 'Wrap'}</button>
                <button onClick={() => setShowEdges(s => !s)}>{showEdges ? 'Hide Edges' : 'Show Edges'}</button>
                <button onClick={() => vscode?.postMessage({ type: 'seedFolder' })}>Seed Folder…</button>
                <select
                    value={algo}
                    title="Layout algorithm"
                    onChange={(e) => { const a = normalizeAlgo(e.target.value); setAlgo(a); algoRef.current = a; void runLayout(a); }}
                >
                    <option value="radial">Radial (orphans centre)</option>
                    <option value="elk">ELK (layered)</option>
                    <option value="dagre">Dagre</option>
                    <option value="force">Force</option>
                </select>
                {hidden.size > 0 ? <button onClick={() => setHidden(new Set())}>Restore Hidden ({hidden.size})</button> : null}
                {focusIds ? (<button onClick={clearFocus}>Clear Focus</button>) : null}
            </div>
            <CanvasContext.Provider value={canvasCtx}>
                <ReactFlow
                    nodes={displayNodes as any}
                    edges={displayEdges as any}
                    nodeTypes={nodeTypes as any}
                    edgeTypes={edgeTypes as any}
                    panOnDrag={[1, 2]} /* left or middle mouse */
                    panOnScroll={true}
                    selectionOnDrag
                    /* Enter only, deliberately: re-anchoring on every move is what
                       made the banner appear to trail the pointer around a folder. */
                    onEdgeMouseEnter={(e, edge) => showEdgeTooltip(e as any, edge)}
                    onEdgeMouseMove={(e, edge) => showEdgeTooltip(e as any, edge)}
                    onEdgeMouseLeave={hideEdgeTooltip}
                    onlyRenderVisibleElements
                    onInit={(inst) => {
                        rfInstanceRef.current = inst;
                        try {
                            const vp = inst?.getViewport?.();
                            if (vp) {
                                setZoomOk(vp.zoom >= VISIBLE_ZOOM_THRESHOLD);
                                viewportRef.current = { x: vp.x, y: vp.y, zoom: vp.zoom };
                                prevVpRef.current = { x: vp.x, y: vp.y, zoom: vp.zoom };
                                try { document.documentElement.style.setProperty('--rf-zoom', String(vp.zoom)); } catch { }
                            }
                            const container = document.querySelector('.react-flow') as HTMLElement | null;
                            const onWheel = () => {
                                try {
                                    const now = performance.now();
                                    lastInputRef.current = 'wheel';
                                    lastZoomTimeRef.current = now;
                                    zoomActiveRef.current = true;
                                    gestureZoomedRef.current = true;
                                    wheelCooldownUntilRef.current = now + WHEEL_COOLDOWN_MS;

                                    const vpEl = document.querySelector('.react-flow__viewport');
                                    if (!vpEl) return;
                                    vpEl.classList.add('zoom-smooth');
                                    moveSamplesRef.current = [];
                                    if (zoomSmoothTimerRef.current) window.clearTimeout(zoomSmoothTimerRef.current);
                                    zoomSmoothTimerRef.current = window.setTimeout(() => {
                                        vpEl.classList.remove('zoom-smooth');
                                    }, 420);
                                } catch { }
                            };
                            container?.addEventListener('wheel', onWheel, { passive: true } as any);
                            wheelCleanupRef.current = () => container?.removeEventListener('wheel', onWheel as any);
                        } catch { }
                    }}
                    onNodeClick={() => setFocusIds(null)}
                    onNodeDoubleClick={(_e, node: any) => { if (node.type === 'folder' || node.type === 'group') toggleFolder(node.id); }}
                    onNodeDragStart={(_evt, node) => {
                        try {
                            document.querySelector(`.react-flow__node[data-id="${node.id}"]`)?.classList.add('no-animate');
                            document.querySelector('.react-flow__viewport')?.classList.remove('zoom-smooth');
                            isDraggingViewRef.current = true;
                            lastInputRef.current = 'drag';
                            cancelFling();
                            moveSamplesRef.current = [];
                        } catch { }
                        releaseBakedRoutes();
                    }}
                    onSelectionDragStart={() => releaseBakedRoutes()}
                    onSelectionDragStop={() => rerouteFromCurrentPositions()}
                    onNodeDragStop={(_evt, node) => {
                        try {
                            document.querySelector(`.react-flow__node[data-id="${node.id}"]`)?.classList.remove('no-animate');
                            isDraggingViewRef.current = false;
                        } catch { }
                        // Routing happens exactly once per drag, on release — never per frame.
                        rerouteFromCurrentPositions();
                    }}
                    onMoveStart={() => {
                        cancelFling();
                        moveSamplesRef.current = [];
                        gestureZoomedRef.current = false;
                        gesturePannedRef.current = false;
                        zoomActiveRef.current = false;
                        lastInputRef.current = 'drag';
                        isDraggingViewRef.current = true;
                        try { document.querySelector('.react-flow__viewport')?.classList.remove('zoom-smooth'); } catch { }
                    }}
                    onMove={(_evt, vp) => {
                        try {
                            if (!vp) return;
                            if (isFlingingRef.current) { viewportRef.current = { x: vp.x, y: vp.y, zoom: vp.zoom }; return; }

                            pendingVpRef.current = vp;
                            if (moveFrameRef.current != null) return;
                            moveFrameRef.current = window.requestAnimationFrame(() => {
                                moveFrameRef.current = null;
                                const latest = pendingVpRef.current; pendingVpRef.current = null;
                                if (!latest) return;

                                const now = performance.now();
                                const nextZoomOk = latest.zoom >= VISIBLE_ZOOM_THRESHOLD;
                                if (nextZoomOk !== zoomOk) setZoomOk(nextZoomOk);
                                try { document.documentElement.style.setProperty('--rf-zoom', String(latest.zoom)); } catch { }

                                const prev = prevVpRef.current ?? viewportRef.current;
                                const dz = latest.zoom - prev.zoom;

                                viewportRef.current = { x: latest.x, y: latest.y, zoom: latest.zoom };
                                prevVpRef.current = { x: latest.x, y: latest.y, zoom: latest.zoom };

                                if (Math.abs(dz) > ZOOM_EPS) {
                                    gestureZoomedRef.current = true;
                                    zoomActiveRef.current = true;
                                    lastInputRef.current = 'wheel';
                                    lastZoomTimeRef.current = now;
                                    moveSamplesRef.current = [];
                                    return;
                                }

                                if (lastInputRef.current === 'drag') {
                                    gesturePannedRef.current = true;
                                    moveSamplesRef.current.push({ t: now, x: latest.x, y: latest.y });
                                    const cutoff = now - 120;
                                    if (moveSamplesRef.current.length > 1) {
                                        let i = 0; while (i < moveSamplesRef.current.length && moveSamplesRef.current[i].t < cutoff) i++;
                                        if (i > 0) moveSamplesRef.current.splice(0, i);
                                    }
                                }
                            });
                        } catch { }
                    }}
                    onMoveEnd={() => {
                        try {
                            isDraggingViewRef.current = false;
                            const now = performance.now();
                            const inWheelCooldown = now < wheelCooldownUntilRef.current || (now - lastZoomTimeRef.current) < WHEEL_COOLDOWN_MS;
                            if (gestureZoomedRef.current || inWheelCooldown) {
                                cancelFling();
                                gestureZoomedRef.current = false;
                                gesturePannedRef.current = false;
                                zoomActiveRef.current = false;
                                moveSamplesRef.current = [];
                                return;
                            }
                            if (lastInputRef.current !== 'drag' || !gesturePannedRef.current) {
                                cancelFling();
                                gestureZoomedRef.current = false;
                                gesturePannedRef.current = false;
                                moveSamplesRef.current = [];
                                return;
                            }
                            const samples = moveSamplesRef.current;
                            if (!samples || samples.length < 2) {
                                cancelFling();
                                gestureZoomedRef.current = false;
                                gesturePannedRef.current = false;
                                return;
                            }
                            const first = samples[0];
                            const lastS = samples[samples.length - 1];
                            const dtMs = Math.max(1, lastS.t - first.t);
                            const minDurationMs = 90;
                            const minDistancePx = 40;
                            if (dtMs < minDurationMs || (Math.hypot(lastS.x - first.x, lastS.y - first.y) < minDistancePx)) {
                                cancelFling(); gestureZoomedRef.current = false; gesturePannedRef.current = false; return;
                            }
                            const vx = (lastS.x - first.x) / dtMs * 1000;
                            const vy = (lastS.y - first.y) / dtMs * 1000;
                            if (Math.hypot(vx, vy) >= 700) startFling(vx, vy); else cancelFling();
                            gestureZoomedRef.current = false;
                            gesturePannedRef.current = false;
                        } catch { }
                    }}
                    onEdgeClick={(_e, edge: any) => {
                        const sl = edge?.data?.sourceLine ?? 0;
                        const tl = edge?.data?.targetLine ?? 0;
                        try { codeRefs.current[edge.source]?.current?.highlight(sl); codeRefs.current[edge.source]?.current?.scrollTo(sl); } catch { }
                        try { codeRefs.current[edge.target]?.current?.highlight(tl); codeRefs.current[edge.target]?.current?.scrollTo(tl); } catch { }
                    }}
                    onNodesChange={(changes) => setNodes((nds: any) => applyNodeChanges(changes as any, nds as any) as any)}
                    onSelectionChange={(p: any) => {
                        const ids = (p?.nodes || []).map((n: any) => n.id);
                        setSelectedIds(ids);
                    }}
                    minZoom={0.02}
                    maxZoom={8}
                >
                    <Background />
                    <MiniMap pannable zoomable nodeStrokeColor={() => 'rgba(255,255,255,0.55)'} nodeColor={(n: any): string => (n.type === 'group' ? 'transparent' : 'rgba(255,255,255,0.35)')} />
                    <Controls />
                </ReactFlow>
            </CanvasContext.Provider>
            {refResults && (
                <div className="refs-panel">
                    <div className="refs-panel-header">
                        <span>References ({refResults.refs.length})</span>
                        <button onClick={() => setRefResults(null)} title="Close">×</button>
                    </div>
                    <div className="refs-panel-list">
                        {refResults.refs.length === 0 && <div className="refs-panel-empty">No references found.</div>}
                        {refResults.refs.map((r, i) => {
                            const p = uriToPath(r.uri);
                            const label = p.split(/[\\/]/).pop() || p;
                            const line = r.range?.start?.line ?? 0;
                            return (
                                <button
                                    key={`${r.uri}-${line}-${i}`}
                                    className="refs-panel-item"
                                    title={`${p}:${line + 1}`}
                                    onClick={() => vscode?.postMessage({ type: 'openFile', path: p, line })}
                                >
                                    {label}:{line + 1}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
            <HoverOverlay ref={overlayRef} />
            {progress && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none', fontSize: 14, opacity: .8 }}>⚙ {progress}</div>}
            {emptyMsg && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: 14, opacity: .8 }}>{emptyMsg}</div>}
        </div>
    );
}
