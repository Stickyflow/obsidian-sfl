# obsidian-sfl

Obsidian plugin: renders fenced ` ```sfl ` code blocks as diagrams inside
notes, using [`stickyflow.js`](../stickyflow.js).

On desktop, each block is a **live viewer** — drag anywhere on the canvas to
pan, wheel (or the `−` / `+` / `Fit` toolbar) to zoom, click a shape or link to
select it. A **Code** button on the toolbar flips the block between the diagram
and its raw SFL source (selectable, so you can copy it). The block has a
`resize: vertical` handle on its bottom edge. It stays **read-only**: no canvas
gesture writes back to the note (edit mode is the next milestone — see
[Known gaps](#known-gaps)).

> The `stickyflow/viewer` tier itself only pans on ctrl/⌘ + drag (a plain drag
> is left for a host page to scroll); the plugin bridges plain-drag-to-pan on
> top of it (`bindDragPan` in `src/main.ts`) since inside a fixed-height block
> that's what a reader expects.

On **mobile**, and in **export / print / PDF**, it falls back to the static
tier (`render(sfl) → svg`) — the viewer needs a live, sized DOM, and drag-pan
would fight the note's touch-scroll on a phone.

Sibling to [`packages/vscode-sfl-preview`](../vscode-sfl-preview), which does
the equivalent job for VS Code. Unlike that package, this one depends on
`stickyflow` as a normal bundled dependency (`file:../stickyflow.js`) rather
than copying `dist/` in as static media — an Obsidian plugin runs directly in
the app's own renderer process, so there's no separate webview/extension-host
split to work around. `stickyflow/viewer` resolves through the same `file:`
link (`tsconfig` uses `"moduleResolution": "bundler"` so `tsc` reads the
package's `exports` map the way esbuild does).

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
with a fenced ` ```sfl ` block should render as an interactive diagram.

Obsidian doesn't hot-reload plugins — after rebuilding, re-copy `main.js` and
run **Developer: Reload app without saving** (Ctrl/Cmd+P) or restart.

## Known gaps

- **No edit-mode / interaction tier.** `stickyflow/viewer` (pan/zoom/select) is
  wired in; `stickyflow/interaction` (drag/resize/text-edit/link-reconnect, the
  pure `applyMoveChange`/`applyTextChange`/`insertEntity` patchers, `+ Entity` /
  `+ Link`, delete) is not. Editing an entity still means editing the SFL text.
  The plan is a per-block **Edit / Done** toggle that binds the interaction tier
  and patches each committed gesture back into the fenced block's body via
  `ctx.getSectionInfo` + `MarkdownView.editor.replaceRange` (on Obsidian's undo
  stack) — `vscode-sfl-preview/src/{getWebviewHtml,panel}.ts` is the reference,
  writing through the CM6 editor instead of a VS Code `WorkspaceEdit`. The
  module-level viewer cache in `src/main.ts` is the foundation its remount guard
  needs.
- **No selection sync** between the canvas and the editor cursor
  (`vscode-sfl-preview/src/sflOwnerBlocks.ts` is the port target).
- **No resize refit.** Dragging the block's `resize` handle stretches the SVG;
  the viewport doesn't refit until you click `Fit`.
- **Not published** to the Obsidian community plugin directory — install
  manually as above.
