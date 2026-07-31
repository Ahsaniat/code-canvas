# 06 — Descriptions

`extension/src/describe.ts`, `extension/src/meta.ts`,
`webview/src/components/DescriptionPanel.tsx`, `webview/src/text.ts`

Every file and folder gets a description automatically. Users can override any of
them, and an override is never lost.

## Generation is heuristic, not AI

There is **no LLM in-process**. Descriptions are derived from what is statically
observable, using data the indexing pass already captured — no extra disk reads.

Every function in `describe.ts` is total: malformed input yields a degraded
summary, never an exception. A description is a nicety and must never fail graph
delivery.

## File descriptions

Structured so the **first sentence stands alone**, because the panel shows only
up to the first full stop until expanded.

```
<sentence 1>            doc comment, else "<Lang> module exporting `a`, `b`."
Exports `a`, `b`.       only when sentence 1 was a doc comment
Imported by N files.
Imports: 1. `X` from a.js, 2. `Y` from b.js, …
```

Real output:

```
JavaScript module with no top-level exports. Imports: 1. `AISuggestion` from
aiSuggestion.js, 2. `AITask` from aiTask.js, 3. `ChatMessage` from
chatMessage.js, … 11. `WorkoutRoutine` from workoutRoutine.js.
```

Collapsed, that reads simply:

```
JavaScript module with no top-level exports.
```

### Why imports are enumerated

A bare degree count ("imports 7 modules") tells the reader nothing actionable.
The enumeration names **which symbols, from which file**, for every resolved
import.

The list is built from the graph edges, so the names shown are the ones actually
resolved — not a re-parse of specifier text.

### Naming a binding

- **Named import** → the exported symbol name.
- **Default / namespace / `const X = require(…)`** → there is no exported name to
  quote, so the **local alias** is used. `const User = require('./user')` reads as
  `` `User` from user.js `` rather than the useless "whole module".
- Only when neither exists does it fall back to `whole module`.

### Doc extraction

The leading JSDoc/block comment or Python module docstring, first sentence only.
Blocks matching a boilerplate pattern — copyright, SPDX, licence text,
`eslint-disable`, `@ts-nocheck`, `prettier-ignore` — are skipped rather than
presented as a description.

File descriptions are **not** length-clamped: the full text is only ever revealed
by expanding the panel, and truncating it there would defeat the enumeration.

## Folder descriptions

```
Contains 4 files and 3 subfolders (142 files in total), mostly TypeScript.
6 incoming links, 11 outgoing.
```

### Counts are reported at a consistent depth

Direct children — what you see on expanding — with the deep total added only when
nesting actually hides files.

Mixing a recursive file count with a direct subfolder count reads as a plain
contradiction on any nested tree, and did.

### "mostly X" requires an actual majority

`mostly` asserts a majority, so it is only said when one language holds ≥ 60%.
A near-even split is reported as `mixed X and Y`. Ranking by plurality and
calling the winner "mostly" overstates a 34/33/33 tree.

Language buckets merge variants: `.ts`/`.tsx` → TypeScript, `.js`/`.jsx` →
JavaScript.

### No "key exports" line

Deliberately removed. At folder level, any ranking of a whole tree's exports is a
guess, and it pushed the genuinely useful counts out of the collapsed one-liner.

## Display

### Collapsed vs expanded

`firstSentence()` in `webview/src/text.ts` is shared by the description panel and
the folder node body.

It guards the obvious false positives, so `Imports: 1. \`x\` from util.ts` is
never cut at the enumerator or the file extension:

- a full stop only terminates when whitespace or end-of-string follows (rules out
  `util.ts` and `3.14`)
- a trailing `1.` style enumerator is not a sentence end
- an ellipsis is a continuation

| Surface | Collapsed | Expanded |
| --- | --- | --- |
| File node — description panel | first sentence, single line, `more…` affordance | full text, click to edit |
| Folder node body | first sentence, single line, ellipsised | — |

## Persistence & the override rule

Stored in `.code-canvas/meta.json` at the workspace root:

```json
{
  "version": 1,
  "files": {
    "/abs/path/file.js": {
      "autoDescription": "JavaScript module … Imports: 1. `User` from user.js.",
      "autoDescriptionKind": "file",
      "description": "optional user-authored text",
      "tags": ["api"],
      "collapsed": false,
      "descriptionExpanded": false
    }
  }
}
```

**Two separate fields, and that is the whole safety mechanism.**

- Regeneration writes **only** `autoDescription`.
- `description` is user-authored and is never written by generation.
- The UI prefers `description`, falling back to `autoDescription` (shown italic
  with an `auto` badge).

`mergeAutoDescriptions()` skips no-op writes entirely, so an unchanged workspace
does not rewrite the file. Description generation is wrapped so a read-only
workspace cannot break the panel.

Editing seeds the textarea with the generated text, so refining it is one
keystroke away — but nothing is persisted until the edit is committed.
