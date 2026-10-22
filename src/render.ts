import { render } from 'stickyflow';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// null when the SFL parses, otherwise the parse error's message.
export function renderError(source: string): string | null {
  try {
    render(source);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

// Export / print / PDF render the note into a detached or print-styled
// container where the viewer has no usable size and interactivity is moot —
// keep the static SVG for those so the diagram still shows up in the output.
// Best-effort: matches the class names Obsidian puts on those roots.
export function isExportContext(el: HTMLElement): boolean {
  return (
    el.closest('.print, .is-exporting, .markdown-rendered.print') !== null ||
    document.body.classList.contains('is-exporting')
  );
}

export function renderStatic(container: HTMLElement, source: string): void {
  container.addClass('sfl-preview--static');
  try {
    // Parsed as SVG and appended as a node rather than set via innerHTML.
    // render() XML-escapes all user-supplied text/ids anyway (see
    // stickyflow.js/README.md, "Security").
    const doc = new DOMParser().parseFromString(render(source).svg, 'image/svg+xml');
    container.empty();
    container.appendChild(doc.documentElement);
  } catch (error) {
    container.empty();
    container.createEl('pre', { cls: 'sfl-preview-error', text: `SFL parse error: ${errorMessage(error)}` });
  }
}
