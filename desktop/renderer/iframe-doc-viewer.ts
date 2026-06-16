import type {
  FileViewer,
  ViewerCapabilities,
  ViewerLoadContext,
  ViewerSelection,
} from '@shared/file-viewer';
import type {
  Anchor,
  AnchorKind,
  CommentPayload,
  HtmlSelectorHint,
} from '@shared/types';
import { fuzzyMatchAnchor } from '@shared/md/anchors';

/** The iframe-viewer projection of a live comment: an `html-selector-hint`
 *  anchor flattened to the fields the DOM resolver needs. `text_content` is the
 *  truth the resolver matches on; `selector`/`char_offset` are locality hints.
 *  Legacy shape — the live anchor truth is now the `text-quote` kind (§5.5);
 *  this projection is kept for the migrated/legacy `html-selector-hint` rows and
 *  for the importers that re-export it. */
export interface HtmlAnchor {
  selector: string;
  text_content: string;
  char_offset: number;
  char_length: number;
}

/** A migrated `html-selector-hint` anchor that resolved in the iframe this paint,
 *  reported back so the host can promote it to a true `text-quote` and persist
 *  the stronger model (§5.5 lazy upgrade). `from`/`to` are char offsets over the
 *  iframe's extracted linear text — the same coordinate space `getContent()`
 *  returns and the resolver re-derives positions against. */
export interface AnchorUpgrade {
  commentId: string;
  from: number;
  to: number;
}

export interface IframeDocViewerOptions {
  container: HTMLElement;
  onSelection?: (sel: ViewerSelection | null) => void;
  /** §5.5 lazy upgrade: fired after a paint in which one or more migrated
   *  `html-selector-hint` anchors resolved, carrying their re-captured
   *  text-quote offsets for the host to persist (mirrors the MD write-back). */
  onAnchorsUpgraded?: (upgrades: AnchorUpgrade[]) => void;
}

/** Project the live comment set down to the iframe-viewer `HtmlAnchor` shape:
 *  the `html-selector-hint` comments only. Kept for backward-compat importers
 *  (html-viewer re-export) and the legacy display path — the primary anchor
 *  truth is now `text-quote` (§5.5), resolved directly off the comment union by
 *  {@link IframeDocViewer.applyAnchors}. */
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
 *  Anchor model (rev-l6, spec §5.5): a comment's truth is a `text-quote` over
 *  the iframe's extracted linear text (`doc.body.textContent`), captured and
 *  resolved by the SAME `fuzzyMatchAnchor` core the MD viewer uses. The legacy
 *  `html-selector-hint` kind is kept as a locality hint for migrated v1 rows;
 *  it resolves text-first with the CSS selector demoted to a search scope.
 *  Resolution has ONE not-found behavior: skip. */
export abstract class IframeDocViewer implements FileViewer {
  protected readonly opts: IframeDocViewerOptions;
  protected readonly stage: HTMLElement;
  protected readonly iframe: HTMLIFrameElement;
  private dark = false;
  private comments: CommentPayload[] = [];

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
  get anchorKind(): AnchorKind { return 'text-quote'; }
  get capabilities(): ViewerCapabilities {
    return { paged: false, editableText: false };
  }

  /** The iframe's extracted linear text — the coordinate system every
   *  `text-quote` anchor on this doc is measured against (spec §5.5). Empty
   *  until the iframe document is ready. Named to mirror `MarkdownViewer`'s
   *  `getContent()` so the host can source either viewer's anchoring text
   *  through one capability check. */
  getContent(): string {
    return this.iframe.contentDocument?.body?.textContent ?? '';
  }

  applyAnchors(comments: CommentPayload[]): void {
    this.comments = comments;
    this.applyHighlights();
  }

