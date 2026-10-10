# Publishing to the Visual Studio Marketplace

First release target: **0.2.0** · Item name: `code-canvas.code-canvas`

## Requirements checklist

- [ ] Publisher ID on <https://marketplace.visualstudio.com/manage/publishers> matches `publisher` in `extension/package.json` (`code-canvas`)
- [ ] Azure DevOps PAT with **Marketplace → Manage** scope (see setup below)
- [ ] `npm ci && npm run build` clean
- [ ] `npx vsce package --no-dependencies` succeeds
- [ ] VSIX contains: `extension/dist/extension.js`, `extension/media/`, `extension/package.json`, `extension/readme.md`, `extension/changelog.md`, `extension/LICENSE.txt`, `extension/icon.png`
- [ ] `package.json` fields present: `displayName`, `description`, `version`, `publisher`, `engines.vscode`, `icon`, `repository`, `license`, `categories`, `keywords`
- [ ] `README.md`, `CHANGELOG.md`, `SUPPORT.md`, `LICENSE`, `icon.png` in `extension/`
- [ ] Version bumped since the last publish (the Marketplace rejects duplicate versions)
- [ ] No source maps in the VSIX and no `private: true`

## One-time setup

1. **Confirm the publisher ID.** The manage page URL ends with `/publishers/<id>`. If it is not `code-canvas`, change `publisher` in `extension/package.json`, rebuild, and repackage.
2. **Create a PAT:** <https://dev.azure.com> → *User settings → Personal access tokens → New Token*
   - Organization: **All accessible organizations**
   - Scopes: **Marketplace → Manage** (add **Acquire** only for private extensions)
   - Copy the token; it is shown once.
3. **Authenticate vsce:** `npx vsce login code-canvas` (paste the PAT). For one-off use, pass `-p <PAT>` instead.

## Publish

```bash
# from the repo root
npm ci
npm run build
cd extension
npx vsce publish --no-dependencies -p <PAT>
```

Or publish an already-built VSIX:

```bash
cd extension
npx vsce package --no-dependencies
npx vsce publish --packagePath code-canvas-0.2.0.vsix -p <PAT>
```

## After publishing

- Marketplace page: <https://marketplace.visualstudio.com/items?itemName=code-canvas.code-canvas>
- Install from the Marketplace: `code --install-extension code-canvas.code-canvas`
- README images: vsce rewrites relative links to
  `https://github.com/Ahsaniat/code-canvas/raw/HEAD/...`, so the files under
  `__doc__/demo_photos/` must exist on the default branch (`master`).

## Versioning

- Bump `version` in the root, `extension/` and `webview/` `package.json` together.
- Add a `CHANGELOG.md` entry in `extension/`, rebuild, publish.

## Troubleshooting

| Error | Cause / fix |
| --- | --- |
| `The personal access token verification has failed` | PAT lacks **Marketplace → Manage**, is scoped to a single organization, or expired |
| `Version already exists` | Bump the version in `extension/package.json` |
| `Couldn't detect the repository` | `repository` missing from `package.json` (it is set) |
| Icon rejected | Must be a square PNG, at least 128×128 (`extension/icon.png` is 256×256) |
| README images broken | Files missing on the default branch; check the rewritten `raw/HEAD` URL |
