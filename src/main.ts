// Renders fenced ```sfl code blocks as a live, interactive diagram using
// stickyflow.js's viewer tier (`createViewer` from `stickyflow/viewer` — pan,
// wheel zoom, click-to-select, hover). Desktop only: on mobile, and in export /
// print / PDF contexts, it falls back to the static `render()` → SVG path — the
// viewer needs a live, sized DOM, and its drag-pan would fight the note's own
// touch-scroll on a phone.
//
// A toolbar "Code" button flips a block between the diagram and its SFL source.
// When the note is in editing mode (Live Preview) that source is an editable
// textarea: Save writes the new text back into the fenced block through the
// note's editor (on Obsidian's undo stack) and re-renders in place. In Reading
// mode the source is shown read-only. Drag-gesture editing (move/resize/text
// via `stickyflow/interaction`) is still a later milestone — see README.
import {
  type App,
  type Editor,
  MarkdownRenderChild,
  type MarkdownPostProcessorContext,
  MarkdownView,
  Platform,
  Plugin,
} from 'obsidian';
import { render } from 'stickyflow';
import { createViewer, type Viewer } from 'stickyflow/viewer';

// --- viewer instance cache --------------------------------------------------
// Obsidian re-runs a code-block processor on many events unrelated to the
// block's own text (typing elsewhere in the note, theme change, metadata
// updates, pane resize, a reading/editing mode switch), each time handing us a
// fresh `el` and a fresh render child. Without a cache, a new viewer is built
// every time and the reader's pan/zoom — plus any in-progress edit in the Code
// view — is thrown away. So the live viewer, its DOM subtree and the current
// edit state are kept in a module-level map keyed by note path + block start
// line; a re-render that resolves to the same key re-adopts the existing node
// (calling `viewer.update()` if the source changed underneath) instead of
// remounting. Refcounted, with a short deferred destroy, so the "tear down then
// immediately rebuild the same block" churn neither leaks nor thrashes.
interface CacheEntry {
  viewer: Viewer;
  rootEl: HTMLElement;
  mounts: number;
  destroyTimer: number | null;
  /** Tears down the plain-drag-to-pan bridge (see `bindDragPan`). */
  unbindPan: () => void;
  /** Diagram vs. SFL-source view — the per-block "Code" toggle. */
  showCode: boolean;
  /** The SFL text the viewer is currently showing (matches what's in the note). */
  source: string;
  /** The Code view's working copy — diverges from `source` while editing, kept
   *  here so it survives re-render churn. Reset to `source` on Save/Revert. */
  draft: string;
}

const viewerCache = new Map<string, CacheEntry>();
const DESTROY_GRACE_MS = 1500;

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
  entry.unbindPan();
  entry.viewer.destroy();
  entry.rootEl.remove();
  viewerCache.delete(key);
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

// The viewer only pans on a ctrl/⌘ + drag — a plain drag is deliberately left
// for the host page to scroll. Inside Obsidian's fixed-height box that's
// surprising: a reader expects a plain drag on empty canvas to pan, and
// without it every zoom stays pinned to the centre. Bridge it here without
// touching the library: while a plain left-drag that started on empty canvas
// is in progress, re-emit each move as the synthetic ctrl+drag the viewer's
// own pan handler already acts on, so its viewport state stays consistent with
// wheel-zoom and Fit. Drags that begin on a shape are left alone (those select).
function bindDragPan(viewer: Viewer): () => void {
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

  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('pointermove', onMove);
  svg.addEventListener('pointerup', onUp);
  svg.addEventListener('pointercancel', onUp);
  return () => {
    svg.removeEventListener('pointerdown', onDown);
    svg.removeEventListener('pointermove', onMove);
    svg.removeEventListener('pointerup', onUp);
    svg.removeEventListener('pointercancel', onUp);
  };
}

interface ToolbarHandlers {
  codeShown: boolean;
  onZoomOut(): void;
  onZoomIn(): void;
  onFit(): void;
  onToggleCode(): void;
}