  /** Scroll a comment's anchor into view inside the iframe (X6 polymorphic
   *  reveal) — one implementation for every iframe viewer (HTML, DOCX).
   *  `text-quote`: resolve the range over the linear text and scroll its element
   *  into view. `html-selector-hint` (legacy): the painted `.review-highlight`
   *  matching `quoted_text`, else the locality `selector`. No-op when the doc
   *  isn't ready, the kind is foreign, or the target can't be resolved. */
  reveal(anchor: Anchor): void {
    const doc = this.iframe.contentDocument;
    if (!doc || !doc.body) return;

    if (anchor.kind === 'text-quote') {
      const idx = buildLinearIndex(doc.body);
      const match = fuzzyMatchAnchor(idx.text, anchor);
      if (match.confidence === 'orphaned') return;
      const pos = locate(idx, match.from);
      const target = pos?.node.parentElement;
      target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      return;
    }

    if (anchor.kind === 'html-selector-hint') {
      const marks = Array.from(doc.querySelectorAll('.review-highlight'));
      const target =
        marks.find((m) => (m.textContent ?? '').includes(anchor.quoted_text)) ??
        querySelectorSafe(doc, anchor.selector);
      target?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
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

  /** Capture a selection the MD way: the selected `text` is the anchor truth,
   *  and `from`/`to` are its char offsets over the iframe's linear text (spec
   *  §5.5). The host turns this into a `text-quote` anchor via the same
   *  `createMdAnchor` builder MD uses, so the resolver ({@link applyHighlights})
   *  re-derives the real position from the text at paint time — a drifted DOM
   *  never produces a wrong highlight. */
  private wireSelectionCapture(): void {
    const doc = this.iframe.contentDocument;
    if (!doc || !doc.body) return;
    const root = doc.body;
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
        // Offset of the selection start over the linear text: the length of all
        // text rendered before it. `Range.toString()` and `body.textContent`
        // share DOM text semantics, so this is the same coordinate space the
        // resolver walks at paint time.
        const pre = doc.createRange();
        pre.selectNodeContents(root);
        try {
          pre.setEnd(range.startContainer, range.startOffset);
        } catch {
          this.opts.onSelection?.(null);
          return;
        }
        const from = pre.toString().length;

        this.opts.onSelection?.({
          kind: 'text-quote',
          text,
          from,
          to: from + text.length,
        });
      });
    });
  }

  /** Re-resolve and repaint every comment's highlight. `text-quote` anchors
   *  resolve via `fuzzyMatchAnchor` over the linear text, then paint across the
   *  (possibly multiple) text nodes the range spans. `html-selector-hint`
   *  (legacy) resolves text-first inside the selector's locality. The linear
   *  text is invariant under painting (wrapping a range in a span leaves
   *  `textContent` unchanged), so all matches are computed against the clean
   *  text once and each paint rebuilds the node index off the live DOM. ONE
   *  not-found behavior: skip silently. */
  private applyHighlights(): void {
    const doc = this.iframe.contentDocument;
    if (!doc || !doc.body) return;

    // Unwrap any existing highlights back to plain text first.
    doc.querySelectorAll('.review-highlight').forEach((el) => {
      const parent = el.parentNode;
      if (parent) {
        parent.replaceChild(doc.createTextNode(el.textContent ?? ''), el);
        parent.normalize();
      }
    });

    const linear = buildLinearIndex(doc.body).text;
    const upgrades: AnchorUpgrade[] = [];

    for (const c of this.comments) {
      const a = c.anchor;
      if (a.kind === 'text-quote') {
        const match = fuzzyMatchAnchor(linear, a);
        if (match.confidence === 'orphaned') continue;
        // Rebuild the index off the live DOM: prior paints split nodes but never
        // change the text, so `match` offsets stay valid against a fresh walk.
        paintCharRange(doc, buildLinearIndex(doc.body), match.from, match.to);
      } else if (a.kind === 'html-selector-hint') {
        // Legacy locality hint: resolve to linear offsets text-first within the
        // selector scope, then paint over the live DOM (a single-node match, so
        // one span — identical to the pre-union paint). A successful resolution
        // is the §5.5 upgrade trigger: the same offsets become the text-quote
        // the host persists.
        const off = selectorHintOffsets(doc.body, a);
        if (off && paintCharRange(doc, buildLinearIndex(doc.body), off.from, off.to)) {
          upgrades.push({ commentId: c.id, from: off.from, to: off.to });
        }
      }
    }

    // §5.5 lazy upgrade: migrated html-selector-hint anchors that resolved this
    // paint now have a true text-quote position. Surface them so the host
    // re-captures them into the comment and persists the stronger model — the
    // HTML/DOCX twin of `syncMdAnchorsToComments`. Display already painted above;
    // this is purely the persistence promotion across the viewer/host boundary.
    if (upgrades.length > 0) this.opts.onAnchorsUpgraded?.(upgrades);
  }
}

