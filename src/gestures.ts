// --- canvas gesture editing ------------------------------------------------------
// In an editable note the diagram itself is editable: drag a shape to move it,
// drag its handles to resize, drag a link end or segment, double-click to edit
// text, Delete to remove, arrow keys to nudge (see `nudge` below), click a `+`
// bubble to add a linked neighbour or drag it onto another shape to link the
// two. Gestures come
// from `stickyflow/interaction`'s `bindEditing`, which only reports *what*
// changed; each report becomes a text patch on the block's SFL, committed the
// same way the palette commits (validate, then write back or update the draft).
import { Notice } from 'obsidian';
import {
  applyLinkReconnectChange,
  applyLinkSegmentChange,
  applyMoveChange,
  applyResizeChange,
  applyTextChange,
  bindEditing,
  removeCanvasObject,
  removeLink,
} from 'stickyflow/interaction';
import type { OwnerRef } from 'stickyflow/viewer';
import type { CacheEntry } from './cache';
import { addConnectedShape, bareId, connectAt, type Direction, type EditResult, qualify, shapeTypeOf } from './palette/edits';
import { errorMessage } from './render';

// stickyflow's patchers look owners up by their id as written in the source.
function bare(owner: OwnerRef): OwnerRef {
  return { ...owner, id: bareId(owner.id) };
}

const BUBBLE_DIRECTION: Record<string, Direction> = {
  top: 'above',
  right: 'right',
  bottom: 'below',
  left: 'left',
};

// A patch either rewrites the text or, for the palette-style inserts, also
// names the owner to select afterwards.
type Patch = (text: string) => string | EditResult;

export interface Gestures {
  /** Moves the selected shapes by (dx, dy). false when nothing movable is
   *  selected, so the caller can use the key for something else. */
  nudge(dx: number, dy: number): boolean;
  destroy(): void;
}

export function bindGestures(entry: CacheEntry): Gestures {
  const editing = bindEditing(entry.viewer);

  // A multi-shape drag reports one moveChange per shape in the same tick;
  // fold everything reported in one tick into a single write (one undo step).
  let pending: Patch[] = [];
  let select: string[] | null = null;

  const fail = (message: string): void => {
    new Notice(message);
    // Drop the gesture's live preview and show the text as it is.
    entry.viewer.update({ source: entry.rendered });
  };

  const flush = (): void => {
    const patches = pending;
    pending = [];
    let selectIds = select;
    select = null;
    const commit = entry.commit;
    if (!commit) {
      fail('Open this note in editing mode to change the diagram.');
      return;
    }
    let next = entry.draft;
    try {
      for (const patch of patches) {
        const result = patch(next);
        if (typeof result === 'string') {
          next = result;
        } else if (result.ok) {
          next = result.text;
          selectIds = [result.newId];
        } else {
          fail(result.message);
          return;
        }
      }
    } catch (error) {
      fail(errorMessage(error));
      return;
    }
    const error = commit(next, selectIds ?? entry.viewer.getSelection().map((owner) => owner.id));
    if (error) {
      fail(error);
    }
  };

  const queue = (patch: Patch): void => {
    pending.push(patch);
    if (pending.length === 1) {
      queueMicrotask(flush);
    }
  };

  editing.on('moveChange', (event) => queue((text) => applyMoveChange(text, { ...event, owner: bare(event.owner) })));
  editing.on('resizeChange', (event) =>
    queue((text) => applyResizeChange(text, { ...event, owner: bare(event.owner) })),
  );
  editing.on('textChange', (event) => queue((text) => applyTextChange(text, { ...event, owner: bare(event.owner) })));
  editing.on('linkReconnect', (event) =>
    queue((text) =>
      applyLinkReconnectChange(text, { ...event, owner: bare(event.owner), target: bare(event.target) }),
    ),
  );
  editing.on('linkSegmentChange', (event) =>
    queue((text) => applyLinkSegmentChange(text, { ...event, owner: bare(event.owner) })),
  );
  editing.on('delete', (event) => {
    select = [];
    queue((text) =>
      event.owners.reduce(
        (acc, owner) =>
          owner.role === 'link'
            ? removeLink(acc, bareId(owner.id))
            : removeCanvasObject(acc, bareId(owner.id), { alsoRemoveLinks: true }),
        text,
      ),
    );
  });
  // The `+` bubbles: a click adds a linked neighbour of the same shape, in the
  // same Style (stickyflow's own applyQuickDuplicateChange inlines the
  // resolved style instead); a drag onto another shape links the two.
  editing.on('quickDuplicate', (event) => {
    const direction = BUBBLE_DIRECTION[event.direction];
    if (!direction) {
      return; // isometric bubbles: not supported here yet
    }
    queue((text) => {
      const result = addConnectedShape(text, event.owner.id, {
        shape: shapeTypeOf(text, event.owner.id) ?? 'rectangle',
        label: '',
        direction,
        link: 'arrow',
      });
      return result.ok ? { ...result, newId: qualify(event.owner.id, result.newId) } : result;
    });
  });
  editing.on('linkTo', (event) =>
    queue((text) => {
      const result = connectAt(text, event.owner.id, event.direction, event.target.id, event.side, event.fraction);
      return result.ok ? { ...result, newId: qualify(event.owner.id, result.newId) } : result;
    }),
  );

  return {
    // stickyflow's own arrow-key nudge only moves owners with role `shape`,
    // while the viewer reports shapes as `entity`, so it never fires; the
    // camera's key handler calls this instead.
    nudge: (dx, dy) => {
      const owners = entry.viewer.getSelection().filter((owner) => owner.role !== 'link');
      for (const owner of owners) {
        queue((text) => applyMoveChange(text, { owner: bare(owner), dx, dy }));
      }
      return owners.length > 0;
    },
    destroy: () => editing.destroy(),
  };
}
