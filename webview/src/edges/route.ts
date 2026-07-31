/**
 * Circuit-style orthogonal edge routing.
 *
 * Routes are right-angle polylines that go AROUND node boxes, like PCB traces.
 * The algorithm is a Hanan grid + A*:
 *
 *  1. Obstacles (leaf nodes only — containers must be enterable) are inflated by
 *     a clearance margin. The x coordinates of every inflated left/right edge,
 *     plus the two endpoints, form the grid's vertical lines; the y coordinates
 *     of every inflated top/bottom edge form the horizontal lines. An optimal
 *     rectilinear path avoiding rectangles always exists on that grid, so this
 *     loses nothing versus a continuous search while being finite and small.
 *  2. A* runs over grid intersections with the search state carrying the axis of
 *     the last move, which is what lets a turn penalty be charged. The heuristic
 *     is Manhattan distance (admissible for rectilinear movement).
 *  3. The polyline is simplified and emitted with small rounded corners.
 *
 * PERFORMANCE IS A HARD REQUIREMENT, so everything is capped and memoized:
 *  - only edges currently on screen are ever passed in;
 *  - obstacles are limited to those near the edge, MAX_OBSTACLES of them;
 *  - the grid is capped at MAX_GRID_LINES per axis;
 *  - A* aborts after MAX_EXPANSIONS;
 *  - the synchronous slice stops after TIME_BUDGET_MS and reports what it had to
 *    skip, so the caller can finish those during idle time;
 *  - anything that trips a cap degrades to a cheap orthogonal Z route, which is
 *    still right-angled, just not obstacle-aware;
 *  - results are cached under a hash of the participating geometry, so an
 *    unchanged layout re-uses the previous path array wholesale.
 *
 * Nothing here may be called from a component's render body.
 */

export interface Rect {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
}

export interface RouteInput {
    id: string;
    source: string;
    target: string;
}

const CLEARANCE = 26;        // keep traces this far off a node box
const STUB = 22;             // straight stub leaving a node before the first turn
const TURN_PENALTY = 260;    // cost of a bend; high => few, long, clean runs
const CORNER_RADIUS = 9;

const MAX_ROUTED_EDGES = 160;
/**
 * Largest batch that attempts real routing. A caller refining skipped edges must
 * slice its work to this size, otherwise an oversized batch keeps tripping the
 * `cheapOnly` guard and can never upgrade.
 */
export const ROUTE_CHUNK_SIZE = MAX_ROUTED_EDGES;
const MAX_OBSTACLES = 56;
const MAX_GRID_LINES = 28;   // per axis => <= 784 grid points
const MAX_EXPANSIONS = 4200;
const TIME_BUDGET_MS = 18;   // synchronous slice; the rest is finished during idle time

const ROUTE_CACHE = new Map<string, string>();
const ROUTE_CACHE_LIMIT = 4000;

type Side = 'left' | 'right' | 'top' | 'bottom';
type Pt = { x: number; y: number };

// ---------------------------------------------------------------------------
// Anchors
// ---------------------------------------------------------------------------

/** Pick the pair of box sides that face each other. */
function pickSides(a: Rect, b: Rect): { from: Side; to: Side } {
    const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
    const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx >= 0 ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
    }
    return dy >= 0 ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
}

function anchorOf(r: Rect, side: Side): Pt {
    switch (side) {
        case 'left': return { x: r.x, y: r.y + r.h / 2 };
        case 'right': return { x: r.x + r.w, y: r.y + r.h / 2 };
        case 'top': return { x: r.x + r.w / 2, y: r.y };
        case 'bottom': return { x: r.x + r.w / 2, y: r.y + r.h };
    }
}

function stubOf(p: Pt, side: Side, distance: number): Pt {
    switch (side) {
        case 'left': return { x: p.x - distance, y: p.y };
        case 'right': return { x: p.x + distance, y: p.y };
        case 'top': return { x: p.x, y: p.y - distance };
        case 'bottom': return { x: p.x, y: p.y + distance };
    }
}

// ---------------------------------------------------------------------------
// Fallback route (always right-angled)
// ---------------------------------------------------------------------------

function zRoute(a: Rect, b: Rect): Pt[] {
    const { from, to } = pickSides(a, b);
    const start = anchorOf(a, from);
    const end = anchorOf(b, to);
    const s = stubOf(start, from, STUB);
    const e = stubOf(end, to, STUB);
    if (from === 'left' || from === 'right') {
        const mid = (s.x + e.x) / 2;
        return [start, s, { x: mid, y: s.y }, { x: mid, y: e.y }, e, end];
    }
    const mid = (s.y + e.y) / 2;
    return [start, s, { x: s.x, y: mid }, { x: e.x, y: mid }, e, end];
}

