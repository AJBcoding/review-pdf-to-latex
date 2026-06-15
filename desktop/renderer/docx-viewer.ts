import mammoth from 'mammoth';
import type {
  FileViewer,
  ViewerCapabilities,
  ViewerLoadContext,
  ViewerSelection,
} from '@shared/file-viewer';
import type { Anchor, AnchorKind, CommentPayload } from '@shared/types';
import { htmlAnchorsFromComments, type HtmlAnchor } from './html-viewer';

export interface DocxViewerOptions {
  container: HTMLElement;
  onSelection?: (sel: ViewerSelection | null) => void;
}

export class DocxViewer implements FileViewer {
  private opts: DocxViewerOptions;
  private stage: HTMLElement;
  private iframe: HTMLIFrameElement;
  private dark = false;
  private highlightedAnchors: HtmlAnchor[] = [];

  constructor(opts: DocxViewerOptions) {
    this.opts = opts;

    this.stage = document.createElement('div');
    this.stage.className = 'html-viewer-stage';

    this.iframe = document.createElement('iframe');
    this.iframe.className = 'html-viewer-iframe';
    this.iframe.sandbox.add('allow-same-origin');
    this.iframe.setAttribute('referrerpolicy', 'no-referrer');
    this.stage.appendChild(this.iframe);

    opts.container.appendChild(this.stage);

    this.iframe.addEventListener('load', () => {
      this.injectStyles();
      this.wireSelectionCapture();
      this.applyHighlights();
    });
  }

  get totalPages(): number { return 1; }
  get currentPage(): number { return 1; }
  get anchorKind(): AnchorKind { return 'html-selector-hint'; }
  get capabilities(): ViewerCapabilities {
    return { paged: false, editableText: false, submit: false };
  }

  applyAnchors(comments: CommentPayload[]): void {
    this.setHighlightedAnchors(htmlAnchorsFromComments(comments));
  }

  reveal(_anchor: Anchor): void {}

  async loadBytes(bytes: Uint8Array, _ctx?: ViewerLoadContext): Promise<void> {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) },
      { styleMap: ['u => em'] },
    );
    const html = `
      <!DOCTYPE html>
      <html><head>
        <meta charset="utf-8">
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            max-width: 720px;
            margin: 24px auto;
            padding: 0 16px;
            line-height: 1.6;
            color: #e6e6e6;
            background: #222;
          }
          img { max-width: 100%; }
          table { border-collapse: collapse; width: 100%; margin: 1em 0; }
          th, td { border: 1px solid #444; padding: 6px 10px; text-align: left; }
          th { background: rgba(255,255,255,0.04); }
          blockquote { border-left: 3px solid #4a9eff; padding-left: 1em; color: #888; margin: 1em 0; }
          pre { background: #111; padding: 12px; border-radius: 6px; overflow-x: auto; }
          code { font-family: "SF Mono", monospace; font-size: 0.9em; }
        </style>
      </head><body>${result.value}</body></html>
    `;
    this.iframe.srcdoc = html;

    if (result.messages.length > 0) {
      console.warn('[docx-viewer] mammoth warnings:', result.messages);
    }
  }

  async nextPage(): Promise<void> {}
  async prevPage(): Promise<void> {}
  async fitPage(): Promise<void> {}
  async fitWidth(): Promise<void> {}

  setDarkMode(enabled: boolean): void {
    this.dark = enabled;
    this.stage.classList.toggle('html-dark', enabled);
  }

  isDarkMode(): boolean { return this.dark; }

  dispose(): void {
    this.iframe.srcdoc = '';
    this.stage.remove();
  }

  setHighlightedAnchors(anchors: HtmlAnchor[]): void {
    this.highlightedAnchors = anchors;
    this.applyHighlights();
  }

  private injectStyles(): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = `
      .review-highlight {
        background: rgba(245, 200, 75, 0.2);
        border-bottom: 2px solid rgba(245, 200, 75, 0.5);
        cursor: pointer;
      }
      ::selection { background: #264f78; color: white; }
    `;
    doc.head.appendChild(style);
  }

  private wireSelectionCapture(): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    doc.addEventListener('mouseup', () => {
      requestAnimationFrame(() => {
        const sel = doc.getSelection();
        if (!sel || sel.isCollapsed || !sel.rangeCount) {
          this.opts.onSelection?.(null);
          return;
        }
        const text = sel.toString();
        if (!text.trim()) { this.opts.onSelection?.(null); return; }
        const range = sel.getRangeAt(0);
        const container = range.startContainer.parentElement;
        const selector = container ? cssPath(container) : 'body';
        const nodeText = container?.textContent ?? '';
        const charOffset = nodeText.indexOf(text);
        this.opts.onSelection?.({
          kind: 'html-selector-hint',
          text,
          selector,
          charOffset: Math.max(0, charOffset),
          charLength: text.length,
        });
      });
    });
  }

  private applyHighlights(): void {
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    doc.querySelectorAll('.review-highlight').forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(doc.createTextNode(el.textContent ?? ''), el);
        parent.normalize();
      }
    });
    for (const anchor of this.highlightedAnchors) {
      try {
        const el = doc.querySelector(anchor.selector);
        if (!el) continue;
        const walker = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          if (node.textContent && node.textContent.includes(anchor.text_content)) {
            const range = doc.createRange();
            const start = Math.max(0, anchor.char_offset);
            const end = Math.min(node.length, start + anchor.char_length);
            range.setStart(node, start);
            range.setEnd(node, end);
            const mark = doc.createElement('span');
            mark.className = 'review-highlight';
            range.surroundContents(mark);
            break;
          }
        }
      } catch { /* skip orphaned anchors */ }
    }
  }
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== current.ownerDocument.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === current!.tagName,
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${idx})`;
      }
    }
    parts.unshift(selector);
    current = parent;
  }
  return parts.join(' > ');
}
