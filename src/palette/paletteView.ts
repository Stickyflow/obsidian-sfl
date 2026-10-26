// --- SFL palette side panel ----------------------------------------------------
// A right-sidebar view for changing an existing diagram without typing SFL:
// select a shape to change its shape or add a linked neighbour or copy next
// to it, a link to switch it solid/dashed, two shapes to link them. Tiles are
// rendered with the same static `render()` the mobile fallback uses, from the
// note's own Style blocks. Edits go through the active block's `apply`
// (validate, then write back or update the Code view draft).
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
  isLinkDashed,
  type LinkMode,
  qualify,
  setLinkDashed,
  setShape,
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
      this.paintShape(el, block, text, shapes[0].id);
    } else if (selection.length === 1 && selection[0].role === 'link') {
      this.paintLink(el, block, text, selection[0].id);
    } else if (shapes.length === 2 && selection.length === 2) {
      this.paintConnect(el, block, text, shapes[0].id, shapes[1].id);
    } else {
      el.createDiv({
        cls: 'sfl-palette-empty',
        text: 'Select a shape to change it or add next to it, a link to restyle it, or Shift-click two shapes to link them.',
      });
    }
  }

  // `flash` highlights what changed; skipped for in-place restyles, where the
  // change itself is the feedback.
  private run(block: ActiveBlock, result: EditResult, selectedId: string, flash = true): void {
    if (!result.ok) {
      new Notice(result.message);
      return;
    }
    const error = block.apply(result.text, [qualify(selectedId, result.newId)], flash);
    if (error) {
      new Notice(error);
    }
  }

  // One shape selected: the tiles change *its* shape; the rows below add a
  // linked neighbour (same shape, reshape it with a tile after) or a copy.
  private paintShape(el: HTMLElement, block: ActiveBlock, text: string, id: string): void {
    const section = el.createDiv('sfl-palette-section');
    section.createDiv({ cls: 'sfl-palette-title', text: 'Shape' });
    const grid = section.createDiv('sfl-palette-grid');
    const composition = compositionOf(text, id);
    const current = shapeTypeOf(text, id);
    for (const [shape, name] of SHAPES) {
      const tile = grid.createEl('button', { cls: 'sfl-palette-tile', attr: { title: `Make it a ${name.toLowerCase()}` } });
      tile.setAttr('aria-pressed', String(shape === current));
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
        if (shape !== current) {
          this.run(block, setShape(block.text(), id, shape), id, false);
        }
      });
    }

    const add = el.createDiv('sfl-palette-section');
    add.createDiv({ cls: 'sfl-palette-title', text: 'Add next to it' });

    const labelRow = add.createDiv('sfl-palette-row');
    labelRow.createSpan({ cls: 'sfl-palette-label', text: 'Text' });
    const input = labelRow.createEl('input', { type: 'text', cls: 'sfl-palette-input' });
    input.value = this.label;
    input.addEventListener('input', () => {
      this.label = input.value;
    });

    const linkRow = add.createDiv('sfl-palette-row');
    linkRow.createSpan({ cls: 'sfl-palette-label', text: 'Link' });
    const links = linkRow.createDiv('sfl-palette-segment');
    for (const [mode, title] of LINK_MODES) {
      const button = links.createEl('button', {
        text: title,
        attr: { title: `Shapes added below get ${mode === 'none' ? 'no link' : `a ${title.toLowerCase()} link`}` },
      });
      button.setAttr('aria-pressed', String(this.link === mode));
      button.addEventListener('click', () => {
        this.link = mode;
        this.paint();
      });
    }

    const addRow = add.createDiv('sfl-palette-row');
    addRow.createSpan({ cls: 'sfl-palette-label', text: 'Add' });
    const addButtons = addRow.createDiv('sfl-palette-segment');
    const copyRow = add.createDiv('sfl-palette-row');
    copyRow.createSpan({ cls: 'sfl-palette-label', text: 'Copy' });
    const copyButtons = copyRow.createDiv('sfl-palette-segment');
    for (const [direction, icon, title] of DIRECTIONS) {
      makeIconButton(addButtons, icon, '', `Add a linked shape ${title.toLowerCase()}`, () => {
        this.run(
          block,
          addConnectedShape(block.text(), id, {
            shape: current ?? 'rectangle',
            label: this.label.trim(),
            direction,
            link: this.link,
          }),
          id,
        );
      });
      makeIconButton(copyButtons, icon, '', `Copy the shape ${title.toLowerCase()}`, () => {
        this.run(block, duplicateShape(block.text(), id, direction), id);
      });
    }
  }

  // One link selected: switch it between solid and dashed.
  private paintLink(el: HTMLElement, block: ActiveBlock, text: string, id: string): void {
    const section = el.createDiv('sfl-palette-section');
    section.createDiv({ cls: 'sfl-palette-title', text: 'Link' });
    const row = section.createDiv('sfl-palette-row');
    row.createSpan({ cls: 'sfl-palette-label', text: 'Line' });
    const segment = row.createDiv('sfl-palette-segment');
    const dashed = isLinkDashed(text, id);
    for (const [wantDashed, title] of [
      [false, 'Solid'],
      [true, 'Dashed'],
    ] as const) {
      const button = segment.createEl('button', { text: title });
      button.setAttr('aria-pressed', String(dashed === wantDashed));
      button.addEventListener('click', () => {
        if (dashed !== wantDashed) {
          this.run(block, setLinkDashed(block.text(), id, wantDashed), id, false);
        }
      });
    }
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
