import type {
  FileViewer,
  ViewerCapabilities,
  ViewerLoadContext,
  ViewerSelection,
} from '@shared/file-viewer';
import type { Anchor, AnchorKind, CommentPayload } from '@shared/types';

/** The iframe-viewer projection of a live comment: an `html-selector-hint`
 *  anchor flattened to the fields the DOM resolver needs. `text_content` is the
 *  truth the resolver matches on; `selector`/`char_offset` are locality hints
 *  (see {@link applyHighlights}). */
export interface HtmlAnchor {
  selector: string;
  text_content: string;
  char_offset: number;
  char_length: number;
}

export interface IframeDocViewerOptions {
  container: HTMLElement;
  onSelection?: (sel: ViewerSelection | null) => void;
}

/** Project the live comment set down to the iframe-viewer `HtmlAnchor` shape:
 *  the `html-selector-hint` comments only. Shared by every iframe viewer (HTML,
 *  DOCX) via the {@link IframeDocViewer} base — the host no longer owns this
 *  derivation (X7). */
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

/** Shared base for the iframe-backed document viewers (HTML, DOCX) — the union
 *  of the two ~verbatim twins that had drifted (rev-x11). Everything common
 *  lives here: the stage/iframe/sandbox plumbing, style injection, selection
 *  capture, highlight resolution, and the `FileViewer` surface. A concrete
 *  viewer supplies ONLY a {@link bytesToHtml} strategy — how raw bytes become
 *  the HTML document string the iframe renders.
 *
 *  Anchor model (X5 `html-selector-hint`): `quoted_text` is the truth; the CSS
 *  `selector` and `char_offset` are locality hints, mirroring the MD viewer's
 *  text-first strategy (`fuzzyMatchAnchor`). Resolution searches text-first and
 *  has ONE not-found behavior: skip. */
export abstract class IframeDocViewer implements FileViewer {
  protected readonly opts: IframeDocViewerOptions;
  protected readonly stage: HTMLElement;
  protected readonly iframe: HTMLIFrameElement;
  private dark = false;
  private highlightedAnchors: HtmlAnchor[] = [];

  constructor(opts: IframeDocViewerOptions) {
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

  /** Strategy hook: turn raw document bytes into the HTML string the iframe
   *  renders. The one axis on which the iframe viewers differ — HTML decodes +
   *  injects a `<base>`, DOCX runs mammoth. May be async. */
  protected abstract bytesToHtml(
    bytes: Uint8Array,
    ctx?: ViewerLoadContext,
  ): string | Promise<string>;

  get totalPages(): number { return 1; }
  get currentPage(): number { return 1; }
  get anchorKind(): AnchorKind { return 'html-selector-hint'; }
  get capabilities(): ViewerCapabilities {
    return { paged: false, editableText: false };
  }

  applyAnchors(comments: CommentPayload[]): void {
    this.setHighlightedAnchors(htmlAnchorsFromComments(comments));
  }

  /** Scroll an html-selector-hint anchor into view inside the iframe (X6
   *  polymorphic reveal) — one implementation for every iframe viewer (HTML,
   *  DOCX). Best-effort and text-first, mirroring {@link applyHighlights}:
   *  prefer the painted `.review-highlight` whose text matches `quoted_text`,
   *  then fall back to the locality `selector`. No-op when the iframe doc isn't
   *  ready, the anchor is a foreign kind, or the target can't be resolved. */
  reveal(anchor: Anchor): void {
    if (anchor.kind !== 'html-selector-hint') return;
    const doc = this.iframe.contentDocument;
    if (!doc) return;
    const marks = Array.from(doc.querySelectorAll('.review-highlight'));
    const target =
      marks.find((m) => (m.textContent ?? '').includes(anchor.quoted_text)) ??
      querySelectorSafe(doc, anchor.selector);
    target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  }

  async loadBytes(bytes: Uint8Array, ctx?: ViewerLoadContext): Promise<void> {
    this.iframe.srcdoc = await this.bytesToHtml(bytes, ctx);
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

  /** Capture a selection the MD way: the selected `text` is the anchor truth.
   *  The CSS `selector` and `charOffset` ride along as locality hints only — the
   *  resolver ({@link applyHighlights}) re-derives the real offset from the text
   *  at paint time, so a drifted selector never produces a wrong highlight. */
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
        if (!text.trim()) {
          this.opts.onSelection?.(null);
          return;
        }
        const range = sel.getRangeAt(0);
        const container = range.startContainer.parentElement;
        // Locality hints — never the source of truth (see class doc).
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

  /** Resolve each anchor text-first and paint it. The `selector` narrows the
   *  search to a locality; when it no longer resolves the anchor's `text_content`
   *  is searched across the whole body instead (selector demoted to hint). The
   *  node-local offset is recomputed from the text — the stored `char_offset` is
   *  not trusted as a DOM offset. ONE not-found behavior: skip silently. */
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
        // Selector is a locality hint: use it to scope the search, but fall
        // back to the whole body when it no longer resolves — the text is truth.
        // A drifted-or-invalid selector must not kill resolution, so its lookup
        // is isolated from the text-match below.
        const scope = querySelectorSafe(doc, anchor.selector) ?? doc.body;
        if (!scope) continue;
        const textNode = findTextNode(scope, anchor.text_content);
        if (!textNode) continue; // not found → skip (the one behavior)
        const nodeText = textNode.textContent ?? '';
        const start = nodeText.indexOf(anchor.text_content);
        if (start < 0) continue;
        const end = Math.min(nodeText.length, start + anchor.text_content.length);
        const range = doc.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        const mark = doc.createElement('span');
        mark.className = 'review-highlight';
        range.surroundContents(mark);
      } catch {
        // Anchor resolution failed — skip silently (orphaned).
      }
    }
  }
}

/** `querySelector` that swallows the SyntaxError thrown for a malformed stored
 *  selector. Returns null on no-match OR bad selector, so the caller can fall
 *  back to a whole-body text search (selector is only a locality hint). */
function querySelectorSafe(doc: Document, selector: string): Element | null {
  if (!selector) return null;
  try {
    return doc.querySelector(selector);
  } catch {
    return null;
  }
}

function cssPath(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current !== current.ownerDocument.documentElement) {
    const tag = current.tagName;
    let selector = tag.toLowerCase();
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === tag,
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

/** Find the first text node under `el` whose content contains `text`. Strict:
 *  returns null when there is no containing node — the caller skips the anchor
 *  rather than highlighting an arbitrary node (rev-x11: one not-found behavior).
 *  The pre-union HTML viewer's "any text node" fallback is intentionally gone;
 *  it produced confidently-wrong highlights. */
function findTextNode(el: Element, text: string): Text | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.includes(text)) return node;
  }
  return null;
}
