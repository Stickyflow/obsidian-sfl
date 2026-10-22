// --- writing the Code view's draft back into the note -------------------------
// The only place the plugin mutates a note. Everything goes through the note's
// own Editor so a Save is one step on the undo stack, and only when the note is
// open in editing mode; Reading mode has no editor and stays read-only.
import { type App, type Editor, type MarkdownPostProcessorContext, MarkdownView } from 'obsidian';
import { renderError } from './render';

const OPEN_FENCE = /^\s*(`{3,}|~{3,})\s*sfl\b/;
const CLOSE_FENCE = /^\s*(`{3,}|~{3,})\s*$/;

export type SaveResult = { ok: true; source: string } | { ok: false; message: string };

// The Editor for this note *if* it's open in editing mode. Reading-mode panes
// report `'preview'` and are treated as no editor — Code view stays read-only.
export function editableEditorForNote(app: App, sourcePath: string): Editor | null {
  for (const leaf of app.workspace.getLeavesOfType('markdown')) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === sourcePath && view.getMode() === 'source') {
      return view.editor;
    }
  }
  return null;
}

// Whole-body write-back: validate the new SFL, re-locate the fenced block,
// confirm it still looks like the block this edit started from (`source`),
// then replace just its body through the editor (lands on the undo stack).
// Returns the normalised source on success, or a message to show on failure.
export function writeBlockSource(
  app: App,
  ctx: MarkdownPostProcessorContext,
  container: HTMLElement,
  source: string,
  rawText: string,
): SaveResult {
  const next = rawText.replace(/\s+$/, '');
  if (next === source) {
    return { ok: true, source };
  }
  const parseError = renderError(next);
  if (parseError) {
    return { ok: false, message: `Won't save — ${parseError}` };
  }

  const info = ctx.getSectionInfo(container);
  if (!info) {
    return { ok: false, message: "Couldn't locate this block in the note — reopen it and try again." };
  }
  const editor = editableEditorForNote(app, ctx.sourcePath);
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
    currentBody.replace(/\s+$/, '') !== source.replace(/\s+$/, '')
  ) {
    return { ok: false, message: 'The note changed underneath this block — reopen it and try again.' };
  }

  editor.replaceRange(`${next}\n`, { line: info.lineStart + 1, ch: 0 }, { line: info.lineEnd, ch: 0 });
  return { ok: true, source: next };
}
