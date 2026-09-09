# obsidian-sfl

Obsidian plugin: renders fenced ` ```sfl ` code blocks as diagrams inside
notes, using [`stickyflow.js`](../stickyflow.js).

On desktop, each block is a **live viewer** with a **header bar** of controls —
drag anywhere on the canvas to pan, wheel (or the `−` / `+` / `Fit` buttons) to
zoom, click a shape or link to select it (the header shows what's selected). The
block has a `resize: vertical` handle on its bottom edge; while you haven't
panned or zoomed by hand, resizing refits the diagram automatically (`Fit`
re-arms that).

The header **Code** button flips the block between the diagram and its SFL
source; a dot on the button marks unsaved edits parked in the Code view.

- **Editing mode (Live Preview):** an editable textarea, with `Show preview`
  splitting in a live render of your draft above it — type and it updates as you
  go, nothing written to the note. `Save` (or `Ctrl`/`⌘`+`Enter`) commits the
  draft into the fenced block through the note's editor (one step on the undo
  stack, caret preserved across the re-render); `Revert` drops it. An
  unparseable draft holds the last good render and shows the (wrapping) error
  above the footer; `Save` stays disabled until it parses. The preview starts
  collapsed.
- **Reading mode:** the source is shown read-only.

Dragging shapes on the canvas still doesn't edit anything — gesture editing
(move/resize/text via `stickyflow/interaction`) is a later milestone, see
[Known gaps](#known-gaps).

> The `stickyflow/viewer` tier itself only pans on ctrl/⌘ + drag (a plain drag
> is left for a host page to scroll); the plugin bridges plain-drag-to-pan on
> top of it (`bindCanvasNav` in `src/main.ts`) since inside a fixed-height block
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

- **No canvas-gesture editing.** Text edits go through the Code view's textarea
  (whole-body replace via `ctx.getSectionInfo` + `editor.replaceRange`).
  `stickyflow/interaction` — drag-to-move/resize, double-click text edit,
  link-reconnect, `+ Entity` / `+ Link`, delete, with the pure
  `applyMoveChange` / `applyTextChange` / `insertEntity` patchers producing
  surgical (not whole-body) diffs — is not wired in.
  `vscode-sfl-preview/src/{getWebviewHtml,panel}.ts` is the reference. The
  module-level viewer cache in `src/main.ts` (and the `saveSource` write-back)
  is the foundation.
- **Whole-body write-back.** A Code-view save replaces the entire fenced block
  body in one `replaceRange`; there's no per-property patching, and the guard
  against a concurrent external edit is a re-read immediately before the write,
  not a version stamp.
- **No selection sync** between the canvas and the editor cursor, and no
  click-a-shape-to-jump-to-its-source in the Code view
  (`vscode-sfl-preview/src/sflOwnerBlocks.ts` is the port target).
- **No keyboard camera control** — no `+`/`-`/`0` or arrow-pan; only the header
  buttons and wheel.
- **Not published** to the Obsidian community plugin directory — install
  manually as above.
