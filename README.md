# Code Canvas - Visual Code Graph for VS Code

## Overview
Code Canvas is a Visual Studio Code extension that turns your workspace into an interactive dependency graph. It indexes your JavaScript/TypeScript and Python files, resolves their imports, and renders the result as a canvas of folders and files connected by circuit-style wires.

The canvas is **collapse-first**: folders open as compact chips carrying the aggregate of everything inside them, and you expand only the parts you care about. That is what keeps a ten-thousand-file repository readable — and fast.

- **Folder-level graph** - a collapsed folder shows the union of its descendants' external imports, with in/out degree badges
- **Expand on demand** - open a folder to reveal its files and subfolders; edges re-anchor to the specific file
- **Radial layout** - connected nodes on concentric rings, unconnected files in the centre
- **Circuit-style edges** - orthogonal wires that route *around* nodes, not through them
- **Symbols on hover** - a wire tells you which functions, classes and types cross that boundary
- **Automatic descriptions** - every file and folder is described from its doc comment, exports and imports; your own text always wins
- **Inline code previews** - syntax-highlighted, scrollable, click a token to jump to its definition
- **Git-aware** - open changed files, live refresh on save

## Status & Disclaimer
This project is provided as-is with many known and unknown bugs. I open-sourced it so the community can build on it and take it further. I don’t have time to actively maintain it. Use at your own risk; contributions are very welcome.


## Requirements
- Node.js 18+ (Vite 7 requires Node 18 or newer)
- VS Code 1.102+ (as per extension engine)
- Git (optional but recommended; used to detect changed files)

This repo uses npm workspaces with two packages:
- `extension/` - the VS Code extension (TypeScript, bundled with tsup)
- `webview/` - the webview UI (React, Vite, React Flow, ELK)


## Install and Build (from source)
1) Install dependencies at the repository root (installs both workspaces):
```bash
npm install
```

2) Build the webview and the extension:
```bash
npm run build
```
This produces the webview build into `extension/media/` and the extension bundle into `extension/dist/`.

3) Launch the extension for development in VS Code:
- Open the repository in VS Code
- Press F5 (Run and Debug → “Extension”) to launch a new Extension Development Host
- In the dev host, run “Code Canvas: Open” to show the canvas panel

Notes for rapid iteration:
- The default root watch script starts Vite’s dev server for the webview, which doesn’t feed the extension’s `extension/media/` folder. For quickest feedback inside the extension, prefer a build‑watch for the webview:
  - Terminal A: `cd webview && npx vite build --watch`
  - Terminal B: `npm -w extension run watch`
  - Reload the Extension Development Host window to pick up changes if needed

Root scripts for convenience:
- `npm run build` — build `webview` then `extension`
- `npm run watch` — runs `webview dev` and `extension watch` in parallel (dev server for webview; see note above)
- `npm run package` — package the extension VSIX via `vsce`


## Packaging and Installation (VSIX)
Create a `.vsix` package:
```bash
npm run package
```
This generates a file like `extension/code-canvas-0.0.1.vsix`.

Install the VSIX locally:
```bash
code --install-extension extension/code-canvas-0.0.1.vsix
```
Or via VS Code: Extensions view → “…” menu → Install from VSIX…


## Using Code Canvas
Open the canvas:
- Command Palette → “Code Canvas: Open”

Toolbar (in the webview):
- Layout selector — Radial / ELK / Dagre / Force
- Relayout — recompute the current layout
- Expand (E) — grow the graph from the selected nodes
- Hide/Show Edges — toggle edge visibility
- Seed Folder… — build a view scoped to a specific folder
- Load More — raise the node cap
- Restore Hidden — bring back nodes removed with Delete
- Refs (R) — toggle the references panel
- Wrap/Unwrap — toggle code wrapping in previews

Interaction tips:
- Click the chevron on a folder (or double-click it) to expand or collapse
- Double-click a file header to open it in the editor
- **Scroll inside a code card** with the wheel; the canvas zooms everywhere else
- Hover an edge to see the symbols crossing that boundary
- Click an edge to scroll both code cards to the import site
- Click a token in code to jump to its definition and populate the references panel
- Press E to expand from the selection; Delete hides nodes (restorable)
- Zoom out far enough and code bodies become labels — a deliberate performance floor

Seeds and growth:
- The opening view is chosen automatically: folders expand just far enough to show a graph with actual edges
- Your expansion state, hidden set and layout choice persist across reloads
- "Seed Folder…" scopes the view to one folder

## Commands and Keybindings
Contributed commands (Command Palette):
- Code Canvas: Open (`codeCanvas.open`)
- Code Canvas: Open Changed Files (`codeCanvas.openChanged`)
- Code Canvas: Layout – Radial (`codeCanvas.layout.radial`)
- Code Canvas: Layout – Dagre (`codeCanvas.layout.dagre`)
- Code Canvas: Layout – ELK (`codeCanvas.layout.elk`)
- Code Canvas: Layout – Force (`codeCanvas.layout.force`)
- Code Canvas: Toggle Refs (`codeCanvas.toggleRefs`)
- Code Canvas: Open Folder as Seed (`codeCanvas.seedFolder`)
- Code Canvas: Load 25 More (`codeCanvas.loadMore`)

Default keybindings:
- ⇧O — Open Changed Files
- ⇧+ — Load 25 More
- ⇧1 / ⇧2 / ⇧3 / ⇧4 — Layout: Radial / Dagre / ELK / Force
- R — Toggle Refs

All four algorithms are implemented and switch at runtime. Radial is the default.


