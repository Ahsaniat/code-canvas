# 02 — Indexing & import resolution

All of this runs in the extension host (`extension/src/graph.ts` and
`imports.ts`). It is the only part of the system that touches the filesystem.

## 1. File discovery

```ts
const JS_GLOB   = ['**/*.{js,jsx,ts,tsx}'];
const PY_GLOB   = ['**/*.py'];
const GO_GLOB   = ['**/*.go'];
const RS_GLOB   = ['**/*.rs'];
const JAVA_GLOB = ['**/*.java'];
const CS_GLOB   = ['**/*.cs'];
```

Discovery uses `fast-glob` with `codeCanvas.excludeGlobs` as the ignore list.

**Supported languages: JavaScript, TypeScript (incl. JSX/TSX), Python, Go,
Rust, Java and C#.** Nothing else is parsed.

Language tagging collapses variants, which matters for description accuracy:

| Extensions | Tag |
| --- | --- |
| `.ts`, `.tsx` | `ts` |
| `.js`, `.jsx` | `js` |
| `.py` | `py` |
| `.go` | `go` |
| `.rs` | `rs` |
| `.java` | `java` |
| `.cs` | `cs` |
| anything else | `other` |

### Default exclusions

`node_modules`, `.venv`, `venv`, `virtualenv`, `site-packages`, `__pycache__`,
`.tox`, `.mypy_cache`, `.pytest_cache`, `dist`, `build`, `out`, `.next`,
`.nuxt`, `.expo`, `.svelte-kit`, `coverage`, `.cache`, `vendor`, `Pods`,
`.gradle`, `logs`, `.git`.

Override with `codeCanvas.excludeGlobs`. Note that setting it **replaces** the
default list rather than adding to it.

## 2. Reading and parsing

Files are read with bounded concurrency (24 in flight) — not a sequential wall
of `readFileSync`. One pass per file captures everything downstream needs:

- import specifiers with their **bindings** and source lines
- exported symbol names
- the leading doc comment / module docstring

Nothing re-reads a file later; description generation consumes what this pass
already captured, and the same exported names ship to the webview on
`GraphNode.symbols` (capped at 64 per file) to back symbol search.

### Export forms recognised

**JavaScript / TypeScript**

| Form | Names captured |
| --- | --- |
| `export function f`, `export class C`, `export const x`, `export type T`, … | `f`, `C`, `x`, `T` |
| `export { a, b as c }` | `a`, `c` |
| `export default function () {}` | `default export` |
| `exports.foo =` / `module.exports.foo =` | `foo` |
| `module.exports = Ident` | `Ident` |
| `module.exports = { a, b: c }` | `a`, `b` |

