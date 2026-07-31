# 09 — Development

## Requirements

- Node.js 18+ (Vite 7)
- VS Code 1.102+ (extension engine)
- Git (optional; used for changed-file detection)

## Build

```bash
npm install          # installs both workspaces
npm run build        # webview first, then extension
```

Outputs:

- `extension/media/assets/*` — webview bundle (Vite)
- `extension/dist/extension.js` — extension bundle (tsup)

> `webview/vite.config.ts` sets `emptyOutDir: true`, so a webview build wipes
> `extension/media/`. Everything there is generated — never hand-edit it.

## Typecheck

```bash
npx tsc --noEmit -p webview/tsconfig.json
npx tsc --noEmit -p extension/tsconfig.json
```

Both must exit 0. There is no test runner in the repo; the harnesses below cover
the algorithmic core.

## Debug

Open the repo in VS Code and press **F5** to launch an Extension Development
Host, then run **Code Canvas: Open**.

Webview devtools: **Developer: Open Webview Developer Tools** from the command
palette.

## Package & install

```bash
npm run package                                   # → extension/code-canvas-0.0.1.vsix
code --install-extension extension/code-canvas-0.0.1.vsix
```

**Reload the VS Code window after installing.** `--install-extension` does not
refresh an already-open window, and the most common "my change did nothing"
report is a stale window.

To confirm what actually shipped:

```bash
unzip -p extension/code-canvas-0.0.1.vsix extension/media/index.html | grep -o 'assets/[^"]*'
ls extension/media/assets/
```

The hashes should match. `vscode:prepublish` runs only the **extension** build,
not the webview — always `npm run build` at the root before packaging.

## Offline harnesses

The algorithmic core is verifiable without launching VS Code, which is how the
layout and indexing invariants are checked.

### Running the real indexer with a `vscode` stub

`graph.ts` imports `vscode`, but only for configuration, workspace folders and
symbol lookup. Alias it to a stub and the whole pipeline runs in plain Node:

```js
// stub/vscode.js
export const workspace = {
  getConfiguration: () => ({ get: (k) => (k === 'excludeGlobs' ? [...] : undefined) }),
  workspaceFolders: [{ uri: { fsPath: process.env.CC_ROOT } }],
};
export const Uri = { file: (p) => ({ fsPath: p }) };
export const SymbolKind = { Class: 4, Function: 11, Method: 5 };
export const commands = { executeCommand: async () => [] };
```

```bash
npx esbuild extension/src/graph.ts --bundle --format=cjs --platform=node \
  --outfile=/tmp/graph.cjs --alias:vscode=/path/to/stub/vscode.js
```

Use `--format=cjs`; the ESM output fails on `fast-glob`'s dynamic `require`.

This lets you answer questions like "why is this folder missing?" directly:

```js
const index = await buildIndex(root);
const g = await subgraph(index, [root + '/README.md'], 400);
console.log(g.nodes.length, g.edges.length);
```

### Auditing the layout

Bundle `webview/src/layout/radial.ts` (no external deps) and assert the
invariants over generated scenarios:

```bash
npx esbuild webview/src/layout/radial.ts --bundle --format=esm --outfile=/tmp/radial.mjs
```

Assert per scenario:

1. **Zero pairwise overlaps** among all placed boxes.
2. **Orphans strictly inside** the innermost connected ring.
3. Sane maximum radius (catches the single-ring inflation regression).

Cover uniform sizes, varied sizes, one huge expanded folder, all-orphans, a
single node, and dense graphs — with several seeds each.

### Checking the projection

Bundle `webview/src/model/graphModel.ts` and chain it onto the indexer output to
see exactly what the canvas would show:

```js
const model = buildModel(g.nodes, g.edges);
const p = projectGraph(model, initialExpansion(model));
console.log(p.nodes.length, p.edges.length);
```

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Changes don't appear after installing | Window not reloaded, or webview not rebuilt before packaging |
| Whole folders missing from the graph | `initialCap` too low, or an `excludeGlobs` pattern too broad |
| Very few edges | Imports use TS `paths`/bundler aliases — not resolved (see [02](02-indexing.md)) |
| Everything sits in the centre | Projection has no edges; see [03](03-graph-model.md) |
| Layout is Dagre when ELK was chosen | ELK worker failed to load — check the CSP allows `worker-src blob:` |
| Code cards won't scroll | The scroll container lost its `nowheel` class; React Flow is eating the wheel event |
| `grep` finds nothing in `graphModel.ts` | The file contains literal NUL bytes used as map-key delimiters, so `grep` treats it as binary. Use `grep -a`. |

## Known limitations

- **Languages** — JS/TS/JSX/TSX and Python only.
- **Module resolution** — relative specifiers only; TS `paths` and bundler
  aliases are not resolved, and bare package imports are skipped by design.
- **Descriptions** — heuristic, not model-generated.
- **React Flow v11** — a v12 (`@xyflow/react`) migration would allow
  `NodeResizer` and retire remaining manual geometry, but has not been done.

## Code conventions

- Comments explain **why**, particularly where code is structured to make a bug
  class impossible. Those comments are load-bearing — read
  [the invariants list](README.md#a-note-on-invariants) before rewriting them.
- Parsers and description functions are **total**: degraded output, never a throw.
- Prefer deleting replaced code over leaving it orphaned.
