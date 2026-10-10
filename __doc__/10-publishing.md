# Publishing to the Visual Studio Marketplace

Current release: **0.2.2** · Item name: `ahsaniat.code-canvas-oss`

## Requirements checklist

- [ ] Publisher ID on <https://marketplace.visualstudio.com/manage/publishers> matches `publisher` in `extension/package.json` (`ahsaniat`)
- [ ] Azure DevOps PAT with **Marketplace → Manage** scope (see setup below)
- [ ] `npm ci && npm run build` clean
- [ ] `npx vsce package --no-dependencies` succeeds
- [ ] VSIX contains: `extension/dist/extension.js`, `extension/media/`, `extension/package.json`, `extension/readme.md`, `extension/changelog.md`, `extension/LICENSE.txt`, `extension/icon.png`
- [ ] `package.json` fields present: `displayName`, `description`, `version`, `publisher`, `engines.vscode`, `icon`, `repository`, `license`, `categories`, `keywords`
- [ ] `README.md`, `CHANGELOG.md`, `SUPPORT.md`, `LICENSE`, `icon.png` in `extension/`
- [ ] Version bumped since the last publish (the Marketplace rejects duplicate versions)
- [ ] No source maps in the VSIX and no `private: true`
- [ ] For CD: `VSCE_PAT` (and optional `OVSX_PAT`) secrets plus the `marketplace` environment exist; release tags are `v<version>`

## One-time setup

1. **Confirm the publisher ID.** The manage page URL ends with `/publishers/<id>`. The publisher is set to `ahsaniat`; if that ever changes, update `publisher` in `extension/package.json` and repackage.
2. **Create a PAT:** <https://dev.azure.com> → *User settings → Personal access tokens → New Token*
   - Organization: **All accessible organizations**
   - Scopes: **Marketplace → Manage** (add **Acquire** only for private extensions)
   - Copy the token; it is shown once.
3. **Authenticate vsce:** `npx vsce login ahsaniat` (paste the PAT). For one-off use, pass `-p <PAT>` instead.

## Publish

### Automated (CD)

`.github/workflows/release.yml` publishes when a GitHub release is published:

1. checks out the released tag, `npm ci`, full build
2. **version guard** — the tag must be `v<version>` or `<version>` and match `extension/package.json`
3. packages and publishes the VSIX to the Visual Studio Marketplace (`VSCE_PAT`)
4. publishes to Open VSX if `OVSX_PAT` is set (otherwise skips)
5. attaches the VSIX to the GitHub release

One-time setup for CD:

- Repository secrets: `VSCE_PAT` (required, same PAT as below) and `OVSX_PAT`
  (optional; create at <https://open-vsx.org> → *Settings → Access Tokens*)
- Recommended: Settings → Environments → new environment **`marketplace`** with a
  required reviewer, so releasing needs an approval click
- Release tag convention: **`v<version>`** (e.g. `v0.2.2`). The guard rejects anything else.

### Manual fallback

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
npx vsce publish --packagePath code-canvas-oss-0.2.2.vsix -p <PAT>
```

## After publishing

- Marketplace page: <https://marketplace.visualstudio.com/items?itemName=ahsaniat.code-canvas-oss>
- Install from the Marketplace: `code --install-extension ahsaniat.code-canvas-oss`
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
| `The extension '<name>' already exists in the Marketplace` | Extension names are globally unique; pick another `name` (current: `code-canvas-oss`) |
| `Couldn't detect the repository` | `repository` missing from `package.json` (it is set) |
| Icon rejected | Must be a square PNG, at least 128×128 (`extension/icon.png` is 256×256) |
| README images broken | Files missing on the default branch; check the rewritten `raw/HEAD` URL |