/** A walk of `root`'s text nodes plus the linear text they concatenate to and
 *  each node's start offset within it. The single coordinate system shared by
 *  capture, resolution, and reveal. Exported for unit tests. */
export interface LinearIndex {
  text: string;
  nodes: Text[];
  starts: number[];
}

export function buildLinearIndex(root: Node): LinearIndex {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = node as Text;
    starts.push(text.length);
    text += t.data;
    nodes.push(t);
  }
  return { text, nodes, starts };
}

/** Map a linear-text offset back to the text node containing it and the offset
 *  within that node. A boundary offset (the seam between two nodes) resolves to
 *  the end of the earlier node — an equivalent DOM position. Null when the index
 *  is empty or the offset is out of range. */
export function locate(idx: LinearIndex, offset: number): { node: Text; nodeOffset: number } | null {
  if (idx.nodes.length === 0 || offset < 0 || offset > idx.text.length) return null;
  for (let i = 0; i < idx.nodes.length; i++) {
    const start = idx.starts[i];
    const len = idx.nodes[i].data.length;
    if (offset <= start + len) return { node: idx.nodes[i], nodeOffset: offset - start };
  }
  const last = idx.nodes[idx.nodes.length - 1];
  return { node: last, nodeOffset: last.data.length };
}

/** Wrap the linear range `[from, to)` in `.review-highlight` spans, one per
 *  text node the range spans. Each segment lives inside a single text node so
 *  `surroundContents` always succeeds; splitting a node only affects that node,
 *  leaving the other collected segments' references valid. Returns false when
 *  the range maps to nothing paintable. */
export function paintCharRange(doc: Document, idx: LinearIndex, from: number, to: number): boolean {
  if (from < 0 || to <= from) return false;
  const segments: { node: Text; start: number; end: number }[] = [];
  for (let i = 0; i < idx.nodes.length; i++) {
    const nodeStart = idx.starts[i];
    const len = idx.nodes[i].data.length;
    const nodeEnd = nodeStart + len;
    if (nodeEnd <= from) continue;
    if (nodeStart >= to) break;
    const s = Math.max(0, from - nodeStart);
    const e = Math.min(len, to - nodeStart);
    if (e > s) segments.push({ node: idx.nodes[i], start: s, end: e });
  }
  if (segments.length === 0) return false;
  for (const seg of segments) {
    try {
      const range = doc.createRange();
      range.setStart(seg.node, seg.start);
      range.setEnd(seg.node, seg.end);
      const mark = doc.createElement('span');
      mark.className = 'review-highlight';
      range.surroundContents(mark);
    } catch {
      // Segment unpaintable — skip it; the others still render.
    }
  }
  return true;
}

/** Resolve a legacy `html-selector-hint` to its linear-text offsets `[from, to)`
 *  under `root`, or null when it doesn't resolve. Resolution is the pre-union
 *  behavior — the first text node under the selector's scope (whole body on a
 *  missing/bad selector) that contains the quoted text — projected onto the
 *  body's linear text. The match is always within one text node, so the caller
 *  paints exactly one span (equivalent to the old `surroundContents`) and the
 *  same offsets are the §5.5 text-quote the host persists. ONE not-found
 *  behavior: null → skip. Exported for unit tests. */
export function selectorHintOffsets(
  root: HTMLElement,
  a: HtmlSelectorHint,
): { from: number; to: number } | null {
  try {
    const scope = querySelectorSafe(root.ownerDocument, a.selector) ?? root;
    const textNode = findTextNode(scope, a.quoted_text);
    if (!textNode) return null; // not found → skip (the one behavior)
    const start = (textNode.textContent ?? '').indexOf(a.quoted_text);
    if (start < 0) return null;
    const idx = buildLinearIndex(root);
    const nodeIndex = idx.nodes.indexOf(textNode);
    if (nodeIndex < 0) return null;
    const from = idx.starts[nodeIndex] + start;
    return { from, to: from + a.quoted_text.length };
  } catch {
    // Resolution failed (e.g. detached node) — skip silently (orphaned).
    return null;
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

/** Find the first text node under `el` whose content contains `text`. Strict:
 *  returns null when there is no containing node — the caller skips the anchor
 *  rather than highlighting an arbitrary node (rev-x11: one not-found behavior). */
function findTextNode(el: Element, text: string): Text | null {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.includes(text)) return node;
  }
  return null;
}
