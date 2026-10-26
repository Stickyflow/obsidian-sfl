// Renders fenced ```sfl code blocks as a live, interactive diagram using
// stickyflow.js's viewer tier (`createViewer` from `stickyflow/viewer` — pan,
// wheel zoom, click-to-select, hover). Desktop only: on mobile, and in export /
// print / PDF contexts, it falls back to the static `render()` → SVG path — the
// viewer needs a live, sized DOM, and its drag-pan would fight the note's own
// touch-scroll on a phone.
//
// A header bar carries the controls. The "Code" button flips a block between
// the diagram and its SFL source. When the note is in editing mode (Live
// Preview) that opens a split: the SFL in an editable textarea, with an
// optional *live* render of the draft above it (nothing is written to the note
// yet). "Save" commits the draft into the fenced block through the note's
// editor (one step on the undo stack); "Revert" drops it. In Reading mode the
// source is read-only. In editing mode the canvas is editable too: drag,
// resize, relink, text, delete and nudge gestures from
// `stickyflow/interaction` (gestures.ts), plus the SFL palette side panel.
//
// Layout:
//   main.ts              plugin entry: registers the ```sfl processor
//   block.ts             SflBlock, the per-fence render child (wires it all up)
//   cache.ts             viewer instance cache that survives re-renders
//   camera.ts            pan/zoom bridges and keyboard camera on the viewer
//   gestures.ts          canvas gesture editing (move, resize, relink, ...)
//   toolbar.ts           header buttons, hint and selection summary
//   previewModal.ts      the "Expand" bigger-preview modal
//   render.ts            static SVG fallback and parse-error helpers
//   writeBack.ts         Save: writing a draft into the note through the editor
//   codeView/codeView.ts the Code view (read-only <pre> or editable textarea)
//   codeView/highlight.ts SFL syntax highlighting
//   codeView/ownerLines.ts canvas click to source-lines reveal
//   palette/paletteView.ts the SFL palette side panel (extend a diagram)
//   palette/edits.ts      the palette's SFL text transforms
//   palette/activeBlock.ts which block the palette is working on
import { Platform, Plugin, type WorkspaceLeaf } from 'obsidian';
import { SflBlock } from './block';
import { destroyEntry, viewerCache } from './cache';
import { PALETTE_VIEW_TYPE, SflPaletteView } from './palette/paletteView';

export default class ObsidianSflPlugin extends Plugin {
  onload(): void {
    this.registerMarkdownCodeBlockProcessor('sfl', (source, el, ctx) => {
      ctx.addChild(new SflBlock(el, source, ctx, this.app, () => this.openPalette()));
    });

    // The palette only drives interactive (desktop) blocks.
    if (Platform.isMobile) {
      return;
    }
    this.registerView(PALETTE_VIEW_TYPE, (leaf) => new SflPaletteView(leaf));
    this.addRibbonIcon('shapes', 'Open SFL palette', () => this.openPalette());
    this.addCommand({
      id: 'open-palette',
      name: 'Open SFL palette',
      callback: () => this.openPalette(),
    });
  }

  // Not workspace.revealLeaf(): it's typed @since 1.7.2, newer than our
  // minAppVersion. Expanding the right sidebar and activating the leaf does
  // the same on every version we support.
  private openPalette(): void {
    const { workspace } = this.app;
    const reveal = (leaf: WorkspaceLeaf): void => {
      workspace.rightSplit.expand();
      workspace.setActiveLeaf(leaf, { focus: true });
    };
    const open = workspace.getLeavesOfType(PALETTE_VIEW_TYPE)[0];
    if (open) {
      reveal(open);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    void leaf?.setViewState({ type: PALETTE_VIEW_TYPE, active: true }).then(() => reveal(leaf));
  }

  onunload(): void {
    // Snapshot — destroyEntry() deletes from viewerCache as it goes.
    for (const [key, entry] of [...viewerCache]) {
      destroyEntry(key, entry);
    }
  }
}