/** True when no segment of the polyline enters an inflated obstacle. */
function polylineClear(points: Pt[], obstacles: Rect[]): boolean {
    for (let i = 0; i + 1 < points.length; i++) {
        const p = points[i];
        const q = points[i + 1];
        const loX = Math.min(p.x, q.x);
        const hiX = Math.max(p.x, q.x);
        const loY = Math.min(p.y, q.y);
        const hiY = Math.max(p.y, q.y);
        for (const o of obstacles) {
            if (hiX > o.x - CLEARANCE && loX < o.x + o.w + CLEARANCE &&
                hiY > o.y - CLEARANCE && loY < o.y + o.h + CLEARANCE) return false;
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const EPS = 0.5;

/** First index with arr[i] > value, or arr.length. */
function firstGreater(arr: number[], value: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] > value) hi = mid; else lo = mid + 1;
    }
    return lo;
}

/** Last index with arr[i] < value, or -1. */
function lastLess(arr: number[], value: number): number {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid] < value) lo = mid + 1; else hi = mid;
    }
    return lo - 1;
}

interface Blocking {
    /** Grid intersection lies inside an inflated obstacle. */
    cell: Uint8Array;
    /** Segment (cx,cy)->(cx+1,cy) is blocked. */
    horizontal: Uint8Array;
    /** Segment (cx,cy)->(cx,cy+1) is blocked. */
    vertical: Uint8Array;
}

/**
 * Precompute blocked cells and blocked grid segments by RANGE MARKING.
 *
 * The obvious implementation tests every grid point (and every candidate step)
 * against every obstacle, which is O(cells x obstacles) and was slow enough to
 * exhaust the routing time budget on a mid-size graph — pushing most edges onto
 * the non-avoiding fallback. Each obstacle instead binary-searches the band of
 * grid lines it actually covers and marks only those, so the setup scales with
 * real coverage rather than with the whole grid.
 */
function buildBlocking(xs: number[], ys: number[], obstacles: Rect[]): Blocking {
    const nx = xs.length;
    const ny = ys.length;
    const cell = new Uint8Array(nx * ny);
    const horizontal = new Uint8Array(nx * ny);
    const vertical = new Uint8Array(nx * ny);

    for (const o of obstacles) {
        const left = o.x - CLEARANCE + EPS;
        const right = o.x + o.w + CLEARANCE - EPS;
        const top = o.y - CLEARANCE + EPS;
        const bottom = o.y + o.h + CLEARANCE - EPS;

        // Grid lines strictly inside the inflated rectangle.
        const cxLo = firstGreater(xs, left);
        const cxHi = lastLess(xs, right);
        const cyLo = firstGreater(ys, top);
        const cyHi = lastLess(ys, bottom);

        for (let cy = cyLo; cy <= cyHi; cy++) {
            const row = cy * nx;
            for (let cx = cxLo; cx <= cxHi; cx++) cell[row + cx] = 1;
        }

        // A horizontal step [xs[cx], xs[cx+1]] at height ys[cy] is blocked when
        // that height is inside the band and the span overlaps it.
        const hxLo = Math.max(0, firstGreater(xs, left) - 1);
        const hxHi = Math.min(nx - 2, lastLess(xs, right));
        for (let cy = cyLo; cy <= cyHi; cy++) {
            const row = cy * nx;
            for (let cx = hxLo; cx <= hxHi; cx++) horizontal[row + cx] = 1;
        }

        const vyLo = Math.max(0, firstGreater(ys, top) - 1);
        const vyHi = Math.min(ny - 2, lastLess(ys, bottom));
        for (let cy = vyLo; cy <= vyHi; cy++) {
            const row = cy * nx;
            for (let cx = cxLo; cx <= cxHi; cx++) vertical[row + cx] = 1;
        }
    }

    return { cell, horizontal, vertical };
}

