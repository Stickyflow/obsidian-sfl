// --- SFL palette side panel ----------------------------------------------------
// A right-sidebar view for growing an existing diagram without typing SFL:
// select one shape to add a connected neighbour (any shape, in the diagram's
// own Style) or duplicate it, select two to link them. Tiles are rendered with
// the same static `render()` the mobile fallback uses, from the note's own
// Style blocks. Edits go through the active block's `apply` (validate, then
// write back or update the Code view draft).
import { type IconName, ItemView, Notice, setIcon, type WorkspaceLeaf } from 'obsidian';
import { render } from 'stickyflow';
import { makeIconButton, selectionSummary } from '../toolbar';
import { type ActiveBlock, getActiveBlock, onActiveBlockChange } from './activeBlock';
import {
  addConnectedShape,
  bareId,
  compositionOf,
  connectShapes,
  type Direction,
  duplicateShape,
  type EditResult,
  type LinkMode,
  shapeTypeOf,
  thumbnailSource,
} from './edits';

export const PALETTE_VIEW_TYPE = 'sfl-palette';

const SHAPES: Array<[string, string]> = [
  ['rectangle', 'Rectangle'],
  ['rounded_rectangle', 'Rounded'],
  ['pill', 'Pill'],
  ['diamond', 'Decision'],
  ['oval', 'Oval'],
  ['circle', 'Circle'],
  ['parallelogram', 'Input / output'],
  ['document', 'Document'],
  ['cylinder', 'Database'],
  ['hexagon', 'Hexagon'],
  ['note', 'Note'],
  ['cloud', 'Cloud'],
  ['person', 'Person'],
  ['predefined_process', 'Subroutine'],
];

const DIRECTIONS: Array<[Direction, IconName, string]> = [
  ['left', 'arrow-left', 'Left'],
  ['above', 'arrow-up', 'Above'],
  ['below', 'arrow-down', 'Below'],
  ['right', 'arrow-right', 'Right'],
];

const LINK_MODES: Array<[LinkMode, string]> = [
  ['arrow', 'Arrow'],
  ['dashed', 'Dashed'],
  ['none', 'None'],
];

// Rendered tile SVGs by thumbnail source; styles rarely change between clicks.
const thumbnailCache = new Map<string, string | null>();

function thumbnailSvg(source: string): string | null {
  if (!thumbnailCache.has(source)) {
    let svg: string | null = null;
    try {
      svg = render(source).svg;
    } catch {
      /* a Style the one-shape diagram can't resolve; the tile falls back */
    }
    thumbnailCache.set(source, svg);
  }
  return thumbnailCache.get(source) ?? null;
}

