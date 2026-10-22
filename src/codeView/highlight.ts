// --- SFL syntax highlighting (Code view) -----------------------------------
// A small line-based scanner mirroring vscode-sfl's TextMate grammar
// (syntaxes/sfl.tmLanguage.json): the same token classes, painted with
// Obsidian's own `--code-*` theme colors (see styles.css). Lexical only, it
// never resolves names, so it can run on every keystroke of a half-typed draft.
type SflToken = 'kw' | 'kwc' | 'sub' | 'name' | 'type' | 'prop' | 'str' | 'num' | 'const' | 'comment' | 'punct';

const HL_HEADER = /^(\s*)(sfl)(\s+)(-?\d+(?:\.\d+)?)/;
const HL_BLOCK =
  /^(\s*)(Project|Model|Group|Container|Chart|Symbol|Shape|Entity|Link|Layout|Style|Axis|Series|Rule|Path|Net|Port|Isometric|Connection|Text|Widget|Shader|DataSource|Table)(\s+)([A-Za-z_][A-Za-z0-9_]*)/;
const HL_CONTAINER = new Set(['Project', 'Model', 'Group', 'Container', 'Chart', 'Symbol']);
const HL_SUBBLOCK = /^(\s*)(layout|style)(?=\s*\{)/;
const HL_PROPERTY = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)(:)/;
const HL_NUMBER = /^-?\d+(?:\.\d+)?/;
const HL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const HL_PUNCT = '{}[](),;&.:';

export function highlightSfl(target: HTMLElement, text: string): void {
  target.empty();
  const out = document.createDocumentFragment();
  const emit = (value: string, token: SflToken | null): void => {
    if (!value) {
      return;
    }
    if (token) {
      out.createSpan({ cls: `sfl-tok-${token}`, text: value });
    } else {
      out.appendText(value);
    }
  };

  let inTriple = false;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    let rest = line;
    let identToken: SflToken | null = null;

    if (inTriple) {
      const close = rest.indexOf('"""');
      if (close < 0) {
        emit(rest, 'str');
        rest = '';
      } else {
        emit(rest.slice(0, close + 3), 'str');
        rest = rest.slice(close + 3);
        inTriple = false;
      }
    } else {
      let m: RegExpMatchArray | null;
      if ((m = rest.match(HL_HEADER))) {
        emit(m[1], null);
        emit(m[2], 'kw');
        emit(m[3], null);
        emit(m[4], 'num');
      } else if ((m = rest.match(HL_BLOCK))) {
        emit(m[1], null);
        emit(m[2], HL_CONTAINER.has(m[2]) ? 'kwc' : 'kw');
        emit(m[3], null);
        emit(m[4], 'name');
        identToken = 'type';
      } else if ((m = rest.match(HL_SUBBLOCK))) {
        emit(m[1], null);
        emit(m[2], 'sub');
      } else if ((m = rest.match(HL_PROPERTY))) {
        emit(m[1], null);
        emit(m[2], 'prop');
        emit(m[3], null);
        emit(m[4], 'punct');
        identToken = 'const';
      }
      if (m) {
        rest = rest.slice(m[0].length);
      }
    }

    // The rest of the line: strings, comments, numbers, punctuation, and bare
    // identifiers (composition refs after a block header, values after `key:`).
    let plain = '';
    while (rest) {
      let value = '';
      let token: SflToken | null = null;
      if (rest.startsWith('//')) {
        [value, token] = [rest, 'comment'];
      } else if (rest.startsWith('"""')) {
        const close = rest.indexOf('"""', 3);
        inTriple = close < 0;
        [value, token] = [inTriple ? rest : rest.slice(0, close + 3), 'str'];
      } else if (rest[0] === '"') {
        const m = rest.match(/^"(?:[^"\\]|\\.)*"?/);
        [value, token] = [m ? m[0] : rest, 'str'];
      } else if (HL_NUMBER.test(rest) && !/[A-Za-z0-9_]$/.test(plain)) {
        [value, token] = [(rest.match(HL_NUMBER) as RegExpMatchArray)[0], 'num'];
      } else if (HL_IDENT.test(rest)) {
        [value, token] = [(rest.match(HL_IDENT) as RegExpMatchArray)[0], identToken];
      } else if (HL_PUNCT.includes(rest[0])) {
        [value, token] = [rest[0], 'punct'];
        if (rest[0] === ';') {
          identToken = null; // `a: 1; b: 2` style: only the first value is known
        }
      } else {
        value = rest[0];
      }
      if (token) {
        emit(plain, null);
        plain = '';
        emit(value, token);
      } else {
        plain += value;
      }
      rest = rest.slice(value.length);
    }
    emit(plain, null);
    if (index < lines.length - 1) {
      out.appendText('\n');
    }
  });

  target.append(out);
}
