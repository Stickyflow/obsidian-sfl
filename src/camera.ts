import type { Viewer } from 'stickyflow/viewer';

// --- viewer helpers -------------------------------------------------------------
// `Viewer` exposes `fit()` but no direct zoom method; the wheel-zoom binding
// (`stickyflow.js/src/viewer/interaction/wheel.ts`) acts on a ctrl/⌘ + wheel
// gesture over the <svg>, so a toolbar button zooms by synthesising exactly
// that — the same approach vscode-sfl-preview uses for its zoom buttons.
export function zoomBy(viewer: Viewer, factor: number): void {
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
export function bindCanvasNav(viewer: Viewer, onCameraChange: () => void): () => void {
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

// Pan the viewport by a pixel delta by synthesising the ctrl+drag triplet the
// viewer's own pointer handler pans on (there's no public pan method). Positive
// dx/dy move the content right/down (same sense as `panBy`).
function panByPixels(viewer: Viewer, dx: number, dy: number): void {
  const svg = viewer.svg;
  const rect = svg.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const base = { ctrlKey: true, bubbles: true, cancelable: true, pointerId: 1 } as const;
  svg.dispatchEvent(new PointerEvent('pointerdown', { ...base, button: 0, clientX: cx, clientY: cy }));
  svg.dispatchEvent(
    new PointerEvent('pointermove', { ...base, clientX: cx + dx, clientY: cy + dy, movementX: dx, movementY: dy }),
  );
  svg.dispatchEvent(new PointerEvent('pointerup', { ...base, clientX: cx + dx, clientY: cy + dy }));
}

// The subset of camera-related state `bindKeyboardCamera` needs: enough to
// drive zoom/pan and remember whether the reader has taken control of the
// camera by hand. A block's `CacheEntry` satisfies this structurally; the
// preview modal (which has no `CacheEntry` of its own) passes a bare object.
export interface CameraState {
  viewer: Viewer;
  cameraTouched: boolean;
}

// Keyboard camera control on the diagram: +/- zoom, 0 fit, arrows pan, Esc
// clears selection. `rootEl` is made programmatically focusable (tabindex -1,
// not a Tab stop) and takes focus on an empty-canvas click; keydowns from a
// focused shape inside the <svg> bubble here too.
export function bindKeyboardCamera(rootEl: HTMLElement, state: CameraState): () => void {
  rootEl.tabIndex = -1;
  const PAN_STEP = 48;

  const focusSelf = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    // Focus the canvas unless the click landed on a focusable shape/link
    // (those carry tabindex="0" per the DOM contract) or a control.
    if (!target || target === rootEl || !target.closest('[tabindex="0"], a[href], button, input, textarea')) {
      rootEl.focus({ preventScroll: true });
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (rootEl.offsetParent === null) {
      return; // canvas hidden (Code view) — don't drive a viewer that isn't on screen
    }
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) {
      return;
    }
    const step = event.shiftKey ? PAN_STEP * 2 : PAN_STEP;
    switch (event.key) {
      case '+':
      case '=':
        state.cameraTouched = true;
        zoomBy(state.viewer, 1.2);
        break;
      case '-':
      case '_':
        state.cameraTouched = true;
        zoomBy(state.viewer, 1 / 1.2);
        break;
      case '0':
        state.cameraTouched = false;
        state.viewer.fit();
        break;
      case 'ArrowLeft':
        state.cameraTouched = true;
        panByPixels(state.viewer, step, 0);
        break;
      case 'ArrowRight':
        state.cameraTouched = true;
        panByPixels(state.viewer, -step, 0);
        break;
      case 'ArrowUp':
        state.cameraTouched = true;
        panByPixels(state.viewer, 0, step);
        break;
      case 'ArrowDown':
        state.cameraTouched = true;
        panByPixels(state.viewer, 0, -step);
        break;
      case 'Escape':
        state.viewer.select([]);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  rootEl.addEventListener('pointerdown', focusSelf);
  rootEl.addEventListener('keydown', onKeyDown);
  return () => {
    rootEl.removeEventListener('pointerdown', focusSelf);
    rootEl.removeEventListener('keydown', onKeyDown);
  };
}
