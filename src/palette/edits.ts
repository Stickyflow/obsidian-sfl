// --- palette edits: SFL text transforms -----------------------------------------
// Pure string → string helpers behind the palette's buttons. They work on the
// source text with the same approximate brace scan as the Code view's
// jump-to-shape (no source spans in stickyflow's AST), which is fine for a
// mutation only because every result goes through renderError() before it's
// written anywhere: a scan that goes wrong yields an error, never a bad note.
import { sflToCanvasState } from 'stickyflow';
import { ownerLineRange, stripStringsAndComments } from '../codeView/ownerLines';

export type Direction = 'right' | 'below' | 'left' | 'above';
export type Side = 'top' | 'right' | 'bottom' | 'left';
export type LinkMode = 'arrow' | 'dashed' | 'none';
export type EditResult = { ok: true; text: string; newId: string } | { ok: false; message: string };

const HEADER = /^(\s*)(Entity|Shape|Container|Group|Table|Path|Chart|Link)\s+([A-Za-z_]\w*)\s*(?::\s*([^{]*?))?\s*\{/;
const POSITION = /^(\s*position:\s*)(-?[\d.]+)\s*,\s*(-?[\d.]+)/;
const SIZE = /^\s*size:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/;
const GAP = { horizontal: 80, vertical: 60 };

interface OwnerBlock {
  start: number;
  end: number;
  indent: string;
  keyword: string;
  id: string;
  composition: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  positionLine: number;
}

// Viewer ids can be qualified (`model.lanes.cart`); the source names the bare id.
export function bareId(id: string): string {
  return id.split('.').pop() ?? id;
}

// `newId` in the same qualified form as `nearId`, so it can be selected.
export function qualify(nearId: string, newId: string): string {
  return nearId.includes('.') ? nearId.replace(/[^.]*$/, newId) : newId;
}

function readOwner(lines: string[], id: string): OwnerBlock | null {
  const range = ownerLineRange(lines, id);
  if (!range) {
    return null;
  }
  const header = lines[range.start].match(HEADER);
  if (!header) {
    return null;
  }
  let position: RegExpMatchArray | null = null;
  let positionLine = -1;
  let size: RegExpMatchArray | null = null;
  for (let i = range.start + 1; i < range.end; i++) {
    position ??= lines[i].match(POSITION);
    if (position && positionLine < 0) {
      positionLine = i;
    }
    size ??= lines[i].match(SIZE);
  }
  if (!position || !size) {
    return null;
  }
  return {
    ...range,
    indent: header[1],
    keyword: header[2],
    id: header[3],
    composition: header[4]?.trim() || null,
    x: Number(position[2]),
    y: Number(position[3]),
    w: Number(size[1]),
    h: Number(size[2]),
    positionLine,
  };
}

// The shape a canvas object resolves to after styles, or null when the id
// isn't a plain shape (a container, swimlane, chart, link, ...).
export function shapeTypeOf(text: string, id: string): string | null {
  const bare = bareId(id);
  try {
    const object = sflToCanvasState(text).canvasObjects.find((o) => bareId(o.id) === bare);
    return object?.objectType === 'shape' ? (object.shapeType ?? 'rectangle') : null;
  } catch {
    return null;
  }
}

export function compositionOf(text: string, id: string): string | null {
  return readOwner(text.split('\n'), id)?.composition ?? null;
}

function allIds(lines: string[]): Set<string> {
  const ids = new Set<string>();
  for (const line of lines) {
    const match = line.match(HEADER);
    if (match) {
      ids.add(match[3]);
    }
  }
  return ids;
}

function uniqueId(ids: Set<string>, base: string): string {
  if (!ids.has(base)) {
    return base;
  }
  let n = 2;
  while (ids.has(`${base}${n}`)) {
    n++;
  }
  return `${base}${n}`;
}

function nextLinkId(ids: Set<string>): string {
  let n = 1;
  while (ids.has(`l${n}`)) {
    n++;
  }
  return `l${n}`;
}

// The Style the diagram's links use most, so a new link looks like the rest.
function linkComposition(lines: string[]): string | null {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const match = line.match(HEADER);
    if (match?.[2] === 'Link' && match[4]?.trim()) {
      const composition = match[4].trim();
      counts.set(composition, (counts.get(composition) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  for (const [composition, count] of counts) {
    if (best === null || count > (counts.get(best) ?? 0)) {
      best = composition;
    }
  }
  return best;
}

function quote(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function round(n: number): number {
  return Math.round(n);
}

const FACES: Record<Direction, [Side, Side]> = {
  right: ['right', 'left'],
  below: ['bottom', 'top'],
  left: ['left', 'right'],
  above: ['top', 'bottom'],
};

function linkLines(
  lines: string[],
  indent: string,
  id: string,
  from: string,
  to: string,
  [fromFace, toFace]: [Side, Side],
  dashed: boolean,
  toFraction = 0.5,
): string[] {
  const inner = `${indent}  `;
  const composition = linkComposition(lines);
  const style: string[] = [];
  if (!composition) {
    style.push('markerEnd: arrow');
  }
  if (dashed) {
    style.push('strokeStyle: dashed');
  }
  return [
    `${indent}Link ${id}${composition ? ` : ${composition}` : ''} {`,
    `${inner}from: ${from}, ${fromFace} (0.5)`,
    `${inner}to: ${to}, ${toFace} (${toFraction})`,
    ...(style.length ? [`${inner}style {`, ...style.map((s) => `${inner}  ${s}`), `${inner}}`] : []),
    `${indent}}`,
  ];
}

function offset(owner: OwnerBlock, direction: Direction, w: number, h: number): { x: number; y: number } {
  switch (direction) {
    case 'right':
      return { x: owner.x + owner.w + GAP.horizontal, y: owner.y + (owner.h - h) / 2 };
    case 'left':
      return { x: owner.x - w - GAP.horizontal, y: owner.y + (owner.h - h) / 2 };
    case 'below':
      return { x: owner.x + (owner.w - w) / 2, y: owner.y + owner.h + GAP.vertical };
    case 'above':
      return { x: owner.x + (owner.w - w) / 2, y: owner.y - h - GAP.vertical };
  }
}

function insertAfter(lines: string[], line: number, block: string[]): string {
  return [...lines.slice(0, line + 1), ...block, ...lines.slice(line + 1)].join('\n');
}

const NO_LAYOUT = 'That shape has no layout { position / size } to place a new one next to.';

// A new shape next to `fromId` in `direction`, in the same Style (overriding
// only `shape:` when a different one was picked), optionally linked to it.
export function addConnectedShape(
  text: string,
  fromId: string,
  options: { shape: string; label: string; direction: Direction; link: LinkMode },
): EditResult {
  const lines = text.split('\n');
  const owner = readOwner(lines, fromId);
  if (!owner) {
    return { ok: false, message: NO_LAYOUT };
  }
  const ids = allIds(lines);
  const newId = uniqueId(ids, 'step');
  ids.add(newId);
  // Circles want a square box; everything else keeps the neighbour's size.
  const side = Math.min(owner.w, owner.h);
  const [w, h] = options.shape === 'circle' ? [side, side] : [owner.w, owner.h];
  const { x, y } = offset(owner, options.direction, w, h);
  const keyword = owner.keyword === 'Shape' ? 'Shape' : 'Entity';
  const indent = owner.indent;
  const inner = `${indent}  `;
  const sameShape = shapeTypeOf(text, fromId) === options.shape && owner.composition;
  const block = [
    '',
    `${indent}${keyword} ${newId}${owner.composition ? ` : ${owner.composition}` : ''} {`,
    ...(options.label ? [`${inner}text: ${quote(options.label)}`] : []),
    `${inner}layout {`,
    `${inner}  position: ${round(x)}, ${round(y)}`,
    `${inner}  size: ${round(w)}, ${round(h)}`,
    `${inner}}`,
    ...(sameShape ? [] : [`${inner}style {`, `${inner}  shape: ${options.shape}`, `${inner}}`]),
    `${indent}}`,
  ];
  if (options.link !== 'none') {
    block.push(
      '',
      ...linkLines(lines, indent, nextLinkId(ids), owner.id, newId, FACES[options.direction], options.link === 'dashed'),
    );
  }
  return { ok: true, text: insertAfter(lines, owner.end, block), newId };
}

// A copy of the whole block (style, kind, text and all) moved over by one gap.
export function duplicateShape(text: string, id: string, direction: Direction): EditResult {
  const lines = text.split('\n');
  const owner = readOwner(lines, id);
  if (!owner) {
    return { ok: false, message: NO_LAYOUT };
  }
  const newId = uniqueId(allIds(lines), owner.id);
  const { x, y } = offset(owner, direction, owner.w, owner.h);
  const copy = lines.slice(owner.start, owner.end + 1);
  copy[0] = copy[0].replace(new RegExp(`(${owner.keyword}\\s+)${owner.id}\\b`), `$1${newId}`);
  const p = owner.positionLine - owner.start;
  copy[p] = copy[p].replace(POSITION, `$1${round(x)}, ${round(y)}`);
  return { ok: true, text: insertAfter(lines, owner.end, ['', ...copy]), newId };
}

// A link between two existing shapes, leaving and entering on the faces that
// point at each other.
export function connectShapes(text: string, fromId: string, toId: string, dashed: boolean): EditResult {
  const lines = text.split('\n');
  const from = readOwner(lines, fromId);
  const to = readOwner(lines, toId);
  if (!from || !to) {
    return { ok: false, message: NO_LAYOUT };
  }
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const direction: Direction =
    Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'right' : 'left') : dy >= 0 ? 'below' : 'above';
  return linkSides(lines, from, to, FACES[direction], dashed);
}

// The canvas "drag a + bubble onto a shape" gesture: a link leaving `fromId`
// on `fromSide` and entering `toId` exactly where it was dropped.
export function connectAt(
  text: string,
  fromId: string,
  fromSide: Side,
  toId: string,
  toSide: Side,
  toFraction: number,
): EditResult {
  const lines = text.split('\n');
  const from = readOwner(lines, fromId);
  const to = readOwner(lines, toId);
  if (!from || !to) {
    return { ok: false, message: NO_LAYOUT };
  }
  return linkSides(lines, from, to, [fromSide, toSide], false, toFraction);
}

function linkSides(
  lines: string[],
  from: OwnerBlock,
  to: OwnerBlock,
  faces: [Side, Side],
  dashed: boolean,
  toFraction = 0.5,
): EditResult {
  const newId = nextLinkId(allIds(lines));
  const after = Math.max(from.end, to.end);
  const holder = after === from.end ? from : to;
  const block = ['', ...linkLines(lines, holder.indent, newId, from.id, to.id, faces, dashed, toFraction)];
  return { ok: true, text: insertAfter(lines, after, block), newId };
}

// --- in-place style changes ----------------------------------------------------
// Sets (or, with value null, removes) one property in the owner's own
// `style { }` block, creating the block when it's missing and dropping it when
// it ends up empty. null when the owner can't be found.
function setOwnStyle(text: string, id: string, key: string, value: string | null): string | null {
  const lines = text.split('\n');
  const range = ownerLineRange(lines, id);
  const header = range && lines[range.start].match(HEADER);
  if (!range || !header) {
    return null;
  }
  const inner = `${header[1]}  `;
  let depth = 0;
  let styleStart = -1;
  let styleEnd = -1;
  for (let i = range.start; i <= range.end; i++) {
    if (depth === 1 && styleStart < 0 && /^\s*style\s*\{\s*$/.test(lines[i])) {
      styleStart = i;
    }
    for (const ch of stripStringsAndComments(lines[i])) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (styleStart >= 0 && styleEnd < 0 && i > styleStart && depth === 1) {
      styleEnd = i;
    }
  }
  const property = new RegExp(`^\\s*${key}\\s*:`);
  const line = `${inner}  ${key}: ${value}`;
  if (styleStart >= 0 && styleEnd > styleStart) {
    const at = lines.slice(styleStart + 1, styleEnd).findIndex((l) => property.test(l));
    if (at >= 0 && value === null) {
      lines.splice(styleStart + 1 + at, 1);
      if (styleEnd - 1 === styleStart + 1) {
        lines.splice(styleStart, 2);
      }
    } else if (at >= 0) {
      lines[styleStart + 1 + at] = line;
    } else if (value !== null) {
      lines.splice(styleEnd, 0, line);
    }
  } else if (value !== null) {
    lines.splice(range.end, 0, `${inner}style {`, line, `${inner}}`);
  }
  return lines.join('\n');
}

// Changes the selected shape's own shape. Prefers dropping an override when
// its Style already gives the wanted shape, so the text stays minimal.
export function setShape(text: string, id: string, shape: string): EditResult {
  const cleared = setOwnStyle(text, id, 'shape', null);
  const next = cleared !== null && shapeTypeOf(cleared, id) === shape ? cleared : setOwnStyle(text, id, 'shape', shape);
  return next === null
    ? { ok: false, message: "Couldn't find that shape in the source." }
    : { ok: true, text: next, newId: bareId(id) };
}

// From the resolved link props, not the SVG: a labelled link uses a
// stroke-dasharray of its own to leave a gap for the label.
export function isLinkDashed(text: string, id: string): boolean {
  const bare = bareId(id);
  try {
    const link = sflToCanvasState(text).links.find((l) => bareId(l.id) === bare);
    return link?.props.strokeStyle === 'dashed';
  } catch {
    return false;
  }
}

// Solid or dashed for an existing link, again preferring no override.
export function setLinkDashed(text: string, id: string, dashed: boolean): EditResult {
  const cleared = setOwnStyle(text, id, 'strokeStyle', null);
  const next =
    cleared !== null && isLinkDashed(cleared, id) === dashed
      ? cleared
      : setOwnStyle(text, id, 'strokeStyle', dashed ? 'dashed' : 'solid');
  return next === null
    ? { ok: false, message: "Couldn't find that link in the source." }
    : { ok: true, text: next, newId: bareId(id) };
}

// --- thumbnails -------------------------------------------------------------
// A one-shape diagram that reuses the note's own top-level Style blocks, so
// the palette tiles look like the diagram they'd be added to.
function topLevelStyles(lines: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStyle = false;
  for (const line of lines) {
    if (depth === 0 && /^\s*Style\s+\w+/.test(line)) {
      inStyle = true;
    }
    for (const ch of stripStringsAndComments(line)) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (inStyle) {
      out.push(line);
      if (depth === 0) {
        inStyle = false;
        out.push('');
      }
    }
  }
  return out;
}

export function thumbnailSource(text: string, composition: string | null, shape: string): string {
  const lines = text.split('\n');
  const version = lines.find((line) => /^\s*sfl\s+\S+/.test(line))?.trim() ?? 'sfl 1.4';
  const [w, h] = shape === 'circle' ? [80, 80] : [120, 72];
  return [
    version,
    '',
    ...(composition ? topLevelStyles(lines) : []),
    'Model palette {',
    `  Entity tile${composition ? ` : ${composition}` : ''} {`,
    '    layout {',
    '      position: 0, 0',
    `      size: ${w}, ${h}`,
    '    }',
    '    style {',
    `      shape: ${shape}`,
    '    }',
    '  }',
    '}',
  ].join('\n');
}