`module.exports = mongoose.model('User', schema)` is deliberately **not**
matched — no regex can honestly name what a factory call exports. That case is
recovered on the consumer side instead; see
[graph model](03-graph-model.md#what-is-searchable).

**Python**: `__all__` when present, otherwise top-level `class` and non-underscore
`def`.

### Import forms recognised

**JavaScript / TypeScript**

| Form | Bindings captured |
| --- | --- |
| `import d from 'x'` | `default` (alias `d`) |
| `import { a, b as c } from 'x'` | `a`, `b` (alias `c`) |
| `import * as ns from 'x'` | `*` (alias `ns`) |
| `import 'x'` | `(side effect)` |
| `import type { T } from 'x'` | `T` |
| `export { a, b as c } from 'x'` | `a`, `b` (re-export) |
| `export * from 'x'` / `export * as ns from 'x'` | `*` |
| `import('x')` | `*` (dynamic) |
| `const { a, b: c } = require('x')` | `a`, `b` (alias `c`) |
| `const X = require('x')` | `*` (alias `X`) |
| `require('x')` | module |

**Python**

| Form | Bindings captured |
| --- | --- |
| `import x` / `import x as y` | module (alias `y`) |
| `import a.b.c` | module |
| `from m import a, b as c` | `a`, `b` (alias `c`) |
| `from m import (a, b)` | `a`, `b` |
| `from .rel import a` | `a` |
| `from m import *` | `*` |

The scanners are regex-based by deliberate choice — a full parser per language is
not worth the dependency weight for this use case. Every scanner is **total**:
malformed input (unterminated strings, truncated comments, pathological tokens)
yields fewer results, never an exception.

## 3. Module resolution

Bare npm package specifiers (`react`, `express`) are skipped by design — the
graph is about your code, not your dependencies. Everything else resolves:

- **JS/TS** — relative specifiers plus tsconfig `paths`/`baseUrl` from
  `tsconfig.json`/`jsconfig.json` (longest pattern wins, JSONC comments
  tolerated). Tries the literal path, then `.ts/.tsx/.js/.jsx` extensions, then
  `index.*` inside a directory.
- **Python** — resolves dotted modules against the workspace root and relative
  imports against the importing file's package, trying both `mod.py` and
  `mod/__init__.py`.
- **Go** — relative imports resolve against the importing file; module-path
  imports resolve against the matching `go.mod` (every module in the workspace
  is discovered, longest module path first). A package import can point at
  several files (capped at 8).
- **Rust** — `mod x;` resolves to `x.rs` / `x/mod.rs` next to (or under) the
  current module file; `use crate::`/`self::`/`super::` paths are resolved by
  trying the full path, then progressively shorter module prefixes.
- **Java** — a first pass maps `package` + file name to fully-qualified types;
  `import a.b.C` resolves to the declaring file, static imports match their
  type, and `import a.b.*` links every file in the package (capped at 8).
- **C#** — a first pass maps `namespace` declarations to files; `using A.B;`
  links the namespace's files, falling back to parent namespaces.

Resolution probes up to ~9 candidate paths per import, so a per-build
`existsSync` cache prevents re-stat'ing the same path. The cache is scoped to a
single build; a later reload probes fresh.

> **Note:** Vite/webpack-only aliases (e.g. `vite.config` `resolve.alias`)
> are not read; tsconfig `paths`/`baseUrl` is. Bare package imports are always
> skipped.

## 4. Subgraph selection

`subgraph(index, seeds, maxNodes)` chooses which files make it onto the canvas.

1. **Seeds.** Valid seed files start the queue. If no seed is a source file — the
   common case when opening from a `README.md` — the first 10 indexed files are
   used instead.
2. **BFS over imports**, forward and reverse, until the cap is reached.
3. **Top-up.** If the walk drains before the cap, remaining indexed files are
   added.

Step 3 is essential and its absence was a real bug. BFS follows import edges, so
it cannot leave the seed's connected component: a repo whose `frontend/` never
imports its `backend/` would render as the backend alone, with the frontend
silently missing. The top-up guarantees disconnected parts of the workspace still
appear.

### Caps

| Setting | Default | Meaning |
| --- | --- | --- |
| `codeCanvas.initialCap` | 400 | Files pulled in on first render |
| `codeCanvas.maxNodes` | 1000 | Ceiling for expansion and "Load more" |

These are generous because folders open collapsed — node count no longer drives
render cost. A small cap silently truncates whole parts of the tree.

## 5. Folder hierarchy

Every indexed file's ancestor directories, up to the workspace root, become
`group` nodes with `parentId` links. The webview later decides which of them
render as containers and which as collapsed chips.

## 6. Edge construction

Edges are directed **from the file that provides the symbols to the file that
consumes them**. If `a.ts` imports `parse` from `b.ts`, the edge runs
`b.ts → a.ts`: the arrow tip lands on the consumer, and the hover list
("symbols crossing this boundary") reads as the flow out of the file that
defines them.

For each resolved import pair, one `GraphEdge` is emitted carrying `EdgeLink[]`:

```ts
type EdgeLink = {
  symbolName?: string;   // the provided name, when the import is named
  alias?: string;        // the local binding name in the consumer
  kind?: ImportKind;     // named | default | namespace | dynamic | require | …
  sourceLine?: number;   // where the symbol is defined in the source
  targetLine: number;    // where the import statement is in the target
};
```

`sourceLine` is resolved against the source file's **document symbols** via the
LSP, so clicking an edge can jump to the actual definition rather than line 1.
Symbol lookups are cached per file.

These links are what the edge hover tooltip displays, and what
[06 — Descriptions](06-descriptions.md) enumerates.
