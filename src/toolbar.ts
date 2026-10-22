import { type IconName, setIcon } from 'obsidian';

// A Lucide icon + optional text label inside a <button>. Re-callable to swap
// the icon/label when a toggle button changes state.
export function paintButton(button: HTMLElement, icon: IconName, label: string, title = label): void {
  button.empty();
  setIcon(button.createSpan('sfl-btn-icon'), icon);
  if (label) {
    button.createSpan({ cls: 'sfl-btn-label', text: label });
  }
  button.setAttr('aria-label', title);
  button.setAttr('title', title);
}

// A <button> painted by paintButton and wired to a click handler. Shared by
// the block toolbar and the preview modal's own (smaller) toolbar.
export function makeIconButton(
  parent: HTMLElement,
  icon: IconName,
  label: string,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = parent.createEl('button');
  paintButton(button, icon, label, title);
  button.addEventListener('click', (event) => {
    event.preventDefault();
    onClick();
  });
  return button;
}

interface ToolbarHandlers {
  codeShown: boolean;
  onZoomOut: () => void;
  onZoomIn: () => void;
  onFit: () => void;
  onExpand: () => void;
  onToggleCode: () => void;
}

interface Toolbar {
  bar: HTMLElement;
  /** codeShown drives the Code/Diagram button; zoomEnabled the zoom/Fit trio
   *  (a diagram has to be on screen for them to do anything). */
  sync(codeShown: boolean, zoomEnabled: boolean): void;
  /** Show/clear the "unsaved edits parked in the Code view" dot. */
  setDirty(dirty: boolean): void;
}

// Header toolbar: zoom-out  zoom-in  Fit  |  Expand  |  Code/Diagram.
export function buildToolbar(handlers: ToolbarHandlers): Toolbar {
  const bar = createDiv('sfl-toolbar');
  const zoomOut = makeIconButton(bar, 'zoom-out', '', 'Zoom out', handlers.onZoomOut);
  const zoomIn = makeIconButton(bar, 'zoom-in', '', 'Zoom in', handlers.onZoomIn);
  const fit = makeIconButton(bar, 'maximize', 'Fit', 'Fit diagram to view', handlers.onFit);
  bar.createSpan('sfl-sep');
  makeIconButton(bar, 'expand', 'Expand', 'Open a bigger preview', handlers.onExpand);
  bar.createSpan('sfl-sep');
  const code = makeIconButton(bar, 'code', 'Code', 'Show the SFL source for this block', handlers.onToggleCode);

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

export const DIAGRAM_HINT = 'Drag to pan · Ctrl/⌘ + scroll to zoom · Fit to reset';

export function selectionSummary(owners: Array<{ id: string; kind?: string; label?: string }>): string {
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