export class SflPaletteView extends ItemView {
  private direction: Direction = 'right';
  private link: LinkMode = 'arrow';
  private label = 'New step';
  private unsubscribe: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
  }

  getViewType(): string {
    return PALETTE_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'SFL palette';
  }

  getIcon(): IconName {
    return 'shapes';
  }

  onOpen(): Promise<void> {
    this.contentEl.addClass('sfl-palette');
    this.unsubscribe = onActiveBlockChange(() => this.paint());
    this.paint();
    return Promise.resolve();
  }

  onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    return Promise.resolve();
  }

  private paint(): void {
    const el = this.contentEl;
    el.empty();
    const block = getActiveBlock();
    if (!block) {
      el.createDiv({ cls: 'sfl-palette-empty', text: 'Click a shape in an SFL diagram to extend it from here.' });
      return;
    }

    const head = el.createDiv('sfl-palette-head');
    head.createDiv({ cls: 'sfl-palette-note', text: block.noteName });
    const selection = block.viewer.getSelection();
    head.createDiv({
      cls: 'sfl-palette-selection',
      text: selectionSummary(selection) || 'Nothing selected',
    });

    const blocked = block.blockedReason();
    if (blocked) {
      el.createDiv({ cls: 'sfl-palette-empty', text: blocked });
      return;
    }

    const text = block.text();
    const shapes = selection.filter((owner) => shapeTypeOf(text, owner.id) !== null);
    if (shapes.length === 1 && selection.length === 1) {
      this.paintAddShape(el, block, text, shapes[0].id);
    } else if (shapes.length === 2 && selection.length === 2) {
      this.paintConnect(el, block, text, shapes[0].id, shapes[1].id);
    } else {
      el.createDiv({
        cls: 'sfl-palette-empty',
        text: 'Select one shape to add a connected one next to it, or Shift-click a second one to link the two.',
      });
    }
  }

  private run(block: ActiveBlock, result: EditResult, selectedId: string): void {
    if (!result.ok) {
      new Notice(result.message);
      return;
    }
    // Keep the viewer's qualified id form so the new owner can be selected.
    const qualified = selectedId.includes('.') ? selectedId.replace(/[^.]*$/, result.newId) : result.newId;
    const error = block.apply(result.text, [qualified]);
    if (error) {
      new Notice(error);
    }
  }

  private paintAddShape(el: HTMLElement, block: ActiveBlock, text: string, id: string): void {
    const options = el.createDiv('sfl-palette-section');
    options.createDiv({ cls: 'sfl-palette-title', text: 'Add next to it' });

    const directionRow = options.createDiv('sfl-palette-row');
    directionRow.createSpan({ cls: 'sfl-palette-label', text: 'Place' });
    const directions = directionRow.createDiv('sfl-palette-segment');
    for (const [direction, icon, title] of DIRECTIONS) {
      const button = makeIconButton(directions, icon, '', title, () => {
        this.direction = direction;
        this.paint();
      });
      button.setAttr('aria-pressed', String(this.direction === direction));
    }

    const linkRow = options.createDiv('sfl-palette-row');
    linkRow.createSpan({ cls: 'sfl-palette-label', text: 'Link' });
    const links = linkRow.createDiv('sfl-palette-segment');
    for (const [mode, title] of LINK_MODES) {
      const button = links.createEl('button', { text: title });
      button.setAttr('aria-pressed', String(this.link === mode));
      button.addEventListener('click', () => {
        this.link = mode;
        this.paint();
      });
    }

    const labelRow = options.createDiv('sfl-palette-row');
    labelRow.createSpan({ cls: 'sfl-palette-label', text: 'Text' });
    const input = labelRow.createEl('input', { type: 'text', cls: 'sfl-palette-input' });
    input.value = this.label;
    input.addEventListener('input', () => {
      this.label = input.value;
    });

    const grid = el.createDiv('sfl-palette-grid');
    const composition = compositionOf(text, id);
    const current = shapeTypeOf(text, id);
    for (const [shape, name] of SHAPES) {
      const tile = grid.createEl('button', { cls: 'sfl-palette-tile', attr: { title: `Add a ${name.toLowerCase()}` } });
      tile.toggleClass('is-current', shape === current);
      const preview = tile.createDiv('sfl-palette-thumb');
      const svg = thumbnailSvg(thumbnailSource(text, composition, shape)) ?? thumbnailSvg(thumbnailSource(text, null, shape));
      if (svg) {
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        preview.appendChild(doc.documentElement);
      } else {
        setIcon(preview, 'square');
      }
      tile.createDiv({ cls: 'sfl-palette-name', text: name });
      tile.addEventListener('click', () => {
        this.run(
          block,
          addConnectedShape(block.text(), id, {
            shape,
            label: this.label.trim(),
            direction: this.direction,
            link: this.link,
          }),
          id,
        );
      });
    }

    const actions = el.createDiv('sfl-palette-section');
    makeIconButton(actions, 'copy', 'Duplicate shape', 'Copy the selected shape next to it', () => {
      this.run(block, duplicateShape(block.text(), id, this.direction), id);
    });
  }

  private paintConnect(el: HTMLElement, block: ActiveBlock, text: string, fromId: string, toId: string): void {
    const section = el.createDiv('sfl-palette-section');
    section.createDiv({ cls: 'sfl-palette-title', text: `Link ${bareId(fromId)} → ${bareId(toId)}` });
    const row = section.createDiv('sfl-palette-row');
    makeIconButton(row, 'arrow-right', 'Arrow', 'Add an arrow between the two shapes', () => {
      this.run(block, connectShapes(text, fromId, toId, false), fromId);
    });
    makeIconButton(row, 'more-horizontal', 'Dashed', 'Add a dashed arrow between the two shapes', () => {
      this.run(block, connectShapes(text, fromId, toId, true), fromId);
    });
    makeIconButton(row, 'arrow-left', 'Reverse', `Add an arrow from ${bareId(toId)} to ${bareId(fromId)}`, () => {
      this.run(block, connectShapes(text, toId, fromId, false), toId);
    });
  }
}
