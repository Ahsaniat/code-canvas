# 05 — Edge routing

`webview/src/edges/route.ts`, `webview/src/edges/CircuitEdge.tsx`

Edges are drawn as **circuit traces**: orthogonal polylines that route *around*
node boxes rather than through them, with rounded corners.

## Algorithm

### 1. Hanan grid

Candidate coordinates are derived from the bounding-box edges of every obstacle,
expanded by a clearance margin, plus the two endpoints. The Cartesian product of
the candidate x and y values forms the grid. Any shortest rectilinear path
avoiding rectangular obstacles can be expressed on such a grid, so searching it
loses nothing versus searching continuous space.

Blocked cells and blocked segments are precomputed by binary-search range
marking rather than per-cell tests.

### 2. Turn-aware A*

Search state is `(gridPoint, incomingDirection)`, so a turn can be charged a
penalty. This produces paths with few bends — the visual difference between a
circuit trace and a staircase.

The heuristic counts **provably-required turns** in addition to Manhattan
distance, and remains admissible.

> This mattered more than expected. A plain Manhattan heuristic was so loose
> against the turn penalty that A* degenerated toward Dijkstra. Making the
> heuristic turn-aware dropped obstacle penetrations from **124 → 9** on the
> medium test scene.

### 3. Containers are not obstacles

`absoluteRects()` returns every node in `rectById` (an edge may terminate on a
container) but excludes `group` nodes from `obstacles`. A container must be
enterable, or no route into an expanded folder could exist.

Note also that React Flow child positions are relative to the parent, so offsets
accumulate down the tree — `absoluteRects` resolves them to canvas space.

## Performance budgets

Routing is bounded on every axis. When a bound is hit the edge degrades to a
cheap orthogonal L/Z route — still right-angled, just not obstacle-avoiding.

| Bound | Value |
| --- | --- |
| Edges routed | 160 |
| Obstacles considered | 56 |
| Grid lines per axis | 28 |
| A* expansions per edge | 4,200 |
| Synchronous slice | 18 ms |

### Progressive completion

The synchronous budget alone truncated the tail of the edge list. Instead,
skipped edges are reported in `degraded` and finished in `requestIdleCallback`
chunks. Only full-quality results are cached.

Effect on the medium scene: **124 → 3** obstacle penetrations. Median cost is
~0.35 ms per edge; a warm re-route is ~0.1 ms.

## When routing runs

**Never in a render body, never per frame.** Routes are computed:

- after a layout pass settles
- on drag stop
- on projection change

Results are memoised by a hash of the participating node rectangles, so an
unchanged scene re-uses its geometry.

## Behaviour during a drag

`data.d` is geometry frozen at the last routing pass. While a node moves it
describes where that node *used to be*, so the wire visibly detaches and only
snaps back on release.

`onNodeDragStart` therefore **releases the baked paths**
(`releaseBakedRoutes()`), which makes `CircuitEdge` fall back to React Flow's own
`getSmoothStepPath` — recomputed from live node positions every frame, so edges
track the node as it moves. `onNodeDragStop` restores circuit routes via
`rerouteFromCurrentPositions()`. The same pair is wired for multi-select drags.

Routing itself is untouched by this, so the "never route per frame" rule holds.

## The edge component

```tsx
export function CircuitEdge(props: EdgeProps<CircuitEdgeData>) {
    let path = data?.d;
    if (!path) [path] = getSmoothStepPath({ ...live coords });
    return <BaseEdge id={id} path={path} … interactionWidth={22} />;
}
export const edgeTypes = { circuit: CircuitEdge } as const;
```

Two deliberate details:

- `edgeTypes` is defined **once at module scope** — a changing identity remounts
  every edge, exactly as it would for `nodeTypes`.
- An edge is never invisible: a missing route always falls back to a valid path.

## Hover tooltip

Hovering a wire shows source → target, the relationship count when aggregated,
and up to 10 rows of `file.ts → file.ts` with the symbols crossing that boundary
(capped at 6 symbols per row, then `+N more`).

Symbols read as `alpha as A`, `default`, `* (namespace)` or `(side effect)`
depending on the import form.

The tooltip renders in `HoverOverlay`, which lives **outside** the React Flow
subtree and is driven imperatively through a ref — so hovering a wire re-renders
that one element and never the canvas. Updates are rAF-throttled with a payload
equality guard.

Nodes deliberately have **no** hover overlay: a file or folder renders its own
description, so a banner there only repeated visible text while covering the
canvas behind it. A wire has nowhere to put its symbol list, so it still needs
one.
