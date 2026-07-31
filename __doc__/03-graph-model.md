# 03 — Graph model & projection

`webview/src/model/graphModel.ts`

This is the most important document in the set. The collapse-first model
determines what appears on screen, how many nodes React Flow ever sees, and why
the nested-container bugs are structurally absent rather than merely fixed.

## The core idea

The extension hands over the **full file tree**. Rendering that tree as nested
React Flow groups is what produced both the stacked-container bug and the lag.

So the tree is kept here as plain data, and only a **projection** of it — derived
from the set of expanded folders — is ever handed to React Flow.

### Invariants

1. The real file→file import edges live in the model and are **never** given to
   React Flow.
2. A collapsed folder is an **ordinary leaf node**, not a container.
3. Every projected edge carries the underlying file pairs and symbols, so the
   hover tooltip works identically at folder level and at file level.

## Model construction

`buildModel(rawNodes, rawEdges)` builds:

```ts
interface GraphModel {
  nodes: Map<string, ModelNode>;
  displayRoots: string[];   // canvas-root ids; the workspace root is elided
  edges: RawEdge[];         // the real file→file edges, untouched
}
```

Each `ModelNode` gains `childIds` (folders before files, then alphabetical) and
`fileCount` — the number of file descendants.

`displayRoots` elides the workspace root folder: a single container wrapping
everything is a wasted level of nesting.

## Projection

`projectGraph(model, expanded, hidden)` walks the visible tree breadth-first.

For each node:

| Node state | Rendered as | Represents |
| --- | --- | --- |
| file | `file` node | itself |
| folder, collapsed | `folder` node (a leaf chip) | itself **and every descendant** |
| folder, expanded | `group` node (a container) | itself |

The walk builds a `representative` map: every node id → the visible node that
stands in for it. A collapsed folder registers itself as the representative of
all its descendants.

Because the walk is breadth-first over the visible tree, the output array is
already **parents-before-children** — React Flow v11 requires this, and violating
it detaches or mis-positions children.

### Edge projection

```
for each real file→file edge:
    a = representative[edge.source]
    b = representative[edge.target]
    skip if either is missing        (hidden or out of graph)
    skip if a === b                  (internal to one collapsed folder)
    accumulate into the projected edge keyed a→b
```

The projected edge accumulates `relationships` — one per underlying file pair,
carrying source/target paths, labels and symbol names. That is why hovering an
aggregated folder→folder wire can still list the individual file relationships
behind it.

In/out degree badges on folder chips are computed from the projected edge set, so
they always agree with what is drawn.

## Why "collapse everything by default" cannot work

This is worth stating plainly because it looks like the safe default and is in
fact the worst one.

At the coarsest level almost every import is *internal* to a top-level folder. In
a monorepo whose roots are `extension/` and `webview/`, every edge projects to a
self-loop and is dropped:

```
all collapsed →  nodes = 2   edges = 0
```

Two boxes, no edges, and — since the radial layout classifies zero-degree nodes
as orphans — both sitting in the middle with nothing on the ring. Nothing anyone
can read.

`initialExpansion(model)` therefore picks the opening depth per graph:

```
expand level by level while:
      the projection has no edges                 ← the binding condition
   OR it has fewer than `targetNodes` (24) nodes
stop at maxDepth (6), or at hardCap (80) nodes once edges exist
```

The edge condition is the important half. A view with no edges is not a graph,
and it is worth overshooting the node target to escape one.

Measured on this repository:

| | nodes | edges | on ring | in centre |
| --- | --- | --- | --- | --- |
| all collapsed | 2 | 0 | 0 | 2 |
| `initialExpansion` | 24 | 28 | 20 | 4 |

A user's saved expansion state always wins; `initialExpansion` only seeds a fresh
view.

## Expand / collapse

| Function | Behaviour |
| --- | --- |
| `expandWithAncestors(id)` | Expands the node and every ancestor, so it cannot be expanded-but-invisible |
| `collapseWithDescendants(id)` | Collapses the node and everything beneath it, so re-expanding starts clean |

Expansion state persists via the webview `getState`/`setState` API and survives a
reload.

## Hiding

Deleting a node **hides it from the projection** rather than mutating the React
Flow array — the next re-projection would simply undo an array mutation. A
"Restore Hidden" button clears the set.
