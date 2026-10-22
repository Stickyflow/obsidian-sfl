// --- Code view ---------------------------------------------------------------
// The SFL source pane a block's "Code" button flips to. Owns the textarea, its
// highlight overlay, the live-preview debounce and Save/Revert; reaches the
// note and the owning render child only through `CodeViewHost`.
import { LIVE_PREVIEW_DEBOUNCE_MS, type CacheEntry } from '../cache';
import { renderError } from '../render';
import { paintButton } from '../toolbar';
import type { SaveResult } from '../writeBack';
import { highlightSfl } from './highlight';
import { revealOwnerInTextarea } from './ownerLines';

export interface CodeViewHost {
  /** Writes a draft into the note. null when the note isn't open in editing
   *  mode, which makes the view read-only. */
  save: ((text: string) => SaveResult) | null;
  /** Called after every change so the shared viewer follows the draft. */
  reconcile: () => void;
  /** Ties a teardown to the owning render child's lifetime. */
  register: (cleanup: () => void) => void;
}

export interface CodeView {
  el: HTMLElement;
  /** Show/hide and switch between the read-only pane, the editing split, and
   *  the editing split with the preview pane collapsed. */
  setMode(showCode: boolean, splitEditing: boolean, previewHidden: boolean): void;
  /** Re-sync the textarea/`<pre>` (and caret) from the current entry state. */
  refresh(): void;
}

// The Code view. Editable (textarea + optional live preview + Save/Revert)
// when the note is open in editing mode — there's an editor to write through;
// read-only (a <pre>) otherwise.
export function buildCodeView(container: HTMLElement, entry: CacheEntry, host: CodeViewHost): CodeView {
  const { save: writeBack, reconcile, register } = host;
  const el = container.createDiv('sfl-code-view');

  if (!writeBack) {
    el.addClass('is-readonly');
    const pre = el.createEl('pre', { cls: 'sfl-source' });
    const code = pre.createEl('code');
    return {
      el,
      setMode: (showCode) => {
        el.hidden = !showCode;
      },
      refresh: () => highlightSfl(code, entry.source),
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

  // The textarea's own text is transparent; a highlighted <pre> sits right
  // under it with identical metrics and follows its scroll, so you see the
  // colors while the caret and selection stay native.
  const sourceWrap = el.createDiv('sfl-source-wrap');
  const highlight = sourceWrap.createEl('pre', { cls: 'sfl-source sfl-source-highlight', attr: { 'aria-hidden': 'true' } });
  const highlightCode = highlight.createEl('code');
  const textarea = sourceWrap.createEl('textarea', {
    cls: 'sfl-source',
    attr: { spellcheck: 'false', wrap: 'off', 'aria-label': 'SFL source for this block' },
  });
  const syncHighlightScroll = (): void => {
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  };
  const paintHighlight = (): void => {
    highlightSfl(highlightCode, textarea.value);
    syncHighlightScroll();
  };
  textarea.addEventListener('scroll', syncHighlightScroll);
  // Click a shape/link on the canvas → select & scroll to its lines in the
  // textarea. On real clicks only (not programmatic re-selection during a live
  // re-render), and the canvas keeps focus so it stays a peek, not a jump.
  const revealFromCanvas = (owner: { id: string }): void =>
    revealOwnerInTextarea(textarea, entry.draft, owner.id);
  register(entry.viewer.on('canvasObjectClick', (event) => revealFromCanvas(event.owner)));
  register(entry.viewer.on('linkClick', (event) => revealFromCanvas(event.owner)));

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
    const result = writeBack(textarea.value);
    if (!result.ok) {
      entry.refocusAfterSave = false;
      setError(result.message);
      return;
    }
    entry.source = result.source;
    entry.draft = result.source;
    entry.draftValid = true;
    textarea.value = result.source;
    paintHighlight();
    setError(null);
    setStatus('Saved.');
    paintButtons();
    reconcile();
  };

  textarea.value = entry.draft;
  paintHighlight();
  restoreCaret(); // re-mount mid-edit: put the caret back where it was
  for (const type of ['keyup', 'mouseup', 'scroll']) {
    textarea.addEventListener(type, rememberCaret);
  }
  textarea.addEventListener('input', () => {
    entry.draft = textarea.value;
    entry.refocusAfterSave = false;
    paintHighlight();
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
    paintHighlight();
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
        paintHighlight();
        restoreCaret();
      }
      paintButtons();
    },
  };
}