// Toolbar: −  +  Fit  |  Code/Diagram. `sync()` re-paints the state-dependent
// bits (Code button label + pressed state, zoom buttons disabled while the SFL
// source is showing).
function buildToolbar(handlers: ToolbarHandlers): { bar: HTMLElement; sync(codeShown: boolean): void } {
  const bar = createDiv('sfl-toolbar');
  const makeButton = (label: string, title: string, onClick: () => void): HTMLButtonElement => {
    const button = bar.createEl('button', { text: label, attr: { 'aria-label': title, title } });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      onClick();
    });
    return button;
  };

  const zoomOut = makeButton('−', 'Zoom out', handlers.onZoomOut);
  const zoomIn = makeButton('+', 'Zoom in', handlers.onZoomIn);
  const fit = makeButton('Fit', 'Fit diagram to view', handlers.onFit);
  bar.createSpan('sfl-sep');
  const code = makeButton('Code', 'Show the SFL source for this block', handlers.onToggleCode);

  const sync = (codeShown: boolean): void => {
    code.setText(codeShown ? 'Diagram' : 'Code');
    code.setAttr('aria-label', codeShown ? 'Show the rendered diagram' : 'Show the SFL source for this block');
    code.setAttr('aria-pressed', String(codeShown));
    for (const button of [zoomOut, zoomIn, fit]) {
      button.disabled = codeShown;
    }
  };
  sync(handlers.codeShown);
  return { bar, sync };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const OPEN_FENCE = /^\s*(`{3,}|~{3,})\s*sfl\b/;
const CLOSE_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

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
      // note, a sync, a git checkout) — follow it without a remount so pan/zoom
      // survives. A clean Code-view draft follows too; a dirty one is left for
      // the Save guard to reconcile.
      if (this.source !== cached.source) {
        const draftWasClean = cached.draft === cached.source;
        cached.source = this.source;
        cached.viewer.update({ source: this.source });
        if (draftWasClean) {
          cached.draft = this.source;
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
      unbindPan: bindDragPan(viewer),
      showCode: false,
      source: this.source,
      draft: this.source,
    };
    viewerCache.set(key, entry);
    this.mountInteractive(container, entry);
  }

  private mountInteractive(container: HTMLElement, entry: CacheEntry): void {
    container.addClass('sfl-preview--interactive');
    container.append(entry.rootEl);

    const editor = this.editableEditorForNote();
    const codeView = this.buildCodeView(container, entry, editor);

    const status = container.createDiv('sfl-status');
    const paintStatus = (): void => {
      const selection = entry.viewer.getSelection();
      status.setText(selection.length ? `selected: ${selection.map((owner) => owner.id).join(', ')}` : '');
      status.hidden = entry.showCode || selection.length === 0;
    };

    const applyView = (): void => {
      entry.rootEl.hidden = entry.showCode;
      codeView.el.hidden = !entry.showCode;
      if (entry.showCode) {
        codeView.refresh();
      }
      paintStatus();
    };

    const { bar, sync } = buildToolbar({
      codeShown: entry.showCode,
      onZoomOut: () => zoomBy(entry.viewer, 1 / 1.2),
      onZoomIn: () => zoomBy(entry.viewer, 1.2),
      onFit: () => entry.viewer.fit(),
      onToggleCode: () => {
        entry.showCode = !entry.showCode;
        sync(entry.showCode);
        applyView();
      },
    });
    container.append(bar);

    applyView();
    // Unsubscribe on this child's unload; a child that re-adopts a cached
    // viewer registers its own listener the same way.
    this.register(entry.viewer.on('selectionChange', paintStatus));
  }

  // The Code view. Editable (textarea + Save/Revert) when the note is open in
  // editing mode — there's an editor to write through; read-only (a <pre>)
  // otherwise, matching the user's expectation that Reading mode doesn't edit.
  private buildCodeView(
    container: HTMLElement,
    entry: CacheEntry,
    editor: Editor | null,
  ): { el: HTMLElement; refresh(): void } {
    const el = container.createDiv('sfl-code-view');
    el.hidden = true;
    const api = { el, refresh: (): void => {} };

    if (!editor) {
      const pre = el.createEl('pre', { cls: 'sfl-source' });
      const code = pre.createEl('code');
      el.createDiv({ cls: 'sfl-code-hint', text: 'Switch the note to editing mode to change this.' });
      api.refresh = () => code.setText(entry.source);
      return api;
    }

    const textarea = el.createEl('textarea', {
      cls: 'sfl-source',
      attr: { spellcheck: 'false', 'aria-label': 'SFL source for this block' },
    });
    const footer = el.createDiv('sfl-code-footer');
    const saveBtn = footer.createEl('button', { text: 'Save', cls: 'sfl-code-save' });
    const revertBtn = footer.createEl('button', { text: 'Revert' });
    const message = footer.createSpan('sfl-code-message');

    const setMessage = (text: string, isError = false): void => {
      message.setText(text);
      message.toggleClass('is-error', isError);
    };
    const paintButtons = (): void => {
      const dirty = entry.draft !== entry.source;
      saveBtn.disabled = !dirty;
      revertBtn.disabled = !dirty;
    };

    textarea.value = entry.draft;
    textarea.addEventListener('input', () => {
      entry.draft = textarea.value;
      setMessage('');
      paintButtons();
    });
    textarea.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        save();
      }
    });

    const save = (): void => {
      const result = this.saveSource(container, entry, textarea.value);
      if (!result.ok) {
        setMessage(result.message, true);
        return;
      }
      entry.source = result.source;
      entry.draft = result.source;
      textarea.value = result.source;
      try {
        entry.viewer.update({ source: result.source });
      } catch {
        /* validated with render() already; a contract error here is not fatal to the save */
      }
      paintButtons();
      setMessage('Saved — toggle to Diagram to see the result.');
    };

    saveBtn.addEventListener('click', save);
    revertBtn.addEventListener('click', () => {
      entry.draft = entry.source;
      textarea.value = entry.source;
      setMessage('');
      paintButtons();
    });

    api.refresh = () => {
      textarea.value = entry.draft;
      paintButtons();
    };
    paintButtons();
    return api;
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
    try {
      render(next);
    } catch (error) {
      return { ok: false, message: `Won't save — ${errorMessage(error)}` };
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

    editor.replaceRange(
      `${next}\n`,
      { line: info.lineStart + 1, ch: 0 },
      { line: info.lineEnd, ch: 0 },
    );
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
