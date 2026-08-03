// Beta-test prototype: renders fenced ```sfl code blocks as static SVG using
// stickyflow.js's headless static tier (render()). Read-only for now — the
// interactive/editable tiers (stickyflow/viewer, stickyflow/interaction) are
// the natural next step once this round-trips through a real vault, the same
// way packages/vscode-sfl-preview layered edit-mode onto its own static
// render first.
import { Plugin, MarkdownRenderChild } from 'obsidian';
import { render } from 'stickyflow';

class SflBlock extends MarkdownRenderChild {
  constructor(containerEl: HTMLElement, private source: string) {
    super(containerEl);
  }

  onload(): void {
    this.containerEl.addClass('sfl-preview');
    try {
      // render()'s output is safe to insert via innerHTML: all user-supplied
      // text/ids are XML-escaped and no attribute ever carries a user URL
      // (see packages/stickyflow.js/README.md, "Security").
      this.containerEl.innerHTML = render(this.source).svg;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.containerEl.createEl('pre', { cls: 'sfl-preview-error', text: `SFL parse error: ${message}` });
    }
  }
}

export default class ObsidianSflPlugin extends Plugin {
  onload(): void {
    this.registerMarkdownCodeBlockProcessor('sfl', (source, el, ctx) => {
      ctx.addChild(new SflBlock(el, source));
    });
  }
}
