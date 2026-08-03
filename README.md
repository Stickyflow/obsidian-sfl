# obsidian-sfl

Obsidian plugin: renders fenced ` ```sfl ` code blocks as SVG diagrams inside
notes, using [`stickyflow.js`](../stickyflow.js)'s static tier
(`render(sfl) → svg`). Read-only prototype — see [Known gaps](#known-gaps).

Sibling to [`packages/vscode-sfl-preview`](../vscode-sfl-preview), which does
the equivalent job for VS Code. Unlike that package, this one depends on
`stickyflow` as a normal bundled dependency (`file:../stickyflow.js`) rather
than copying `dist/` in as static media — an Obsidian plugin runs directly in
the app's own renderer process, so there's no separate webview/extension-host
split to work around.

## Build

```bash
cd ../stickyflow.js && npm run build   # build the core library first
cd ../obsidian-sfl && npm install && npm run build
```

`npm run build` typechecks (`tsc -noEmit`) then bundles `src/main.ts` (+ the
`stickyflow` dependency) into a single `main.js` via esbuild.

**Rebuild whatever changed, in order.** Like `vscode-sfl-preview`, this
package pulls in `stickyflow.js/dist` at bundle time, not at import time —
`npm run build` here does *not* notice if `stickyflow.js/src` changed since
its last build. Always `npm run build` in `stickyflow.js` first.

## Test in a real vault

```bash
mkdir -p "<vault>/.obsidian/plugins/obsidian-sfl"
cp manifest.json main.js styles.css "<vault>/.obsidian/plugins/obsidian-sfl/"
```

Then in Obsidian: **Settings → Community plugins** → enable "SFL Preview"
(may need a restart the first time a plugin is dropped in manually). A note
with a fenced ` ```sfl ` block should render as an SVG.

Obsidian doesn't hot-reload plugins — after rebuilding, re-copy `main.js` and
run **Developer: Reload app without saving** (Ctrl/Cmd+P) or restart.

## Known gaps

- **No interactive tier.** `stickyflow/viewer` (pan/zoom/select) and
  `stickyflow/interaction` (drag/resize/text-edit/link-reconnect, the pure
  `applyMoveChange`/`applyTextChange`/`insertEntity` patchers) aren't wired
  in — this only calls the static `render()`. `vscode-sfl-preview/src/panel.ts`'s
  `sfl/edit` handler is the reference for how editing round-trips back into a
  host document; here that would mean writing through Obsidian's
  `MarkdownView.editor` (CM6) instead of a VS Code `WorkspaceEdit`.
- **No selection sync, no canvas-side create.**
- **Not published** to the Obsidian community plugin directory — install
  manually as above.
