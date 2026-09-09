// Renders fenced ```sfl code blocks as a live, interactive diagram using
// stickyflow.js's viewer tier (`createViewer` from `stickyflow/viewer` — pan,
// ctrl/⌘+wheel zoom, click-to-select, hover). Desktop only: on mobile, and in
// export / print / PDF contexts, it falls back to the static `render()` → SVG
// path — the viewer needs a live, sized DOM, and its drag-pan would fight the
// note's own touch-scroll on a phone.
//
// Read-only. Nothing here writes to the note. The interaction tier
// (`stickyflow/interaction`: drag-to-move/resize, text edit, +Entity/+Link,
// each patched back into the fenced block through Obsidian's editor API) is the
// next step — it's what "edit entities in the preview" ultimately needs — and
// is deliberately not wired in yet. See README "Known gaps".
import { MarkdownRenderChild, Platform, Plugin, type MarkdownPostProcessorContext } from 'obsidian';
import { render } from 'stickyflow';
import { createViewer, type Viewer } from 'stickyflow/viewer';

// --- viewer instance cache --------------------------------------------------
// Obsidian re-runs a code-block processor on many events unrelated to the
// block's own text (typing elsewhere in the note, theme change, metadata
// updates, pane resize), each time handing us a fresh `el` and a fresh render
// child. Without a cache, a new viewer is built every time and the reader's
// pan/zoom is thrown away on each one. So the live viewer plus its DOM subtree
// are kept in a module-level map keyed by note path + block start line + a hash
// of the source; a re-render that resolves to the same key re-adopts the
// existing node instead of remounting. Refcounted, with a short deferred
// destroy, so the "tear down then immediately rebuild the same block" churn
// neither leaks nor thrashes. (This cache is also the foundation the future
// interaction tier's remount guard needs.)
interface CacheEntry {
  viewer: Viewer;
  rootEl: HTMLElement;
  mounts: number;
  destroyTimer: number | null;
  /** Tears down the plain-drag-to-pan bridge (see `bindDragPan`). */
  unbindPan: () => void;
  /** Diagram vs. raw-SFL view — the per-block "Code" toggle. Kept on the cache
   *  entry so the choice survives the same re-render churn the viewer does. */
  showCode: boolean;
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
  return `${sourcePath}::${lineStart ?? 'x'}::${hash32(source)}`;
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
// bits (Code button label + pressed state, zoom buttons disabled while the raw
// SFL is showing).
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
    const message = error instanceof Error ? error.message : String(error);
    container.createEl('pre', { cls: 'sfl-preview-error', text: `SFL parse error: ${message}` });
  }
}

// --- render child ------------------------------------------------------------
class SflBlock extends MarkdownRenderChild {
  private key: string | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly source: string,
    private readonly ctx: MarkdownPostProcessorContext,
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
      const message = error instanceof Error ? error.message : String(error);
      container.createEl('pre', { cls: 'sfl-preview-error', text: `SFL parse error: ${message}` });
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
    };
    viewerCache.set(key, entry);
    this.mountInteractive(container, entry);
  }

  private mountInteractive(container: HTMLElement, entry: CacheEntry): void {
    container.addClass('sfl-preview--interactive');
    container.append(entry.rootEl);

    // Raw SFL view — hidden until the reader hits "Code". Native text selection
    // so it can be copied out.
    const codeEl = container.createEl('pre', { cls: 'sfl-source' });
    codeEl.createEl('code', { text: this.source });

    const status = container.createDiv('sfl-status');
    const paintStatus = (): void => {
      const selection = entry.viewer.getSelection();
      status.setText(selection.length ? `selected: ${selection.map((owner) => owner.id).join(', ')}` : '');
      status.hidden = entry.showCode || selection.length === 0;
    };

    const applyView = (): void => {
      entry.rootEl.hidden = entry.showCode;
      codeEl.hidden = !entry.showCode;
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
      ctx.addChild(new SflBlock(el, source, ctx));
    });
  }

  onunload(): void {
    // Snapshot — destroyEntry() deletes from viewerCache as it goes.
    for (const [key, entry] of [...viewerCache]) {
      destroyEntry(key, entry);
    }
  }
}