## Settings
User/workspace settings under `Code Canvas`:
- `codeCanvas.initialCap` (number, default: 400) — Files pulled in on first render. Folders open collapsed, so this can be generous; a small cap silently truncates whole parts of the tree.
- `codeCanvas.maxNodes` (number, default: 1000) — Ceiling for expansion and "Load more"
- `codeCanvas.maxPreviewBytes` (number, default: 100000) — Max bytes per file sent to the code preview
- `codeCanvas.excludeGlobs` (array<string>) — Glob patterns excluded from indexing. Defaults cover `node_modules`, `venv`/`.venv`, `site-packages`, `__pycache__`, `dist`, `build`, `out`, `.next`, `.expo`, `coverage`, `.cache`, `vendor`, `Pods`, `logs` and more.

  ⚠️ Setting this **replaces** the default list rather than adding to it.


## How it works (Architecture)

Full documentation lives in [`__doc__/`](__doc__/README.md). In brief:

1. **Indexing** (extension host) — `fast-glob` finds JS/TS/Python files, regex scanners extract import specifiers *and their bindings*, and relative specifiers resolve to absolute paths. One read per file also captures exported symbols and the leading doc comment.
2. **Subgraph** — a BFS from the seed files, then a top-up pass so disconnected parts of the workspace (a frontend that never imports the backend) still appear.
3. **Model & projection** (webview) — the full tree is held as plain data. Only a *projection* of it reaches React Flow: each edge endpoint is mapped up to its nearest **visible** ancestor, so a collapsed folder carries the union of its descendants' external edges.
4. **Layout** — one container-recursive pipeline, deepest-first, shared by all four engines. A group's size is final before its parent spaces it, so containers cannot overlap.
5. **Routing** — orthogonal paths found by turn-aware A* over a Hanan grid built from node rectangles, computed off the render path and memoised by geometry hash.
6. **Descriptions** — composed from doc comments, exports and resolved imports; stored separately from anything you write.

| Document | Covers |
| --- | --- |
| [Architecture](__doc__/01-architecture.md) | Process model, message protocol, data flow |
| [Indexing](__doc__/02-indexing.md) | Parsing, resolution, subgraph selection |
| [Graph model](__doc__/03-graph-model.md) | Collapse-first projection |
| [Layout](__doc__/04-layout.md) | Radial/ELK/Dagre/Force, non-overlap invariant |
| [Edge routing](__doc__/05-edge-routing.md) | Hanan grid + A*, performance budgets |
| [Descriptions](__doc__/06-descriptions.md) | Generation and the override rule |
| [UI reference](__doc__/07-ui-reference.md) | Commands, settings, interactions |
| [Performance](__doc__/08-performance.md) | The rules that keep it fast |
| [Development](__doc__/09-development.md) | Build, package, debug, offline harnesses |

### Supported languages

JavaScript, TypeScript (including JSX/TSX) and Python. Nothing else is indexed.

Only **relative** imports resolve — bare package specifiers are skipped by design, and TypeScript `paths` / bundler aliases (`@/components/…`) are **not** resolved yet.

## Troubleshooting
- Changes don’t appear after installing: reload the VS Code window — `--install-extension` does not refresh an open one. Also make sure you ran `npm run build` at the root, since `vscode:prepublish` builds only the extension, not the webview.
- Nothing shows up: make sure you opened a folder and have JS/TS or Python files that aren’t excluded by settings.
- Whole folders missing: raise `codeCanvas.initialCap`, or check `excludeGlobs` isn’t too broad.
- Very few edges: your imports probably go through TS `paths` or bundler aliases, which aren’t resolved yet.
- Code cards won’t scroll: the wheel scrolls a card and zooms the canvas — make sure the pointer is over the code.
- Webview doesn’t update: If using watch mode, prefer `npx vite build --watch` instead of `vite dev` to feed `extension/media/` where the extension loads assets.
- Node version errors: Ensure Node 18+.
- Changed files missing: Verify the Git extension is enabled; otherwise the extension falls back to parsing `git status` output.
- Performance: Reduce `codeCanvas.maxNodes` and/or widen `codeCanvas.excludeGlobs`. Large files are truncated to `codeCanvas.maxPreviewBytes` for preview.


## Scripts (reference)
Root `package.json`:
```json
{
  "scripts": {
    "build": "npm -w webview run build && npm -w extension run build",
    "watch": "npm -w webview run dev & npm -w extension run watch",
    "package": "npm -w extension run package"
  },
  "workspaces": ["webview", "extension"]
}
```
Webview `package.json`:
```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  }
}
```
Extension `package.json`:
```json
{
  "scripts": {
    "vscode:prepublish": "npm run build",
    "build": "tsup src/extension.ts --format cjs --dts --out-dir dist --external vscode",
    "watch": "tsup src/extension.ts --watch --format cjs --out-dir dist",
    "package": "vsce package --no-dependencies"
  }
}
```

Tip: For a webview build watch, run `npx vite build --watch` inside `webview/`.


## Roadmap / Ideas
- Additional language parsers (Go, Rust, Java, C#)
- Resolve TypeScript `paths` and bundler aliases
- Migrate to React Flow v12 (`@xyflow/react`) and adopt `NodeResizer`
- Model-generated descriptions as an opt-in alternative to the heuristics
- Named, saveable canvases and screenshot export


## License
MIT - free to use, modify, and distribute. See the `LICENSE` file for details.


## Acknowledgements
- React Flow for graph rendering
- ELK (Eclipse Layout Kernel) for layered layouts
- Highlight.js for syntax highlighting
- VS Code extension samples and APIs


## Note
First of all I give thanks to the original author waLLxAck. I have forked his source code for this extension and added support for VScode later versions. I have also optimized and added new features, while improving usability of the extension. You might see build files here. I have git committed them intentionally as a fallback. I have tested it on vscode 1.129.1. Version lesser than this might not work with this extension. Even though the extension is under development and more features will be coming next month. This is the stable release. You are welcome to try it
