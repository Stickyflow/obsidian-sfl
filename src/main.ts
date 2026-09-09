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
// source is read-only. Drag-gesture editing (move/resize/text via
// `stickyflow/interaction`) is still a later milestone — see README.
import {
  type App,
  type Editor,
  type IconName,
  MarkdownRenderChild,
  type MarkdownPostProcessorContext,
  MarkdownView,
  Platform,
  Plugin,
  setIcon,
} from 'obsidian';
import { render } from 'stickyflow';
import { createViewer, type Viewer } from 'stickyflow/viewer';

// --- viewer instance cache --------------------------------------------------
// Obsidian re-runs a code-block processor on many events unrelated to the
// block's own text (typing elsewhere in the note, theme change, metadata
// updates, pane resize, a reading/editing mode switch), each time handing us a
// fresh `el` and a fresh render child. Without a cache, a new viewer is built
// every time and the reader's pan/zoom — plus any in-progress edit, its live
// preview, and the textarea caret — is thrown away. So the live viewer, its DOM
// subtree and the current edit state are kept in a module-level map keyed by
// note path + block start line; a re-render that resolves to the same key
// re-adopts the existing node (reconciling what it shows) instead of
// remounting. Refcounted, with a short deferred destroy, so the "tear down then
// immediately rebuild the same block" churn neither leaks nor thrashes.
interface CacheEntry {
  viewer: Viewer;
  rootEl: HTMLElement;
  mounts: number;
  destroyTimer: number | null;
  /** Tears down the canvas-navigation bridge (see `bindCanvasNav`). */
  unbindNav: () => void;
  /** Disconnects the ResizeObserver that auto-refits an un-touched camera. */
  unbindResize: () => void;
  /** Set once the reader pans or zooms by hand; cleared by "Fit". While false,
   *  a block resize refits the diagram; once true, the camera is left alone. */
  cameraTouched: boolean;
  /** Diagram vs. SFL-source view — the per-block "Code" toggle. */
  showCode: boolean;
  /** In the editing split, whether the live-preview pane is collapsed so the
   *  textarea gets the whole box. */
  previewHidden: boolean;
  /** The SFL text in the note (what a Save writes, what Revert restores to). */
  source: string;
  /** The Code view's working copy. Diverges from `source` while editing; kept
   *  here so an in-progress edit and its preview survive re-render churn. */
  draft: string;
  /** Whether `draft` currently parses — gates Save and the live preview. */
  draftValid: boolean;
  /** The source string the viewer is currently rendering (`source`, or `draft`
   *  while the live preview is on). Avoids redundant `viewer.update()`s. */
  rendered: string;
  /** Debounce handle for pushing `draft` into the viewer as you type. */
  liveTimer: number | null;
  /** Last textarea caret + scroll, restored after a re-render swaps the node. */
  caret: { start: number; end: number; scrollTop: number } | null;
  /** Set on Save so the re-render it triggers puts focus back in the textarea. */
  refocusAfterSave: boolean;
}

const viewerCache = new Map<string, CacheEntry>();
const DESTROY_GRACE_MS = 1500;
const LIVE_PREVIEW_DEBOUNCE_MS = 250;

