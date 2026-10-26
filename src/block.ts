// --- render child ------------------------------------------------------------
// One `SflBlock` per rendered ```sfl fence. Desktop gets the interactive
// viewer (re-adopted from the cache across re-renders) plus header, toolbar and
// Code view; mobile and export contexts get the static SVG.
import { type App, type MarkdownPostProcessorContext, MarkdownRenderChild, Platform } from 'obsidian';
import { createViewer, type Viewer } from 'stickyflow/viewer';
import { type CacheEntry, cacheKey, DESTROY_GRACE_MS, destroyEntry, viewerCache } from './cache';
import { bindCanvasNav, bindKeyboardCamera, zoomBy } from './camera';
import { buildCodeView } from './codeView/codeView';
import { type ActiveBlock, adoptActiveBlock, notifyActiveBlock, setActiveBlock } from './palette/activeBlock';
import { SflPreviewModal } from './previewModal';
import { errorMessage, isExportContext, renderError, renderStatic } from './render';
import { buildToolbar, DIAGRAM_HINT, selectionSummary } from './toolbar';
import { editableEditorForNote, writeBlockSource } from './writeBack';

export class SflBlock extends MarkdownRenderChild {
  private key: string | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly source: string,
    private readonly ctx: MarkdownPostProcessorContext,
    private readonly app: App,
    private readonly openPalette: () => void,
  ) {
    super(containerEl);
  }

  onload(): void {
    const container = this.containerEl;
    container.addClass('sfl-preview');

    if (Platform.isMobile || isExportContext(container)) {
      renderStatic(container, this.source);
      return;
    }

    const key = cacheKey(this.ctx.sourcePath, this.ctx.getSectionInfo(container)?.lineStart, this.source);
    this.key = key;

    const cached = viewerCache.get(key);
    if (cached) {
      if (cached.destroyTimer !== null) {
        window.clearTimeout(cached.destroyTimer);
        cached.destroyTimer = null;
      }
      cached.mounts++;
      // The block's text changed underneath this viewer (edited by hand in the
      // note, a sync, a git checkout). Follow it; a clean draft follows too, a
      // dirty one is left for the Save guard to reconcile.
      if (this.source !== cached.source) {
        const draftWasClean = cached.draft === cached.source;
        cached.source = this.source;
        if (draftWasClean) {
          cached.draft = this.source;
          cached.draftValid = true;
        }
      }
      this.mountInteractive(container, cached, key);
      return;
    }

    const rootEl = createDiv('sfl-viewer-root');
    let viewer: Viewer;
    try {
      viewer = createViewer({
        container: rootEl,
        source: this.source,
        interactive: true,
        selectable: true,
        diagramId: key,
      });
    } catch (error) {
      rootEl.remove();
      this.key = null;
      container.createEl('pre', { cls: 'sfl-preview-error', text: `SFL parse error: ${errorMessage(error)}` });
      return;
    }

    viewer.on('ready', () => viewer.fit());
    const entry: CacheEntry = {
      viewer,
      rootEl,
      mounts: 1,
      destroyTimer: null,
      unbindNav: () => {},
      unbindKeyboard: () => {},
      unbindResize: () => {},
      cameraTouched: false,
      showCode: false,
      // Default the editing split to textarea-only — you open Code to write
      // SFL; reveal the render with "Show preview" when you want to check it.
      previewHidden: true,
      source: this.source,
      draft: this.source,
      draftValid: true,
      rendered: this.source,
      liveTimer: null,
      caret: null,
      refocusAfterSave: false,
    };
    entry.unbindNav = bindCanvasNav(viewer, () => {
      entry.cameraTouched = true;
    });
    entry.unbindKeyboard = bindKeyboardCamera(rootEl, entry);
    const resizeObserver = new ResizeObserver(() => {
      if (!entry.cameraTouched) {
        entry.viewer.fit();
      }
    });
    resizeObserver.observe(rootEl);
    entry.unbindResize = () => resizeObserver.disconnect();

    viewerCache.set(key, entry);
    this.mountInteractive(container, entry, key);
  }

  private mountInteractive(container: HTMLElement, entry: CacheEntry, key: string): void {
    container.addClass('sfl-preview--interactive');

    const editable = editableEditorForNote(this.app, this.ctx.sourcePath) !== null;

    const header = container.createDiv('sfl-header');
    const info = header.createDiv('sfl-header-info');
    container.append(entry.rootEl);

    // reconcile() is the single place that decides what the viewer shows and
    // which panes are visible, from the current entry state. Declared before
    // buildCodeView so its handlers can call it; called once at the end.
    function reconcile(): void {
      const splitEditing = entry.showCode && editable;
      const previewOn = splitEditing && !entry.previewHidden;
      // With the live preview on, show the draft when it parses; when it
      // doesn't, hold the last good render rather than snapping back to the
      // saved source on every half-typed keystroke. With the preview collapsed
      // (or in Diagram view) the viewer isn't visible, so leave it be — it's
      // refreshed the moment it's shown again. Diagram view always shows
      // exactly what's in the note.
      let want = entry.source;
      if (previewOn) {
        want = entry.draftValid ? entry.draft : entry.rendered;
      } else if (splitEditing) {
        want = entry.rendered;
      }
      if (want !== entry.rendered) {
        try {
          entry.viewer.update({ source: want });
          entry.rendered = want;
        } catch {
          /* keep the last good render; parse errors surface in the code view */
        }
      }
      const diagramVisible = !entry.showCode || previewOn;
      entry.rootEl.hidden = !diagramVisible;
      // The viewer paints resize handles and quick-duplicate bubbles on every
      // selection; they're only meaningful while editing (see styles.css).
      container.toggleClass('is-editing', splitEditing);
      codeView.setMode(entry.showCode, splitEditing, entry.previewHidden);
      if (entry.showCode) {
        codeView.refresh();
      }
      toolbar.sync(entry.showCode, diagramVisible);
      toolbar.setDirty(entry.draft !== entry.source);
      paintInfo();
    }

    const codeView = buildCodeView(container, entry, {
      save: editable ? (text) => writeBlockSource(this.app, this.ctx, container, entry.source, text) : null,
      reconcile,
      register: (cleanup) => this.register(cleanup),
    });

    function paintInfo(): void {
      const summary = selectionSummary(entry.viewer.getSelection());
      if (summary) {
        info.setText(summary);
        info.removeClass('is-hint');
        return;
      }
      info.addClass('is-hint');
      info.setText(
        !entry.showCode
          ? DIAGRAM_HINT
          : editable
            ? 'Editing — Save writes the block back into the note'
            : 'Read-only — open this note in editing mode to change it',
      );
    }

    const toolbar = buildToolbar({
      codeShown: entry.showCode,
      onZoomOut: () => {
        entry.cameraTouched = true;
        zoomBy(entry.viewer, 1 / 1.2);
      },
      onZoomIn: () => {
        entry.cameraTouched = true;
        zoomBy(entry.viewer, 1.2);
      },
      onFit: () => {
        entry.cameraTouched = false;
        entry.viewer.fit();
      },
      onExpand: () => {
        new SflPreviewModal(this.app, entry.rendered, `${key}:modal`).open();
      },
      onToggleCode: () => {
        entry.showCode = !entry.showCode;
        reconcile();
      },
      onPalette: editable
        ? () => {
            setActiveBlock(palette);
            this.openPalette();
          }
        : null,
    });
    header.append(toolbar.bar);

    // The palette's handle on this block (see palette/activeBlock.ts). Edits
    // land where Save would put them: straight into the note when there's no
    // pending draft, into the Code view draft when there is one.
    const palette: ActiveBlock = {
      key,
      noteName: this.ctx.sourcePath.split('/').pop()?.replace(/\.md$/, '') ?? this.ctx.sourcePath,
      viewer: entry.viewer,
      text: () => entry.draft,
      blockedReason: () => {
        if (!editable) {
          return 'Open this note in editing mode to change the diagram.';
        }
        if (entry.draft !== entry.source && !entry.showCode) {
          return 'This block has unsaved edits in its Code view. Save or revert them first.';
        }
        return null;
      },
      apply: (next, selectIds) => {
        const parseError = renderError(next);
        if (parseError) {
          return `Couldn't add that: ${parseError}`;
        }
        if (entry.draft !== entry.source) {
          entry.draft = next;
          entry.draftValid = true;
        } else {
          const result = writeBlockSource(this.app, this.ctx, container, entry.source, next);
          if (!result.ok) {
            return result.message;
          }
          entry.source = result.source;
          entry.draft = result.source;
          entry.draftValid = true;
          next = result.source;
        }
        // Show the new owner right away, flashed, instead of waiting for the
        // note's re-render (which then finds the viewer already up to date).
        if (!entry.showCode || !entry.previewHidden) {
          entry.viewer.update({ source: next, highlightChanges: true });
          entry.rendered = next;
        }
        reconcile();
        entry.viewer.select(selectIds);
        return null;
      },
    };
    adoptActiveBlock(palette);

    reconcile();
    // Unsubscribe on this child's unload; a child that re-adopts a cached
    // viewer registers its own listener the same way.
    this.register(entry.viewer.on('selectionChange', paintInfo));
    this.register(
      entry.viewer.on('selectionChange', () => {
        if (editable && entry.viewer.getSelection().length > 0) {
          setActiveBlock(palette);
        } else {
          notifyActiveBlock(key);
        }
      }),
    );
  }

  onunload(): void {
    if (this.key === null) {
      return;
    }
    const entry = viewerCache.get(this.key);
    if (!entry) {
      return;
    }
    entry.mounts = Math.max(0, entry.mounts - 1);
    if (entry.mounts > 0) {
      return;
    }
    const key = this.key;
    entry.destroyTimer = window.setTimeout(() => {
      const current = viewerCache.get(key);
      if (current && current.mounts === 0) {
        destroyEntry(key, current);
      }
    }, DESTROY_GRACE_MS);
  }
}
