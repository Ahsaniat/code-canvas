# 08 — Performance

Each rule below exists because its violation caused a measured, user-visible
problem. They are worth preserving as rules rather than rediscovering.

## 1. `nodeTypes` and `edgeTypes` are module-scope constants

```ts
export const nodeTypes = { file: FileCanvasNode, folder: FolderCanvasNode, group: GroupCanvasNode } as const;
export const edgeTypes = { circuit: CircuitEdge } as const;
```

React Flow compares these by identity. A new object each render — the natural
result of building them inside the component, even inside a `useMemo` with the
wrong dependencies — **remounts every node and edge**, which re-runs highlight.js
across the whole canvas.

Dynamic state the node components need is delivered through `CanvasContext`
instead of a closure captured inside `nodeTypes`.

## 2. Hover never touches React state

Node hover writes nothing at all now. Edge hover writes to `HoverOverlay` through
a ref; the overlay lives outside the React Flow subtree, so it re-renders alone.

Pointer moves fire many times per second. Routing hover through `useState` in
`App` re-rendered the entire canvas on every one of them.

## 3. Nothing is measured and written back into node style

Node sizes are pure functions of their input:

- file nodes → `computeStyleFromContent(content)`
- folder chips → fixed `320 × 168`
- groups → computed by the layout from their children

The previous build measured rendered code with `getBoundingClientRect` and wrote
the result into node style, which changed sizes *after* layout had spaced them —
causing a measure → relayout → measure loop. A worse instance measured **every
code line** on every resize *and* every scroll to position per-line handles; that
machinery is deleted.

## 4. Layout and routing never run per frame

| Work | When it runs |
| --- | --- |
| Layout | Projection change, explicit relayout, algorithm switch |
| Routing | After layout settles, on drag stop, on projection change |

Both are cancellable and token-guarded, so a superseded pass discards its result
instead of racing the current one. Routing is memoised by a hash of participating
node rectangles.

During a drag, baked routes are *released* so React Flow's own live path tracks
the node — releasing cached geometry, not computing new geometry.

## 5. ELK runs in a Web Worker

`elk.layout` is CPU-heavy and would block the UI thread. Vite inlines the worker
as a base64 blob (`?worker&inline`), which the CSP permits via `worker-src blob:`.
Worker failure degrades to Dagre.

## 6. Only the projection reaches React Flow

The single largest win. A 10,000-file repository opens as a handful of folder
chips because collapsed folders are leaves, not containers. Node count is
governed by expansion depth, not repository size.

`onlyRenderVisibleElements` is enabled on top of that.

## 7. Selective store subscriptions

Components subscribe to the narrowest slice they need:

```ts
const fileMeta = useMetaStore(s => s.files[path]);   // not the whole store
```

A whole-store subscription re-renders every node whenever any file's metadata
changes.

## 8. Indexing is async with bounded concurrency

Files are read 24 at a time rather than sequentially with `readFileSync`. Module
resolution probes ~9 candidate paths per import, so a per-build `existsSync`
cache prevents repeat stats. Document symbols are fetched at most once per file.

## 9. Bundle size

The webview bundle is ~1.8 MB minified (~590 kB gzipped). It was 11 MB when
`minify: false` and an inline sourcemap were in effect. Sourcemaps are emitted as
separate files and excluded from the VSIX via `.vscodeignore`.

## Performance floors

| Guard | Threshold |
| --- | --- |
| Code rendering | Below 0.65 zoom, placeholders replace highlighted code |
| Edges routed | 160 |
| Obstacles considered | 56 |
| A* expansions per edge | 4,200 |
| Synchronous routing slice | 18 ms, remainder in `requestIdleCallback` |
| Ring-order swap refinement | Skipped above 240 nodes |