/** Keep the `limit` values closest to the span, always retaining `required`. */
function capCoordinates(values: number[], required: number[], center: number, limit: number): number[] {
    const unique = Array.from(new Set(values.map(v => Math.round(v)))).sort((a, b) => a - b);
    if (unique.length <= limit) return unique;
    const requiredSet = new Set(required.map(v => Math.round(v)));
    const optional = unique.filter(v => !requiredSet.has(v))
        .sort((a, b) => Math.abs(a - center) - Math.abs(b - center))
        .slice(0, Math.max(0, limit - requiredSet.size));
    return Array.from(new Set([...requiredSet, ...optional])).sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Binary heap keyed on f-score
// ---------------------------------------------------------------------------

class MinHeap {
    private keys: number[] = [];
    private values: number[] = [];

    get size(): number { return this.keys.length; }

    push(key: number, value: number): void {
        this.keys.push(key);
        this.values.push(value);
        let i = this.keys.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.keys[parent] <= this.keys[i]) break;
            this.swap(parent, i);
            i = parent;
        }
    }

    pop(): number | undefined {
        if (!this.keys.length) return undefined;
        const top = this.values[0];
        const lastKey = this.keys.pop()!;
        const lastValue = this.values.pop()!;
        if (this.keys.length) {
            this.keys[0] = lastKey;
            this.values[0] = lastValue;
            let i = 0;
            for (;;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let smallest = i;
                if (l < this.keys.length && this.keys[l] < this.keys[smallest]) smallest = l;
                if (r < this.keys.length && this.keys[r] < this.keys[smallest]) smallest = r;
                if (smallest === i) break;
                this.swap(smallest, i);
                i = smallest;
            }
        }
        return top;
    }

    private swap(a: number, b: number): void {
        [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
        [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
    }
}

// ---------------------------------------------------------------------------
// A* over the Hanan grid
// ---------------------------------------------------------------------------

const AXIS_H = 0;
const AXIS_V = 1;

function astar(xs: number[], ys: number[], obstacles: Rect[], start: Pt, goal: Pt): Pt[] | null {
    const nx = xs.length;
    const ny = ys.length;
    const xi = xs.indexOf(Math.round(start.x));
    const yi = ys.indexOf(Math.round(start.y));
    const gx = xs.indexOf(Math.round(goal.x));
    const gy = ys.indexOf(Math.round(goal.y));
    if (xi < 0 || yi < 0 || gx < 0 || gy < 0) return null;

    const cells = nx * ny;
    const stateCount = cells * 2;
    const gScore = new Float64Array(stateCount).fill(Infinity);
    const cameFrom = new Int32Array(stateCount).fill(-1);
    const closed = new Uint8Array(stateCount);

    const cellIndex = (cx: number, cy: number) => cy * nx + cx;
    const stateIndex = (cx: number, cy: number, axis: number) => cellIndex(cx, cy) * 2 + axis;

    /**
     * Turn-aware Manhattan heuristic.
     *
     * A plain Manhattan estimate ignores TURN_PENALTY, which dominates the cost
     * function; that made the heuristic so loose that A* degenerated towards
     * Dijkstra and exhausted the batch time budget. Counting the turns that are
     * PROVABLY still required keeps the estimate admissible while pruning hard:
     * needing both axes forces at least one bend, and being aligned on the wrong
     * axis forces exactly one.
     */
    const heuristic = (cx: number, cy: number, axis: number): number => {
        const dx = Math.abs(xs[cx] - xs[gx]);
        const dy = Math.abs(ys[cy] - ys[gy]);
        let turns = 0;
        if (dx > 0 && dy > 0) turns = 1;
        else if (dx > 0) turns = axis === AXIS_H ? 0 : 1;
        else if (dy > 0) turns = axis === AXIS_V ? 0 : 1;
        return dx + dy + turns * TURN_PENALTY;
    };

    // A grid point inside an obstacle is unusable, except the two endpoints,
    // which sit on their own node's stub and are always legal.
    const { cell: blocked, horizontal, vertical } = buildBlocking(xs, ys, obstacles);
    blocked[cellIndex(xi, yi)] = 0;
    blocked[cellIndex(gx, gy)] = 0;

    const open = new MinHeap();
    for (const axis of [AXIS_H, AXIS_V]) {
        const s = stateIndex(xi, yi, axis);
        gScore[s] = 0;
        open.push(heuristic(xi, yi, axis), s);
    }

    let expansions = 0;
    let goalState = -1;
    while (open.size) {
        const state = open.pop()!;
        if (closed[state]) continue;
        closed[state] = 1;
        if (++expansions > MAX_EXPANSIONS) return null;

        const cell = state >> 1;
        const cx = cell % nx;
        const cy = (cell - cx) / nx;
        if (cx === gx && cy === gy) { goalState = state; break; }

        const axis = state & 1;
        // [dx, dy, axis, index of the segment that would be traversed]
        const neighbours: Array<[number, number, number, number]> = [
            [cx - 1, cy, AXIS_H, cx > 0 ? cellIndex(cx - 1, cy) : -1],
            [cx + 1, cy, AXIS_H, cellIndex(cx, cy)],
            [cx, cy - 1, AXIS_V, cy > 0 ? cellIndex(cx, cy - 1) : -1],
            [cx, cy + 1, AXIS_V, cellIndex(cx, cy)],
        ];
        for (const [ax, ay, nextAxis, segment] of neighbours) {
            if (ax < 0 || ay < 0 || ax >= nx || ay >= ny || segment < 0) continue;
            if (blocked[cellIndex(ax, ay)]) continue;
            if ((nextAxis === AXIS_H ? horizontal : vertical)[segment]) continue;
            const step = Math.abs(xs[ax] - xs[cx]) + Math.abs(ys[ay] - ys[cy]);
            const cost = gScore[state] + step + (nextAxis === axis ? 0 : TURN_PENALTY);
            const next = stateIndex(ax, ay, nextAxis);
            if (cost >= gScore[next]) continue;
            gScore[next] = cost;
            cameFrom[next] = state;
            open.push(cost + heuristic(ax, ay, nextAxis), next);
        }
    }

    if (goalState < 0) return null;

    const path: Pt[] = [];
    let cur = goalState;
    let guard = 0;
    while (cur >= 0 && guard++ < stateCount) {
        const cell = cur >> 1;
        const cx = cell % nx;
        const cy = (cell - cx) / nx;
        path.push({ x: xs[cx], y: ys[cy] });
        cur = cameFrom[cur];
    }
    return path.reverse();
}

// ---------------------------------------------------------------------------
// Polyline -> SVG
// ---------------------------------------------------------------------------

function simplify(points: Pt[]): Pt[] {
    const out: Pt[] = [];
    for (const p of points) {
        const last = out[out.length - 1];
        if (last && Math.abs(last.x - p.x) < 0.01 && Math.abs(last.y - p.y) < 0.01) continue;
        if (out.length >= 2) {
            const a = out[out.length - 2];
            const b = out[out.length - 1];
            const collinearX = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01;
            const collinearY = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01;
            if (collinearX || collinearY) { out[out.length - 1] = p; continue; }
        }
        out.push(p);
    }
    return out;
}

function toSvgPath(rawPoints: Pt[]): string {
    const points = simplify(rawPoints);
    if (points.length < 2) return '';
    const round = (n: number) => Math.round(n * 10) / 10;
    let d = `M ${round(points[0].x)},${round(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i++) {
        const prev = points[i - 1];
        const cur = points[i];
        const next = points[i + 1];
        const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y);
        const outLen = Math.hypot(next.x - cur.x, next.y - cur.y);
        const r = Math.min(CORNER_RADIUS, inLen / 2, outLen / 2);
        if (r < 1) { d += ` L ${round(cur.x)},${round(cur.y)}`; continue; }
        const enter = {
            x: cur.x - Math.sign(cur.x - prev.x) * r,
            y: cur.y - Math.sign(cur.y - prev.y) * r,
        };
        const exit = {
            x: cur.x + Math.sign(next.x - cur.x) * r,
            y: cur.y + Math.sign(next.y - cur.y) * r,
        };
        d += ` L ${round(enter.x)},${round(enter.y)} Q ${round(cur.x)},${round(cur.y)} ${round(exit.x)},${round(exit.y)}`;
    }
    const last = points[points.length - 1];
    d += ` L ${round(last.x)},${round(last.y)}`;
    return d;
}

// ---------------------------------------------------------------------------
// Batch entry point
// ---------------------------------------------------------------------------

function cacheKey(geometryHash: string, a: Rect, b: Rect): string {
    return `${geometryHash}|${a.id}:${Math.round(a.x)},${Math.round(a.y)},${a.w},${a.h}|${b.id}:${Math.round(b.x)},${Math.round(b.y)},${b.w},${b.h}`;
}

/** Cheap order-independent hash of the obstacle field. */
export function hashRects(rects: Rect[]): string {
    let h = 2166136261 >>> 0;
    for (const r of rects) {
        const s = `${r.id}:${Math.round(r.x)}:${Math.round(r.y)}:${Math.round(r.w)}:${Math.round(r.h)}`;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
    }
    return `${rects.length}_${h.toString(36)}`;
}

export interface RouteResult {
    paths: Map<string, string>;
    /**
     * Edges that ran out of time budget and got the cheap non-avoiding route.
     * The caller can re-submit just these during idle time to upgrade them.
     */
    degraded: string[];
}

/**
 * Route a batch of edges. `obstacles` must contain only LEAF rectangles —
 * containers are pass-through, otherwise no path into an expanded folder exists.
 *
 * The time budget bounds the SYNCHRONOUS cost so a large graph can never stall
 * the frame. Whatever it cuts is reported in `degraded`, and only full-quality
 * results are cached, so a follow-up idle pass can finish the job without the
 * cache handing back the placeholder.
 */
export function routeEdges(
    edges: RouteInput[],
    rectById: Map<string, Rect>,
    obstacles: Rect[],
    geometryHash: string,
    budgetMs: number = TIME_BUDGET_MS
): RouteResult {
    const paths = new Map<string, string>();
    const degraded: string[] = [];
    const startedAt = performance.now();
    const cheapOnly = edges.length > MAX_ROUTED_EDGES;

    for (const edge of edges) {
        const a = rectById.get(edge.source);
        const b = rectById.get(edge.target);
        if (!a || !b) continue;

        const key = cacheKey(geometryHash, a, b);
        const cached = ROUTE_CACHE.get(key);
        if (cached !== undefined) { paths.set(edge.id, cached); continue; }

        if (cheapOnly || performance.now() - startedAt > budgetMs) {
            paths.set(edge.id, toSvgPath(zRoute(a, b)));
            degraded.push(edge.id);
            continue;
        }

        const d = routeOne(a, b, obstacles) ?? toSvgPath(zRoute(a, b));
        if (ROUTE_CACHE.size > ROUTE_CACHE_LIMIT) ROUTE_CACHE.clear();
        ROUTE_CACHE.set(key, d);
        paths.set(edge.id, d);
    }

    return { paths, degraded };
}

function routeOne(a: Rect, b: Rect, allObstacles: Rect[]): string | null {
    const { from, to } = pickSides(a, b);
    // Snap to integers: grid coordinates are rounded, and a sub-pixel mismatch
    // between an anchor/stub and its grid point would emit a diagonal jog.
    const snap = (p: Pt): Pt => ({ x: Math.round(p.x), y: Math.round(p.y) });
    const start = snap(anchorOf(a, from));
    const end = snap(anchorOf(b, to));
    const startStub = snap(stubOf(start, from, STUB + CLEARANCE));
    const endStub = snap(stubOf(end, to, STUB + CLEARANCE));

    const minX = Math.min(startStub.x, endStub.x);
    const maxX = Math.max(startStub.x, endStub.x);
    const minY = Math.min(startStub.y, endStub.y);
    const maxY = Math.max(startStub.y, endStub.y);
    const padX = Math.max(220, (maxX - minX) * 0.4);
    const padY = Math.max(220, (maxY - minY) * 0.4);
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const relevant: Rect[] = [];
    for (const o of allObstacles) {
        if (o.id === a.id || o.id === b.id) continue;
        if (o.x + o.w < minX - padX || o.x > maxX + padX) continue;
        if (o.y + o.h < minY - padY || o.y > maxY + padY) continue;
        relevant.push(o);
    }
    if (relevant.length > MAX_OBSTACLES) {
        relevant.sort((p, q) =>
            (Math.abs(p.x + p.w / 2 - centerX) + Math.abs(p.y + p.h / 2 - centerY)) -
            (Math.abs(q.x + q.w / 2 - centerX) + Math.abs(q.y + q.h / 2 - centerY)));
        relevant.length = MAX_OBSTACLES;
    }
    if (!relevant.length) return toSvgPath(zRoute(a, b));

    // The cheap orthogonal route is frequently already clear. Validating it costs
    // O(obstacles) and skips the whole A* setup, which is what keeps a dense
    // graph inside the batch time budget instead of degrading edges wholesale.
    const cheap = zRoute(a, b);
    if (polylineClear(cheap, relevant)) return toSvgPath(cheap);

    const rawXs: number[] = [startStub.x, endStub.x];
    const rawYs: number[] = [startStub.y, endStub.y];
    for (const o of relevant) {
        rawXs.push(o.x - CLEARANCE, o.x + o.w + CLEARANCE);
        rawYs.push(o.y - CLEARANCE, o.y + o.h + CLEARANCE);
    }
    const xs = capCoordinates(rawXs, [startStub.x, endStub.x], centerX, MAX_GRID_LINES);
    const ys = capCoordinates(rawYs, [startStub.y, endStub.y], centerY, MAX_GRID_LINES);

    const path = astar(xs, ys, relevant, startStub, endStub);
    if (!path) return null;
    return toSvgPath([start, startStub, ...path, endStub, end]);
}
