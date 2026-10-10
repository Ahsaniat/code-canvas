# Change Log

All notable changes to the **Code Canvas** extension are documented in this file.

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