function hash32(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(sourcePath: string, lineStart: number | undefined, source: string): string {
  // The block's start line is the stable identity across re-renders. Only when
  // it's unavailable (section info not ready) fall back to a source hash.
  return `${sourcePath}::${lineStart != null ? `L${lineStart}` : `H${hash32(source)}`}`;
}

function destroyEntry(key: string, entry: CacheEntry): void {
  if (entry.destroyTimer !== null) {
    window.clearTimeout(entry.destroyTimer);
  }
  if (entry.liveTimer !== null) {
    window.clearTimeout(entry.liveTimer);
  }
  entry.unbindNav();
  entry.unbindResize();
  entry.viewer.destroy();
  entry.rootEl.remove();
  viewerCache.delete(key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// null when the SFL parses, otherwise the parse error's message.
function renderError(source: string): string | null {
  try {
    render(source);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

// --- viewer helpers -------------------------------------------------------------
// `Viewer` exposes `fit()` but no direct zoom method; the wheel-zoom binding
// (`stickyflow.js/src/viewer/interaction/wheel.ts`) acts on a ctrl/⌘ + wheel
// gesture over the <svg>, so a toolbar button zooms by synthesising exactly
// that — the same approach vscode-sfl-preview uses for its zoom buttons.
function zoomBy(viewer: Viewer, factor: number): void {
  const svg = viewer.svg;
  const rect = svg.getBoundingClientRect();
  svg.dispatchEvent(
    new WheelEvent('wheel', {
      deltaY: factor > 1 ? -120 : 120,
      ctrlKey: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      bubbles: true,
      cancelable: true,
    }),
  );
}

const CONTENT_SELECTOR = '[data-sf-id], [data-sf-role], [data-sf-selection-overlay], [data-sf-resize-handle]';

// Two jobs on the viewer's <svg>:
//  1. Plain-drag-to-pan. The viewer only pans on a ctrl/⌘ + drag — a plain drag
//     is deliberately left for the host page to scroll. Inside Obsidian's
//     fixed-height box that's surprising, and it leaves every zoom pinned to
//     the centre. So while a plain left-drag that started on empty canvas is in
//     progress, re-emit each move as the synthetic ctrl+drag the viewer's own
//     pan handler already acts on. Drags that begin on a shape are left alone.
//  2. Report any real pan/zoom to `onCameraChange`, so the caller knows the
//     reader has framed their own view and a block resize shouldn't refit.
function bindCanvasNav(viewer: Viewer, onCameraChange: () => void): () => void {
  const svg = viewer.svg;
  let panning = false;

  const onDown = (event: PointerEvent): void => {
    if (!event.isTrusted || event.button !== 0 || event.ctrlKey || event.metaKey) {
      return;
    }
    if ((event.target as Element | null)?.closest(CONTENT_SELECTOR)) {
      return;
    }
    panning = true;
    event.preventDefault(); // don't start a native text/image selection under the drag
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      /* some targets/pointers don't support capture — panning still works while over the svg */
    }
  };

  const onMove = (event: PointerEvent): void => {
    if (!panning || !event.isTrusted || (event.movementX === 0 && event.movementY === 0)) {
      return;
    }
    onCameraChange();
    svg.dispatchEvent(
      new PointerEvent('pointermove', {
        ctrlKey: true,
        movementX: event.movementX,
        movementY: event.movementY,
        clientX: event.clientX,
        clientY: event.clientY,
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  const onUp = (event: PointerEvent): void => {
    if (!panning) {
      return;
    }
    panning = false;
    try {
      svg.releasePointerCapture(event.pointerId);
    } catch {
      /* mirror of setPointerCapture above */
    }
  };

  const onWheel = (event: WheelEvent): void => {
    if (event.isTrusted && (event.ctrlKey || event.metaKey)) {
      onCameraChange();
    }
  };

  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  svg.addEventListener('wheel', onWheel, { passive: true });
  return () => {
    svg.removeEventListener('pointerdown', onDown);
    svg.removeEventListener('pointermove', onMove);
    svg.removeEventListener('pointerup', onUp);
    svg.removeEventListener('pointercancel', onUp);
    svg.removeEventListener('wheel', onWheel);
  };
}

// A Lucide icon + optional text label inside a <button>. Re-callable to swap
// the icon/label when a toggle button changes state.
function paintButton(button: HTMLElement, icon: IconName, label: string, title = label): void {
  button.empty();
  setIcon(button.createSpan('sfl-btn-icon'), icon);
  if (label) {
    button.createSpan({ cls: 'sfl-btn-label', text: label });
  }
  button.setAttr('aria-label', title);
  button.setAttr('title', title);
}

interface ToolbarHandlers {
  codeShown: boolean;
  onZoomOut(): void;
  onZoomIn(): void;
  onFit(): void;
  onToggleCode(): void;
}

interface Toolbar {
  bar: HTMLElement;
  /** codeShown drives the Code/Diagram button; zoomEnabled the zoom/Fit trio
   *  (a diagram has to be on screen for them to do anything). */
  sync(codeShown: boolean, zoomEnabled: boolean): void;
  /** Show/clear the "unsaved edits parked in the Code view" dot. */
  setDirty(dirty: boolean): void;
}

// Header toolbar: zoom-out  zoom-in  Fit  |  Code/Diagram.
function buildToolbar(handlers: ToolbarHandlers): Toolbar {
  const bar = createDiv('sfl-toolbar');
  const makeButton = (icon: IconName, label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const button = bar.createEl('button');
    paintButton(button, icon, label, title);
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });
    return button;
  };

  const zoomOut = makeButton('zoom-out', '', 'Zoom out', handlers.onZoomOut);
  const zoomIn = makeButton('zoom-in', '', 'Zoom in', handlers.onZoomIn);
  const fit = makeButton('maximize', 'Fit', 'Fit diagram to view', handlers.onFit);
  bar.createSpan('sfl-sep');
  const code = makeButton('code', 'Code', 'Show the SFL source for this block', handlers.onToggleCode);

  return {
    bar,
    sync: (codeShown, zoomEnabled) => {
      paintButton(
        code,
        codeShown ? 'image' : 'code',
        codeShown ? 'Diagram' : 'Code',
        codeShown ? 'Show the rendered diagram' : 'Show the SFL source for this block',
      );
      code.setAttr('aria-pressed', String(codeShown));
      for (const button of [zoomOut, zoomIn, fit]) {
        button.disabled = !zoomEnabled;
      }
    },
    setDirty: (dirty) => code.toggleClass('is-dirty', dirty),
  };
}

// Export / print / PDF render the note into a detached or print-styled
// container where the viewer has no usable size and interactivity is moot —
// keep the static SVG for those so the diagram still shows up in the output.
// Best-effort: matches the class names Obsidian puts on those roots.
function isExportContext(el: HTMLElement): boolean {
  return (
    el.closest('.print, .is-exporting, .markdown-rendered.print') !== null ||
    document.body.classList.contains('is-exporting')
  );
}

function renderStatic(container: HTMLElement, source: string): void {
  container.addClass('sfl-preview--static');
  try {
    // render()'s output is safe to insert via innerHTML: all user-supplied
    // text/ids are XML-escaped and no attribute carries a user URL (see
    // stickyflow.js/README.md, "Security").
    container.innerHTML = render(source).svg;
  } catch (error) {
    container.empty();
    container.createEl('pre', { cls: 'sfl-preview-error', text: `SFL parse error: ${errorMessage(error)}` });
  }
}

const OPEN_FENCE = /^\s*(`{3,}|~{3,})\s*sfl\b/;
const CLOSE_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

const DIAGRAM_HINT = 'Drag to pan · Ctrl/⌘ + scroll to zoom · Fit to reset';

function selectionSummary(owners: Array<{ id: string; kind?: string; label?: string }>): string {
  if (owners.length === 0) {
    return '';
  }
  if (owners.length > 1) {
    return `${owners.length} selected`;
  }
  const [only] = owners;
  const name = only.label ? `"${only.label}"` : only.id;
  return only.kind ? `${name} · ${only.kind}` : name;
}

interface CodeView {
  el: HTMLElement;
  /** Show/hide and switch between the read-only pane, the editing split, and
   *  the editing split with the preview pane collapsed. */
  setMode(showCode: boolean, splitEditing: boolean, previewHidden: boolean): void;
  /** Re-sync the textarea/`<pre>` (and caret) from the current entry state. */
  refresh(): void;
}

// --- render child ------------------------------------------------------------
class SflBlock extends MarkdownRenderChild {
  private key: string | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly source: string,
    private readonly ctx: MarkdownPostProcessorContext,
    private readonly app: App,
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
      this.mountInteractive(container, cached);
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
    const resizeObserver = new ResizeObserver(() => {
      if (!entry.cameraTouched) {
        entry.viewer.fit();
      }
    });
    resizeObserver.observe(rootEl);
    entry.unbindResize = () => resizeObserver.disconnect();

    viewerCache.set(key, entry);
    this.mountInteractive(container, entry);
  }

  private mountInteractive(container: HTMLElement, entry: CacheEntry): void {
    container.addClass('sfl-preview--interactive');

    const editor = this.editableEditorForNote();
    const editable = editor !== null;

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
      codeView.setMode(entry.showCode, splitEditing, entry.previewHidden);
      if (entry.showCode) {
        codeView.refresh();
      }
      toolbar.sync(entry.showCode, diagramVisible);
      toolbar.setDirty(entry.draft !== entry.source);
      paintInfo();
    }

    const codeView = this.buildCodeView(container, entry, editor, reconcile);

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
      onToggleCode: () => {
        entry.showCode = !entry.showCode;
        reconcile();
      },
    });
    header.append(toolbar.bar);

    reconcile();
    // Unsubscribe on this child's unload; a child that re-adopts a cached
    // viewer registers its own listener the same way.
    this.register(entry.viewer.on('selectionChange', paintInfo));
  }

  // The Code view. Editable (textarea + optional live preview + Save/Revert)
  // when the note is open in editing mode — there's an editor to write through;
  // read-only (a <pre>) otherwise. `reconcile` is called after every change so
  // the shared viewer follows the draft.
  private buildCodeView(
    container: HTMLElement,
    entry: CacheEntry,
    editor: Editor | null,
    reconcile: () => void,
  ): CodeView {
    const el = container.createDiv('sfl-code-view');

    if (!editor) {
      el.addClass('is-readonly');
      const pre = el.createEl('pre', { cls: 'sfl-source' });
      const code = pre.createEl('code');
      return {
        el,
        setMode: (showCode) => {
          el.hidden = !showCode;
        },
        refresh: () => code.setText(entry.source),
      };
    }

    const setPreviewLabel = (btn: HTMLButtonElement): void => {
      paintButton(
        btn,
        entry.previewHidden ? 'eye' : 'eye-off',
        entry.previewHidden ? 'Show preview' : 'Hide preview',
      );
      btn.setAttr('aria-pressed', String(!entry.previewHidden));
    };

    const textarea = el.createEl('textarea', {
      cls: 'sfl-source',
      attr: { spellcheck: 'false', 'aria-label': 'SFL source for this block' },
    });
    const errorBar = el.createDiv('sfl-code-error');
    errorBar.hidden = true;
    const footer = el.createDiv('sfl-code-footer');
    const saveBtn = footer.createEl('button', { cls: 'sfl-code-save' });
    paintButton(saveBtn, 'save', 'Save');
    const revertBtn = footer.createEl('button');
    paintButton(revertBtn, 'rotate-ccw', 'Revert');
    const message = footer.createSpan('sfl-code-message');
    const previewBtn = footer.createEl('button', { cls: 'sfl-preview-toggle' });
    setPreviewLabel(previewBtn);
    previewBtn.addEventListener('click', (event) => {
      event.preventDefault();
      entry.previewHidden = !entry.previewHidden;
      setPreviewLabel(previewBtn);
      reconcile();
    });

    const setStatus = (text: string): void => message.setText(text);
    const setError = (text: string | null): void => {
      errorBar.setText(text ?? '');
      errorBar.hidden = !text;
    };
    const paintButtons = (): void => {
      const dirty = entry.draft !== entry.source;
      saveBtn.disabled = !dirty || !entry.draftValid;
      revertBtn.disabled = !dirty;
    };
    const rememberCaret = (): void => {
      entry.caret = {
        start: textarea.selectionStart,
        end: textarea.selectionEnd,
        scrollTop: textarea.scrollTop,
      };
    };
    const restoreCaret = (): void => {
      if (!entry.caret) {
        return;
      }
      try {
        textarea.setSelectionRange(entry.caret.start, entry.caret.end);
        textarea.scrollTop = entry.caret.scrollTop;
      } catch {
        /* selection range out of bounds after an external change — ignore */
      }
    };

    const runLivePreview = (): void => {
      entry.liveTimer = null;
      const error = renderError(entry.draft);
      entry.draftValid = error === null;
      setError(error);
      paintButtons();
      reconcile();
    };
    const cancelLivePreview = (): void => {
      if (entry.liveTimer !== null) {
        window.clearTimeout(entry.liveTimer);
        entry.liveTimer = null;
      }
    };

    const save = (): void => {
      cancelLivePreview();
      // Only arm the post-write refocus when there's an actual change to write —
      // a no-op save triggers no re-render, so the flag would otherwise linger
      // and steal focus on some later unrelated re-render.
      const willWrite = textarea.value.replace(/\s+$/, '') !== entry.source.replace(/\s+$/, '');
      entry.refocusAfterSave = willWrite && document.activeElement === textarea;
      rememberCaret();
      const result = this.saveSource(container, entry, textarea.value);
      if (!result.ok) {
        entry.refocusAfterSave = false;
        setError(result.message);
        return;
      }
      entry.source = result.source;
      entry.draft = result.source;
      entry.draftValid = true;
      textarea.value = result.source;
      setError(null);
      setStatus('Saved.');
      paintButtons();
      reconcile();
    };

    textarea.value = entry.draft;
    restoreCaret(); // re-mount mid-edit: put the caret back where it was
    for (const type of ['keyup', 'mouseup', 'scroll']) {
      textarea.addEventListener(type, rememberCaret);
    }
    textarea.addEventListener('input', () => {
      entry.draft = textarea.value;
      entry.refocusAfterSave = false;
      rememberCaret();
      setStatus('');
      setError(null);
      cancelLivePreview();
      entry.liveTimer = window.setTimeout(runLivePreview, LIVE_PREVIEW_DEBOUNCE_MS);
      paintButtons();
      reconcile();
    });
    textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        save();
      }
    });
    saveBtn.addEventListener('click', save);
    revertBtn.addEventListener('click', () => {
      cancelLivePreview();
      entry.draft = entry.source;
      entry.draftValid = true;
      entry.caret = null;
      textarea.value = entry.source;
      setStatus('');
      setError(null);
      paintButtons();
      reconcile();
    });

    // (Re)mount: re-validate the current draft so the split preview, the Save
    // button and any error are right even after re-render churn.
    entry.draftValid = renderError(entry.draft) === null;
    setError(entry.draftValid || entry.draft === entry.source ? null : renderError(entry.draft));
    paintButtons();
    if (entry.refocusAfterSave) {
      entry.refocusAfterSave = false;
      window.setTimeout(() => {
        textarea.focus();
        restoreCaret();
      }, 0);
    }

    return {
      el,
      setMode: (showCode, splitEditing, previewHidden) => {
        el.hidden = !showCode;
        el.toggleClass('is-split', splitEditing);
        el.toggleClass('is-full', splitEditing && previewHidden);
      },
      refresh: () => {
        if (textarea.value !== entry.draft) {
          textarea.value = entry.draft;
          restoreCaret();
        }
        paintButtons();
      },
    };
  }

  // Whole-body write-back: validate the new SFL, re-locate the fenced block,
  // confirm it still looks like the block this edit started from, then replace
  // just its body through the editor (lands on the undo stack). Returns the
  // normalised source on success, or a message to show on failure.
  private saveSource(
    container: HTMLElement,
    entry: CacheEntry,
    rawText: string,
  ): { ok: true; source: string } | { ok: false; message: string } {
    const next = rawText.replace(/\s+$/, '');
    if (next === entry.source) {
      return { ok: true, source: entry.source };
    }
    const parseError = renderError(next);
    if (parseError) {
      return { ok: false, message: `Won't save — ${parseError}` };
    }

    const info = this.ctx.getSectionInfo(container);
    if (!info) {
      return { ok: false, message: "Couldn't locate this block in the note — reopen it and try again." };
    }
    const editor = this.editableEditorForNote();
    if (!editor) {
      return { ok: false, message: 'Open this note in an editing pane to save.' };
    }
    if (info.lineEnd >= editor.lineCount()) {
      return { ok: false, message: 'The note changed underneath this block — reopen it and try again.' };
    }
    const open = editor.getLine(info.lineStart);
    const close = editor.getLine(info.lineEnd);
    const currentBody = editor.getRange({ line: info.lineStart + 1, ch: 0 }, { line: info.lineEnd, ch: 0 });
    if (
      !OPEN_FENCE.test(open) ||
      !CLOSE_FENCE.test(close) ||
      currentBody.replace(/\s+$/, '') !== entry.source.replace(/\s+$/, '')
    ) {
      return { ok: false, message: 'The note changed underneath this block — reopen it and try again.' };
    }

    editor.replaceRange(`${next}\n`, { line: info.lineStart + 1, ch: 0 }, { line: info.lineEnd, ch: 0 });
    return { ok: true, source: next };
  }

  // The Editor for this note *if* it's open in editing mode. Reading-mode panes
  // report `'preview'` and are treated as no editor — Code view stays read-only.
  private editableEditorForNote(): Editor | null {
    const path = this.ctx.sourcePath;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source') {
        return view.editor;
      }
    }
    return null;
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

export default class ObsidianSflPlugin extends Plugin {
  onload(): void {
    this.registerMarkdownCodeBlockProcessor('sfl', (source, el, ctx) => {
      ctx.addChild(new SflBlock(el, source, ctx, this.app));
    });
  }

  onunload(): void {
    // Snapshot — destroyEntry() deletes from viewerCache as it goes.
    for (const [key, entry] of [...viewerCache]) {
      destroyEntry(key, entry);
    }
  }
}
