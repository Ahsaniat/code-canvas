# Change Log

All notable changes to the **Code Canvas** extension are documented in this file.

## [0.3.0] - 2026-10-11

### Added
- **Go, Rust, Java and C# support** - indexing, heuristic descriptions and import resolution for all four languages, with syntax highlighting
- **TypeScript `paths` / `baseUrl` resolution** from `tsconfig.json` / `jsconfig.json`, so `@/components/...` style imports produce edges

### Changed
- Edge arrows now point from the file that **provides** symbols to the file that **imports** them (previously the reverse). This matches the symbol list shown on hover; folder badges follow: `in` = imports from outside, `out` = imported-by.
- Publishing is automated: a GitHub release tagged `v<version>` builds, publishes to the Marketplace (and Open VSX when configured) and attaches the VSIX
- Host/webview protocol types now share one source of truth; stylesheet split into ordered modules; React Flow callbacks stabilized

### Fixed
- Single-key shortcuts no longer fire outside the canvas. They were unscoped VS Code keybindings, so typing `r` (or `O`, `+`, `!@#$`) in the editor was swallowed until the extension was uninstalled. The shortcuts now live in the canvas itself and ignore focused inputs.

## [0.2.2] - 2026-10-10

### Fixed
- Search works again: an infinite selection-callback render loop (~1700 renders/s) was starving deferred renders, so queries never reached the matcher. Selecting a result now reveals it - expanding collapsed folders - and animates the viewport to the node.

## [0.2.1] - 2026-10-10

### Changed
- Marketplace listing README rewritten as a user guide; build-from-source notes stay on GitHub
- Install instructions and badges updated for the Marketplace and GitHub Releases

## [0.2.0] - 2026-10-10

### Added
- Resizable file nodes: select a node and drag its corners; sizes are remembered in `.code-canvas/meta.json`
- README screenshots

### Fixed
- Collapse/expand now resizes the node box, its resize handles, its edges and the layout spacing
- Minimap panning no longer triggers the kinetic fling, which caused an excessive glide
- The zoomed-out placeholder no longer shows each node name twice

## [0.1.0] - 2026-10-09

### Added
- Search across the full model: name, path, exported symbol or tag, with reveal-through-collapsed-folders
- File and folder descriptions and tags, stored in `.code-canvas/meta.json`
- Unit tests (vitest) and GitHub Actions CI

### Changed
- Migrated to React Flow 12 (`@xyflow/react`)
- Design-token pass over the stylesheet

### Fixed
- `codeCanvas.maxPreviewBytes` is enforced; previews are read asynchronously
- `.code-canvas/meta.json` writes are serialized and atomic
- Seed folders respect `codeCanvas.maxNodes`
- Source maps are no longer shipped in the VSIX; README and LICENSE are included
