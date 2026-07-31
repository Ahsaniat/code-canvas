# Code Canvas — Documentation

Full architecture and functional documentation for Code Canvas, a VS Code
extension that renders a workspace as an interactive dependency graph.

## Contents

| Document | What it covers |
| --- | --- |
| [01 — Architecture](01-architecture.md) | Process model, the two packages, message protocol, data flow end to end |
| [02 — Indexing & import resolution](02-indexing.md) | File discovery, import/export parsing, module resolution, subgraph selection |
| [03 — Graph model & projection](03-graph-model.md) | The collapse-first model, edge projection, expand/collapse semantics |
| [04 — Layout](04-layout.md) | Radial / ELK / Dagre / Force engines and the non-overlap invariant |
| [05 — Edge routing](05-edge-routing.md) | Circuit-style orthogonal routing, Hanan grid + A*, performance budgets |
| [06 — Descriptions](06-descriptions.md) | Automatic description generation, manual override, persistence |
| [07 — UI reference](07-ui-reference.md) | Commands, keybindings, settings, every on-canvas interaction |
| [08 — Performance](08-performance.md) | The rules that keep the canvas responsive, and why each exists |
| [09 — Development](09-development.md) | Build, package, debug, offline harnesses, troubleshooting |

## Reading order

If you are new to the codebase, read **01**, then **03**, then **04**. Those
three cover the parts that most influence what appears on screen.

If you are chasing a rendering bug, **03** (what is visible) and **04** (where it
is placed) are where the answer almost always lives.

## A note on invariants

Several documents call out *invariants* — properties the code is structured to
make impossible to violate, rather than merely checked at runtime. They exist
because each one corresponds to a class of bug that previously shipped:

- **Parents precede children** in the node array (React Flow v11 requirement).
- **One size source per node** — nothing resizes a node after its siblings were
  spaced against it.
- **No routing in a render body** — geometry is computed in a memo, never per frame.
- **Generated text never overwrites authored text** — descriptions are two fields.

Each is explained where it belongs. Treat them as load-bearing.
