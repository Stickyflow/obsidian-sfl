import { type App, Modal } from 'obsidian';
import { createViewer, type Viewer } from 'stickyflow/viewer';
import { bindCanvasNav, bindKeyboardCamera, type CameraState, zoomBy } from './camera';
import { errorMessage } from './render';
import { DIAGRAM_HINT, makeIconButton, selectionSummary } from './toolbar';

// --- bigger preview modal -----------------------------------------------------
// The header's "Expand" button pops the diagram open in a near-fullscreen
// modal for a closer look: pan, zoom, click-to-select, nothing else. No Code
// view, no Save/Revert, no write-back. It mounts its own `Viewer` over a
// snapshot of the SFL text that was on screen when it opened, and tears that
// viewer down on close; it doesn't track further edits to the block while
// it's open, so reopen it to see a newer draft.
export class SflPreviewModal extends Modal {
  private cleanup: (() => void) | null = null;

  constructor(
    app: App,
    private readonly source: string,
    private readonly diagramId: string,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass('sfl-preview-modal');
    this.setTitle('Diagram preview');
    this.contentEl.addClass('sfl-preview-modal-content');

    const header = this.contentEl.createDiv('sfl-header');
    const info = header.createDiv('sfl-header-info');
    info.addClass('is-hint');
    info.setText(DIAGRAM_HINT);
    const toolbar = header.createDiv('sfl-toolbar');

    const rootEl = this.contentEl.createDiv('sfl-viewer-root');

    let viewer: Viewer;
    try {
      viewer = createViewer({
        container: rootEl,
        source: this.source,
        interactive: true,
        selectable: true,
        diagramId: this.diagramId,
      });
    } catch (error) {
      rootEl.createEl('pre', { cls: 'sfl-preview-error', text: `SFL parse error: ${errorMessage(error)}` });
      return;
    }
    viewer.on('ready', () => viewer.fit());

    const camera: CameraState = { viewer, cameraTouched: false };
    makeIconButton(toolbar, 'zoom-out', '', 'Zoom out', () => {
      camera.cameraTouched = true;
      zoomBy(viewer, 1 / 1.2);
    });
    makeIconButton(toolbar, 'zoom-in', '', 'Zoom in', () => {
      camera.cameraTouched = true;
      zoomBy(viewer, 1.2);
    });
    makeIconButton(toolbar, 'maximize', 'Fit', 'Fit diagram to view', () => {
      camera.cameraTouched = false;
      viewer.fit();
    });

    const paintInfo = (): void => {
      const summary = selectionSummary(viewer.getSelection());
      if (summary) {
        info.setText(summary);
        info.removeClass('is-hint');
        return;
      }
      info.addClass('is-hint');
      info.setText(DIAGRAM_HINT);
    };

    const unbindNav = bindCanvasNav(viewer, () => {
      camera.cameraTouched = true;
    });
    const unbindKeyboard = bindKeyboardCamera(rootEl, camera);
    const resizeObserver = new ResizeObserver(() => {
      if (!camera.cameraTouched) {
        viewer.fit();
      }
    });
    resizeObserver.observe(rootEl);
    const unsubscribeSelection = viewer.on('selectionChange', paintInfo);

    this.cleanup = () => {
      unsubscribeSelection();
      unbindNav();
      unbindKeyboard();
      resizeObserver.disconnect();
      viewer.destroy();
    };

    window.setTimeout(() => rootEl.focus({ preventScroll: true }), 0);
  }

  onClose(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.contentEl.empty();
  }
}
