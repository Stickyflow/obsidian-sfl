import type { Viewer } from 'stickyflow/viewer';
import { clearActiveBlock } from './palette/activeBlock';

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
export interface CacheEntry {
  viewer: Viewer;
  rootEl: HTMLElement;
  mounts: number;
  destroyTimer: number | null;
  /** Tears down the canvas-navigation bridge (see `bindCanvasNav`). */
  unbindNav: () => void;
  /** Tears down the keyboard camera controls (see `bindKeyboardCamera`). */
  unbindKeyboard: () => void;
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

export const viewerCache = new Map<string, CacheEntry>();
export const DESTROY_GRACE_MS = 1500;
export const LIVE_PREVIEW_DEBOUNCE_MS = 250;

function hash32(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h) ^ input.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

export function cacheKey(sourcePath: string, lineStart: number | undefined, source: string): string {
  // The block's start line is the stable identity across re-renders. Only when
  // it's unavailable (section info not ready) fall back to a source hash.
  return `${sourcePath}::${lineStart != null ? `L${lineStart}` : `H${hash32(source)}`}`;
}

export function destroyEntry(key: string, entry: CacheEntry): void {
  if (entry.destroyTimer !== null) {
    window.clearTimeout(entry.destroyTimer);
  }
  if (entry.liveTimer !== null) {
    window.clearTimeout(entry.liveTimer);
  }
  entry.unbindNav();
  entry.unbindKeyboard();
  entry.unbindResize();
  entry.viewer.destroy();
  entry.rootEl.remove();
  viewerCache.delete(key);
  clearActiveBlock(key);
}
