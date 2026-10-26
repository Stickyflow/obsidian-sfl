// --- owner id → source lines (Code view "jump to this shape") -----------------
// A small brace-depth scan, ported from vscode-sfl-preview/src/sflOwnerBlocks.ts.
// Approximate on purpose — a reveal location, not a document mutation — so it
// doesn't need the real lexer (a `{` inside a `"""` string can throw depth off).
const OWNER_HEADER = /^\s*(Entity|Shape|Container|Group|Table|Path|Chart|Link)\s+([A-Za-z_][\w]*)\b/;

export function stripStringsAndComments(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

export function ownerLineRange(lines: string[], id: string): { start: number; end: number } | null {
  const bare = id.includes('.') ? (id.split('.').pop() ?? id) : id;
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(OWNER_HEADER);
    if (!match || (match[2] !== id && match[2] !== bare)) {
      continue;
    }
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      for (const ch of stripStringsAndComments(lines[j])) {
        if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) return { start: i, end: j };
      }
    }
    return { start: i, end: lines.length - 1 };
  }
  return null;
}

export function revealOwnerInTextarea(textarea: HTMLTextAreaElement, text: string, id: string): void {
  const lines = text.split('\n');
  const range = ownerLineRange(lines, id);
  if (!range) {
    return;
  }
  let startCh = 0;
  for (let i = 0; i < range.start; i++) startCh += lines[i].length + 1;
  let endCh = startCh;
  for (let i = range.start; i <= range.end; i++) endCh += lines[i].length + 1;
  try {
    textarea.setSelectionRange(startCh, Math.max(startCh, endCh - 1));
  } catch {
    return;
  }
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
  textarea.scrollTop = Math.max(0, (range.start - 1) * lineHeight);
}
