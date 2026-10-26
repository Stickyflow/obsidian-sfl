import type { Viewer } from 'stickyflow/viewer';

// --- the block the palette works on ------------------------------------------
// The palette always targets the last interactive diagram you selected
// something in. Each mount of a block publishes a handle; a re-render hands
// over a fresh one (new container, same cached viewer) under the same key.
export interface ActiveBlock {
  key: string;
  /** The note's file name, for the palette header. */
  noteName: string;
  viewer: Viewer;
  /** The text palette edits apply to: the Code view draft (== the note's
   *  block when nothing is pending). */
  text(): string;
  /** null when edits can be applied, else why not (Reading mode, a parked
   *  draft, ...). */
  blockedReason(): string | null;
  /** Validates and applies `next`, then selects `selectIds`. Returns an error
   *  message, or null on success. */
  apply(next: string, selectIds: string[]): string | null;
}

let active: ActiveBlock | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getActiveBlock(): ActiveBlock | null {
  return active;
}

export function setActiveBlock(block: ActiveBlock): void {
  active = block;
  emit();
}

// A re-render of the active block swaps in its new handle without stealing
// focus from another block.
export function adoptActiveBlock(block: ActiveBlock): void {
  if (active?.key === block.key) {
    active = block;
    emit();
  }
}

export function notifyActiveBlock(key: string): void {
  if (active?.key === key) {
    emit();
  }
}

export function clearActiveBlock(key: string): void {
  if (active?.key === key) {
    active = null;
    emit();
  }
}

export function onActiveBlockChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
