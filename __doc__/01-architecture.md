# 01 — Architecture

## Process model

Code Canvas runs in two processes with different capabilities, and the split
determines where every piece of logic belongs.

```
┌─────────────────────────────────────┐        ┌──────────────────────────────────┐
│ EXTENSION HOST (Node.js)            │        │ WEBVIEW (browser sandbox)        │
│ extension/src/*.ts → dist/extension.js│      │ webview/src/* → media/assets/*.js│
│                                     │        │                                  │
│ • filesystem access (fast-glob, fs) │ post   │ • React 18 + React Flow v11      │
│ • VS Code API (config, editors, LSP)│Message │ • layout engines (ELK worker)    │
│ • import parsing + resolution       │◄──────►│ • edge routing (A*)              │
│ • auto-description generation       │        │ • rendering & interaction        │
│ • .code-canvas/ persistence         │        │ • NO filesystem, NO VS Code API  │
└─────────────────────────────────────┘        └──────────────────────────────────┘
```

The webview cannot read files or call the VS Code API. Anything requiring either
must be a message round-trip. Conversely, layout and rendering must stay in the
webview — they need DOM measurements and would block the extension host.

## Packages

npm workspaces, two packages:

| Package | Build | Output |
| --- | --- | --- |
| `extension/` | `tsup` (CJS bundle) | `extension/dist/extension.js` |
| `webview/` | `vite` (ESM, minified) | `extension/media/assets/*` |

`npm run build` at the root builds the webview **first**, then the extension —
the order matters because Vite writes into `extension/media/`, which is packaged
into the VSIX.

> ⚠️ `webview/vite.config.ts` sets `emptyOutDir: true`, so a webview build wipes
> `extension/media/`. Everything there is generated; never hand-edit that folder.

## Source map

### Extension host

| File | Responsibility |
| --- | --- |
| `extension.ts` | Activation, commands, webview lifecycle, message dispatch |
| `graph.ts` | `buildIndex`, `subgraph`, `describeGraph` — the whole indexing pipeline |
| `imports.ts` | Regex scanners for import/export statements and their bindings |
| `describe.ts` | Doc extraction and description composition (pure, no I/O) |
| `lsp.ts` | Document symbol lookup via the VS Code LSP |
| `git.ts` | Changed-file detection and repository state watching |
| `meta.ts` | `.code-canvas/meta.json` read/merge/write |
| `util.ts` | Shared types (`Graph`, `GraphNode`, `GraphEdge`, `EdgeLink`) and webview HTML loading |

### Webview

| File | Responsibility |
| --- | --- |
| `App.tsx` | State, message handling, projection→React Flow conversion, interaction |
| `model/graphModel.ts` | Collapse-first model, edge projection, initial expansion |
| `layout.ts` | The one layout pipeline; container recursion and non-overlap enforcement |
| `layout/radial.ts` | Radial engine — concentric rings, orphans in the centre |
| `edges/route.ts` | Circuit routing: Hanan grid construction and A* search |
| `edges/CircuitEdge.tsx` | Edge component; paints a precomputed path |
| `nodeTypes.tsx` | `file` / `folder` / `group` node components, module-scope `nodeTypes` |
| `code/CodeCard.tsx` | Syntax-highlighted, scrollable code preview |
| `components/` | Description panel, tag bar, tag filter, edge tooltip overlay |
| `store/metaStore.ts` | Zustand store for per-file metadata |
| `text.ts` | `firstSentence` — shared by the panel and folder nodes |

## Data flow, end to end

```
 workspace files
      │  fast-glob (+ excludeGlobs)
      ▼
 buildIndex ─────────────────────────────► Index
      │   parse imports/exports              { nodes, imports, importLines,
      │   resolve specifiers → abs paths       importBindings, lang, exports, doc }
      ▼
 subgraph(seeds, cap) ──────────────────► Graph { nodes[], edges[] }
      │   BFS over imports, then top-up
      │   build folder-group hierarchy
      │   attach EdgeLinks (symbol names)
      ▼
 describeGraph ─────────────────────────► AutoDescriptions
      │
      │  postMessage { type: 'graph' | 'autoDescriptions' }
      ▼
 ══════════════ webview boundary ══════════════
      │
 buildModel(rawNodes, rawEdges) ────────► GraphModel  (full tree, kept as data)
      │
 initialExpansion(model) ───────────────► Set<folderId>  (opening depth)
      │
 projectGraph(model, expanded, hidden) ─► Projection { nodes[], edges[] }
      │   endpoints mapped to nearest visible ancestor
      ▼
 toRfNode / toRfEdge ───────────────────► React Flow arrays
      │
 getLayoutedElements(nodes, edges, algo) ► positioned nodes
      │
 routeEdges(...) ───────────────────────► SVG paths baked into edge.data.d
      ▼
   render
```

The critical structural point: **the full graph never enters React Flow.** It
lives in `GraphModel`, and only a projection of it is handed over. See
[03 — Graph model](03-graph-model.md).

## Message protocol

### Webview → extension

| Message | Payload | Effect |
| --- | --- | --- |
| `requestGraph` | — | Index the workspace and return a subgraph |
| `requestCodeMany` | `paths[]` | Return file contents for previews |
| `requestMeta` | — | Return `.code-canvas/meta.json` |
| `updateFileMeta` | `path`, fields | Merge and persist file metadata |
| `expand` | `ids[]` | Grow the graph around the given nodes |
| `loadMore` | — | Raise the node cap and re-send |
| `openFile` | `path`, `line?` | Open the file in an editor |
| `requestDefOpen` | `path`, `line`, `character` | Go to definition |
| `requestRefs` | `path`, `line`, `character` | Find references |
| `requestChanged` | — | Return Git-changed files |
| `seedFolder` | — | Prompt for a folder and reseed |
| `toggleRefs` | — | Toggle the references panel |

### Extension → webview

| Message | Payload |
| --- | --- |
| `graph` | `{ nodes, edges }` — the subgraph |
| `expandResult` | Additional nodes/edges to merge |
| `autoDescriptions` | `{ path: { kind, autoDescription } }` |
| `code` / `codeMany` | File contents |
| `metaLoaded` / `metaSaved` | Persisted metadata |
| `refs` | Reference search results |
| `changedFiles` / `gitChanged` | Git state |
| `docChanged` | A saved document, for live preview refresh |
| `layout` | Layout algorithm change from a command |
| `progress` / `empty` | Status feedback |

## Content Security Policy

The webview HTML declares a strict CSP, with `__CSP__` substituted at load time
by `htmlForWebview()` in `util.ts`:

```
script-src __CSP__;
worker-src blob:;
child-src  blob:;
```

`worker-src blob:` is required because ELK runs in a Web Worker that Vite inlines
as a base64 blob. Without it, layout silently falls back to Dagre.
