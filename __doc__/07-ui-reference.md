# 07 — UI reference

## Commands

| Command | Title | Notes |
| --- | --- | --- |
| `codeCanvas.open` | Code Canvas: Open | Opens the canvas for the workspace |
| `codeCanvas.openChanged` | Code Canvas: Open Changed Files | Seeds from Git-changed files |
| `codeCanvas.seedFolder` | Code Canvas: Open Folder as Seed | Prompts for a folder, reseeds the graph |
| `codeCanvas.loadMore` | Code Canvas: Load 25 More | Raises the node cap |
| `codeCanvas.layout.radial` | Layout – Radial (orphans in centre) | Default |
| `codeCanvas.layout.dagre` | Layout – Dagre | |
| `codeCanvas.layout.elk` | Layout – ELK | |
| `codeCanvas.layout.force` | Layout – Force | |
| `codeCanvas.toggleRefs` | Code Canvas: Toggle Refs | References panel |

## Keybindings

| Key | Action |
| --- | --- |
| `Shift+1` | Radial layout |
| `Shift+2` | Dagre layout |
| `Shift+3` | ELK layout |
| `Shift+4` | Force layout |
| `Shift+O` | Open changed files |
| `Shift++` | Load 25 more |
| `R` | Toggle references panel |
| `E` | Expand selection |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `codeCanvas.initialCap` | `400` | Files pulled in on first render. Folders open collapsed, so this can be generous; a small cap silently truncates whole parts of the tree. |
| `codeCanvas.maxNodes` | `1000` | Ceiling for expansion and "Load more". A budget on indexing, not on what is drawn. |
| `codeCanvas.maxPreviewBytes` | `100000` | Max bytes of file content sent per preview. |
| `codeCanvas.excludeGlobs` | see below | Glob patterns excluded from indexing. |

`excludeGlobs` defaults to: `node_modules`, `.venv`, `venv`, `virtualenv`,
`site-packages`, `__pycache__`, `.tox`, `.mypy_cache`, `.pytest_cache`, `dist`,
`build`, `out`, `.next`, `.nuxt`, `.expo`, `.svelte-kit`, `coverage`, `.cache`,
`vendor`, `Pods`, `.gradle`, `logs`, `.git`.

> Setting this **replaces** the default list rather than adding to it. Copy the
> defaults in if you only mean to add one pattern.

## Canvas interactions

### Navigation

| Input | Action |
| --- | --- |
| Left / middle drag on empty canvas | Pan |
| Wheel | Zoom |
| Wheel **over a code card** | Scroll the code (the card opts out via `nowheel`) |
| Drag on empty canvas | Rubber-band selection |

### Nodes

| Input | Action |
| --- | --- |
| Chevron `▸` / `▾` on a folder | Expand / collapse |
| Double-click a folder | Expand / collapse |
| Double-click a file header | Open the file in an editor |
| Drag a file header | Move the node |
| `−` / `+` in a file header | Collapse / expand the code body |
| Click a token in code | Go to definition; populates the references panel |
| `Delete` | Hide the selection (restorable) |
| `E` | Expand the selection |

Below ~0.65 zoom, file bodies render a large-label placeholder instead of
highlighted code. This is a deliberate performance floor — highlighting code
nobody can read is wasted work.

### Description panel

Collapsed shows the first sentence on one line with a `more…` affordance. Click
the toggle row to expand; click the expanded text to edit. Editing seeds from the
generated text; nothing persists until commit.

`⌘/Ctrl+Enter` commits, `Escape` cancels, blur commits.

### Edges

Hovering a wire shows a tooltip listing the file relationships behind it and the
symbols crossing each boundary. Clicking an edge scrolls both code cards to the
import site and highlights the lines.

Nodes intentionally have no hover banner — their description is on the node.

### Toolbar

Layout selector, Relayout, Hide/Show Edges, Expand (E), Seed Folder…, Load More,
Restore Hidden, tag filters.

## Live updates

- **On file save** — the preview for that file refreshes.
- **On Git state change** — changed-file highlighting updates.
- Expansion state, hidden set and layout choice persist across reloads via the
  webview state API.

## Persistence

`.code-canvas/meta.json` in the workspace root holds per-file descriptions, tags
and collapse state. It is safe to commit — it contains no absolute-path-dependent
behaviour beyond its keys — but most teams will want it in `.gitignore`.
