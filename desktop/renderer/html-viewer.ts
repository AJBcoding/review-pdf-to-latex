import type {
  FileViewer,
  ViewerCapabilities,
  ViewerLoadContext,
  ViewerSelection,
} from '@shared/file-viewer';
import type { Anchor, AnchorKind, CommentPayload } from '@shared/types';

export interface HtmlAnchor {
  selector: string;
  text_content: string;
  char_offset: number;
  char_length: number;
}

export interface HtmlSelection {
  selector: string;
  text: string;
  charOffset: number;
  charLength: number;
}

export interface HtmlViewerOptions {
  container: HTMLElement;
  /** Base directory for resolving relative resource URLs. Optional now that
   *  X7 threads the document path through `loadBytes(bytes, ctx)`; the ctx
   *  path wins when both are present. */
  basePath?: string;
  onSelection?: (sel: ViewerSelection | null) => void;
}

/** Project the live comment set down to the iframe-viewer `HtmlAnchor` shape:
 *  the `html-selector-hint` comments only. Shared by the HTML and DOCX viewers'
 *  `applyAnchors` (X7) — the host no longer owns this derivation. */
export function htmlAnchorsFromComments(comments: CommentPayload[]): HtmlAnchor[] {
  const anchors: HtmlAnchor[] = [];
  for (const c of comments) {
    if (c.anchor.kind !== 'html-selector-hint') continue;
    const a = c.anchor;
    anchors.push({
      selector: a.selector,
      text_content: a.quoted_text,
      char_offset: a.char_offset,
      char_length: a.char_length || a.quoted_text.length,
    });
  }
  return anchors;
}

export class HtmlViewer implements FileViewer {
  private opts: HtmlViewerOptions;
  private stage: HTMLElement;
  private iframe: HTMLIFrameElement;
  private dark = false;
  private htmlContent = '';
  private highlightedAnchors: HtmlAnchor[] = [];

  constructor(opts: HtmlViewerOptions) {
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
    return { paged: false, editableText: false };
  }

  applyAnchors(comments: CommentPayload[]): void {
    this.setHighlightedAnchors(htmlAnchorsFromComments(comments));
  }

  /** No jump-to-anchor for the iframe viewers in v1 (matches the host's prior
   *  pdf-only `revealCommentAnchor`). */
  reveal(_anchor: Anchor): void {}

  async loadBytes(bytes: Uint8Array, ctx?: ViewerLoadContext): Promise<void> {
    this.htmlContent = new TextDecoder('utf-8').decode(bytes);
    const base = ctx?.path ?? this.opts.basePath ?? '';
    const baseDir = base.replace(/[^/\\]*$/, '');
    const baseTag = `<base href="file://${baseDir}">`;
    const injected = this.htmlContent.replace(
      /(<head[^>]*>)/i,
      `$1${baseTag}`,
    );
    const finalHtml = injected.includes('<head') ? injected : `<head>${baseTag}</head>${this.htmlContent}`;
    this.iframe.srcdoc = finalHtml;
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
      ::selection {
        background: #264f78;
        color: white;
      }
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
        const range = sel.getRangeAt(0);
        const text = sel.toString();
        if (!text.trim()) {
          this.opts.onSelection?.(null);
          return;
        }
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
        const textNode = findTextNode(el, anchor.text_content);
        if (!textNode) continue;
        const range = doc.createRange();
        const start = Math.max(0, anchor.char_offset);
        const end = Math.min(textNode.length, start + anchor.char_length);
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const mark = doc.createElement('span');
        mark.className = 'review-highlight';
        range.surroundContents(mark);
      } catch {
        // Anchor resolution failed — skip silently (orphaned)
      }
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

function findTextNode(el: Element, text: string): Text | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.includes(text)) return node;
  }
  // Fallback: any text node with partial match
  const walker2 = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while ((node = walker2.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.length > 0) return node;
  }
  return null;
}
