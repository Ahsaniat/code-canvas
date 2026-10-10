# Code Canvas OSS

Interactive canvas for your codebase: a file and folder graph with inline code previews, search, descriptions and resizable nodes.

An actively maintained fork of [waLLxAck/code-canvas](https://github.com/waLLxAck/code-canvas).

## Features

- **Folder-level graph** - a collapsed folder shows the union of its descendants' external imports, with in/out degree badges
- **Expand on demand** - open a folder to reveal its files and subfolders; edges re-anchor to the specific file
- **Four layouts** - Radial (connected nodes on concentric rings, orphans in the centre), ELK, Dagre and Force
- **Circuit-style edges** - orthogonal wires that route around nodes, not through them
- **Search everything** - find a node by name, path, exported symbol or tag, even inside a collapsed folder, and jump straight to it
- **Symbols on hover** - a wire tells you which functions, classes and types cross that boundary
- **Automatic descriptions** - every file and folder is described from its doc comment, exports and imports; your own text always wins
- **Inline code previews** - syntax-highlighted, scrollable, click a token to jump to its definition
- **Resizable nodes** - select a file node and drag its corners; the size is remembered
- **Git-aware** - open changed files, live refresh on save

## Screenshots

![Canvas overview](https://github.com/Ahsaniat/code-canvas/raw/HEAD/__doc__/demo_photos/Screenshot_20261010_142932.png)

| Selection & resize handles | Inline code preview |
| --- | --- |
| ![Selection and resize handles](https://github.com/Ahsaniat/code-canvas/raw/HEAD/__doc__/demo_photos/Screenshot_20261010_143001.png) | ![Inline code preview](https://github.com/Ahsaniat/code-canvas/raw/HEAD/__doc__/demo_photos/Screenshot_20261010_143056.png) |

| File descriptions | Expanded description & resized node |
| --- | --- |
| ![File descriptions](https://github.com/Ahsaniat/code-canvas/raw/HEAD/__doc__/demo_photos/Screenshot_20261010_143116.png) | ![Resized node](https://github.com/Ahsaniat/code-canvas/raw/HEAD/__doc__/demo_photos/Screenshot_20261010_143304.png) |

## Install

From the VS Code Marketplace:

```bash
code --install-extension ahsaniat.code-canvas-oss
```

Or search **Code Canvas OSS** in the Extensions view. VSIX builds are also attached to
[GitHub Releases](https://github.com/Ahsaniat/code-canvas/releases).

## Getting started

1. Open a folder with JavaScript/TypeScript or Python files.
2. Run **Code Canvas: Open** from the Command Palette.
3. The canvas opens with folders collapsed; expand only what you care about.

### Toolbar

- **Search** - find nodes by name, path, export or tag
- **Layout** - Radial, ELK, Dagre or Force; **Relayout** recomputes the current one
- **Expand (E)** - grow the graph from the selected nodes
- **Hide/Show Edges**, **Wrap/Unwrap**, **Refs (R)**
- **Seed Folder…** - scope the view to one folder
- **Load More** - raise the node cap
- **Restore Hidden** - bring back nodes hidden with Delete

### Search

- Press `/` or `Ctrl/Cmd+F` to focus the search box
- `↑`/`↓` move through results, `Enter` reveals the active one, `Esc` closes the list
- Plain text searches every field; `name:`, `path:`, `sym:` and `tag:` narrow it to one
- **Filter** dims everything that doesn't match - folders containing a match stay lit
- Revealing expands whatever collapsed folders were hiding the result and centres on it

### Interaction tips

- Click the chevron on a folder (or double-click it) to expand or collapse
- Double-click a file header to open it in the editor
- Scroll inside a code card with the wheel; the canvas zooms everywhere else
- Hover an edge to see the symbols crossing that boundary
- Click an edge to scroll both code cards to the import site
- Click a token in code to jump to its definition and populate the references panel
- Press **E** to expand from the selection; **Delete** hides nodes (restorable)
- Zoom out far enough and code bodies become labels - a deliberate performance floor

## Commands

- **Code Canvas: Open** (`codeCanvas.open`)
- **Code Canvas: Open Changed Files** (`codeCanvas.openChanged`)
- **Code Canvas: Layout - Radial / Dagre / ELK / Force** (`codeCanvas.layout.*`)
- **Code Canvas: Toggle Refs** (`codeCanvas.toggleRefs`)
- **Code Canvas: Open Folder as Seed** (`codeCanvas.seedFolder`)
- **Code Canvas: Load 25 More** (`codeCanvas.loadMore`)

## Keybindings

- `⇧O` - Open Changed Files
- `⇧+` - Load 25 More
- `⇧1` / `⇧2` / `⇧3` / `⇧4` - Layout: Radial / Dagre / ELK / Force
- `R` - Toggle Refs

## Settings

Settings under **Code Canvas**:

- `codeCanvas.initialCap` (default `400`) - files pulled in on first render
- `codeCanvas.maxNodes` (default `1000`) - ceiling for expansion and "Load more"
- `codeCanvas.maxPreviewBytes` (default `100000`) - max bytes per file sent to the code preview
- `codeCanvas.excludeGlobs` (array) - glob patterns excluded from indexing. Setting this
  **replaces** the default list rather than adding to it. Defaults cover `node_modules`,
  `venv`/`.venv`, `site-packages`, `__pycache__`, `dist`, `build`, `out`, `.next`, `.expo`,
  `coverage`, `.cache`, `vendor`, `Pods`, `logs` and more.

## Requirements

- VS Code 1.102+
- A JavaScript/TypeScript or Python project (Python support is experimental)
- Git is optional; when available it powers changed-file highlighting

## Known limitations

- JS/TS/JSX/TSX and Python only - no other languages are indexed
- Only relative imports resolve; TypeScript `paths` and bundler aliases (`@/…`) are not resolved yet
- Descriptions are heuristic, not model-generated

## Support

Report bugs and request features via
[GitHub Issues](https://github.com/Ahsaniat/code-canvas/issues). Please include your VS Code
version, the extension version and the steps to reproduce.

## Credits

- Original project by [waLLxAck](https://github.com/waLLxAck)
- Built with React Flow, ELK, highlight.js and the VS Code extension APIs

## License

MIT - free to use, modify and distribute. See the repository `LICENSE` for details.
