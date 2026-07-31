# 04 — Layout

`webview/src/layout.ts`, `webview/src/layout/radial.ts`

## The one pipeline

All four algorithms share a single container-recursive pipeline. An *engine* only
has to place a flat set of sibling boxes; the pipeline handles hierarchy, group
sizing and overlap enforcement.

```ts
type Engine = (ctx: {
  childIds: string[];
  sizeOf: (id: string) => Box;
  edges: Array<[string, string]>;   // between these siblings only
  degreeOf: (id: string) => number;
}) => Map<string, Pt> | Promise<Map<string, Pt>>;
```

```
layoutContainers(nodes, edges, engine):
    for each container, DEEPEST FIRST:
        childIds  = direct children
        {internal, degree} = analyseEdges(...)   ← projected to these siblings
        raw       = engine({...})                ← falls back to a grid on throw
        raw       = enforceNoOverlap(childIds, raw, sizeForLayout)
        offset children by (GROUP_PAD, GROUP_HEADER)
        groupSize[container] = content bounds + padding
    finally lay out the canvas root
    return assemble(nodes, relPos, sizeForLayout)
```

## The non-overlap invariant

This is the property that makes stacked containers impossible, and it is worth
understanding precisely because the previous implementation looked correct and
was not.

**One size source.** `sizeForLayout(id)` returns a group's already-final size, and
`assemble()` writes `style.width/height` for **every** node from that same
function:

```ts
return assemble(nodes, relPos, sizeForLayout);
```

**Deepest-first ordering.** A group's size is final before its parent asks for it.

Together these mean nothing resizes after placement. The old code sized groups
*after* ELK had already spaced their siblings using the input sizes — so every
container inflated into its neighbours. There is now no code path that computes a
size twice, which is a stronger guarantee than a correctness check.

File node sizes are a pure function of content (`computeStyleFromContent`). The
previous build measured rendered code and wrote the result back into node style,
changing sizes *after* the layout had spaced them — the same bug class, and also
gone.

### `enforceNoOverlap`

A safety net that runs before a container is sized. It audits sibling pairs and,
if any overlap, applies a push-apart relaxation; if that fails to converge it
falls back to a uniform grid.

It is not redundant: the **force** engine is size-agnostic and produced 20+
overlaps per case in testing. Radial and Dagre pass it untouched.

## Geometry constants

| Constant | Value | Meaning |
| --- | --- | --- |
| `GROUP_HEADER` | 40 | Top gutter reserving space for the folder label |
| `GROUP_PAD` | 20 | Left / right / bottom padding inside a group |
| `MIN_GROUP_W/H` | 220 / 160 | Floor for an empty container |

`GROUP_HEADER` is shared by the layout maths and the rendered group style, so
children can never be positioned over a folder's label.

## Radial (default — `Shift+1`)

Orphans in the middle, everything else distributed across **concentric rings**.

### Why rings, plural

Seating every connected node on one circle makes the radius grow with node
*count* (`radius = totalArc / 2π`). On a real repo that produces one enormous
hoop, a small orphan block marooned at the centre, and a vast empty annulus
between them.

Instead each ring's radius is fixed by the geometry immediately inside it, that
radius sets a hard circumference budget, and nodes that do not fit start the next
ring further out. **The disc fills; it does not inflate.**

Measured: 120 nodes needed radius ≈ 12,340 on a single ring; concentric rings
reach ≈ 4,132.

### The maths

- **Arc allocation.** Each node is allocated `diagonal + 90px`. Using the
  *diagonal* rather than width or height makes the clearance hold at every angle
  without special-casing the ring's tangent direction.
- **Ring assignment.** A ring accepts nodes while
  `arcSum + arc ≤ 2π × radius`, where `radius = max(260, innerFloor + maxDiagonal/2)`.
  Because the radius does not depend on `arcSum`, the capacity is a real
  constraint. At least one node is always seated, so an oversized node cannot
  stall the loop.
- **Ring separation.** `floor(k+1) = radius(k) + maxDiagonal(k)/2 + gap`.
- **Chord verification.** Since arc ≥ chord, a pass grows the radius until the
  chord between neighbours also clears both diagonals. Only *adjacent* pairs need
  checking — angles are monotonic around the circle, so non-adjacent nodes are
  strictly farther apart.
- **Orphans.** Packed first into a uniform-cell grid sized square in *pixels*
  (not cell counts), which keeps the middle from becoming a long thin strip. The
  innermost ring is floored at `orphanCircumradius + gap`, so no ring can cut in.
- **Phase rotation.** Each successive ring is rotated by the golden ratio of a
  turn so nodes on different rings do not line up into radial spokes.

### Ordering (crossing reduction)

1. **Component-contiguous seed** — a connected component split across the circle
   guarantees long crossing chords.
2. **Barycentre sweep** — move each node toward the circular mean of its neighbours.
3. **Adjacent-swap refinement** — swapping two adjacent positions leaves every
   other node's angle untouched (the pair's combined arc is unchanged), so each
   test is O(degree), not O(edges). Skipped above 240 nodes.

### Responsiveness to expansion

Expanding a folder grows its box → grows its arc allocation and its ring's
half-diagonal clearance → pushes every ring outside it outward by exactly that
much and no more.

## ELK (`Shift+3`)

`elkjs` layered layout, run **per container on a flat graph** inside a Web Worker
so `elk.layout` never blocks the UI thread. Vite inlines the worker as a base64
blob; the CSP allows `worker-src blob:`.

Hierarchy is handled by the shared pipeline rather than ELK's
`INCLUDE_CHILDREN`, which is what allows the one-size-source invariant to hold.

If the worker fails to load or run, layout degrades to Dagre rather than losing
nesting.

## Dagre (`Shift+2`)

`dagre` directed layout per container, `rankdir: LR`. Dagre reports node centres;
the engine converts to top-left. Fully synchronous, no worker.

## Force (`Shift+4`)

A deterministic force simulation — grid-seeded (no RNG), 250 iterations,
repulsion between all pairs plus edge attraction with a cooling schedule. Results
are stable across runs. Size-agnostic, so it leans on `enforceNoOverlap`.

## Verification

`layout/radial.ts` was audited offline against 30 generated scenarios (uniform
sizes, varied sizes, one huge expanded folder, all-orphans, single node, dense
graphs; three seeds each), asserting zero pairwise overlaps and orphans strictly
inside the innermost ring. See [09 — Development](09-development.md) for how to
re-run that harness.
