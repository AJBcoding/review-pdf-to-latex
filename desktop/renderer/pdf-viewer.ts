// PDF viewer — renders one page at a time, with PDF.js's TextLayerBuilder
// driving the text overlay so native browser text selection produces a
// glyph-accurate highlight payload (per ux-spec §5.2).
//
// Architecture: 2026-05-20 port to PDF.js's TextLayerBuilder. Previously we
// drove a bare `TextLayer` and hand-ported the selection-trap machinery
// (endOfContent, selectionchange repositioning, .selecting toggle). The hand
// port carried a margin-click phantom-selection bug that Mozilla's reference
// viewer demonstrably did NOT have on the same PDF, so we now consume the
// same TextLayerBuilder + StructTreeLayerBuilder + TextAccessibilityManager
// chain that the reference viewer uses. See:
//   docs/handoffs/2026-05-20-milestone-3-selection-bug-research-handoff.md
//   node_modules/pdfjs-dist/web/pdf_viewer.mjs  (L6174 TextLayerBuilder,
//                                                 L5570 StructTreeLayerBuilder,
//                                                 L5800 TextAccessibilityManager,
//                                                 L7140 PDFPageView reference wiring)
//
// What we keep from the prior implementation: canvas page rendering, the
// persistent highlight overlay (§5.2 — survives the focus shift to the
// comment input that otherwise collapses native ::selection rendering),
// SelectionPayload shape, navigation/zoom/fit/dark-mode, capture-on-mouseup.
//
// What TextLayerBuilder now owns (so we don't anymore): mousedown class
// toggle, endOfContent sentinel placement, selectionchange repositioning of
// the sentinel, pointerup/blur/keyup global resets, abort-signal teardown.

import type { FileViewer } from '@shared/file-viewer';
import type { AnchorKind } from '@shared/types';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
import {
  TextLayerBuilder,
  StructTreeLayerBuilder,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
// Note: TextAccessibilityManager is defined inside pdf_viewer.mjs but is NOT
// in its public export list (see L9740 in pdf_viewer.mjs). PDFPageView
// constructs one because it lives in the same module; we can't. The
// accessibilityManager param on TextLayerBuilder is optional — without it we
// lose aria-owns decoration on text spans, which is accessibility-only and
// not relevant to selection.
// Vite handles ?url to produce a hashed worker URL the bundler emits.
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
// PDF.js v5's TextLayer relies on a chain of CSS variables
// (--total-scale-factor → --text-scale-factor → font sizing) set by the
// canonical viewer stylesheet. Hand-rolling subset CSS produces a ~2-char
// horizontal drift between selection rects and the painted canvas glyphs,
// which is what AJB observed. Importing the canonical CSS resolves it.
import 'pdfjs-dist/web/pdf_viewer.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

/** §5.2 payload shape. Stable across the spike, this module, and what the
 * Electron app will eventually attach to a comment. */
export interface SelectionPayload {
  page: number;
  // PDF-space region (origin at bottom-left, units = PDF points).
  region: { x: number; y: number; w: number; h: number };
  // Screen-space rects (for the host to draw highlight overlays without
  // re-doing the coordinate math).
  screenRects: { x: number; y: number; w: number; h: number }[];
  highlighted_text: string;
}

export interface PdfViewerOptions {
  /** DOM element the viewer mounts inside. The viewer takes over this node's
   * children — pass a dedicated container. */
  container: HTMLElement;
  /** Initial zoom; 1 = 100% of PDF points to CSS pixels. */
  initialZoom?: number;
  /** Called every time the user makes a non-empty selection inside the
   * text layer. The host decides whether to keep, display, or submit it. */
  onSelection?(payload: SelectionPayload): void;
  /** Called when the loaded document's page count is known (and on every
   * page change), so the host can update navigation chrome. */
  onPageInfo?(info: { page: number; totalPages: number }): void;
}

export class PdfViewer implements FileViewer {
  private opts: Required<Omit<PdfViewerOptions, 'onSelection' | 'onPageInfo'>>
              & Pick<PdfViewerOptions, 'onSelection' | 'onPageInfo'>;

  // DOM. The text layer element is owned by TextLayerBuilder and re-created
  // per page render — `textLayerEl` is updated to point at the current
  // builder's div in renderPage.
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private textLayerEl: HTMLDivElement | null = null;
  // Persistent highlight overlay (§5.2). The browser's native ::selection
  // styling disappears the moment focus moves to the comment input, so we
  // mirror the captured rects into a sibling layer the user can keep seeing.
  private highlightLayerEl: HTMLDivElement;

  // PDF.js state
  private doc: PDFDocumentProxy | null = null;
  private page: PDFPageProxy | null = null;
  private viewport: PageViewport | null = null;
  private currentPageNum = 1;
  private zoom: number;

  // Per-render TextLayerBuilder + companions. Re-created on every page
  // change; the prior instance is cancelled (which also aborts its global
  // selection-listener registration via the static #removeGlobalSelectionListener).
  private textLayerBuilder: TextLayerBuilder | null = null;
  private structTreeBuilder: StructTreeLayerBuilder | null = null;
  // AbortController whose signal is passed to the current TextLayerBuilder.
  // Aborted before each new render so the prior builder's listeners go away.
  private renderAbortController: AbortController | null = null;

  constructor(opts: PdfViewerOptions) {
    this.opts = {
      container: opts.container,
      initialZoom: opts.initialZoom ?? 1,
      onSelection: opts.onSelection,
      onPageInfo: opts.onPageInfo,
    };
    this.zoom = this.opts.initialZoom;

    // Stage: positioned wrapper so the text layer can absolute-position
    // over the canvas at the same dimensions. Text-layer element is appended
    // per render (owned by TextLayerBuilder); we only install canvas +
    // highlight overlay at construction.
    this.stage = document.createElement('div');
    this.stage.className = 'pdf-stage';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-canvas';
    this.highlightLayerEl = document.createElement('div');
    this.highlightLayerEl.className = 'pdf-highlight-layer';

    // Order: canvas (bottom) → highlight overlay (middle) → text layer (top,
    // appended in renderPage). The overlay sits below the text layer so
    // native selection rendering still composes naturally.
    this.stage.append(this.canvas, this.highlightLayerEl);
    this.opts.container.replaceChildren(this.stage);

    // Selection capture: mouseup is captured on the document (not just the
    // text layer) because the user can release outside the text layer when
    // selecting across the page edge. A tiny rAF defer lets the browser
    // finalize the selection range before we read it. TextLayerBuilder
    // already owns the mousedown / selectionchange / pointer reset machinery
    // for visual selection — we just read the result here.
    document.addEventListener('mouseup', this.onDocumentMouseUp);
  }

  /** Wipe any persistent highlight rects from the overlay. */
  clearHighlight(): void {
    this.highlightLayerEl.replaceChildren();
  }

  /** Load a PDF from raw bytes (what main returns over IPC). */
  async loadBytes(bytes: Uint8Array): Promise<void> {
    // Clean up any previous document.
    if (this.doc) {
      try { await this.doc.destroy(); } catch { /* ignore */ }
      this.doc = null;
    }

    // PDF.js mutates the input buffer; pass a copy so the caller's bytes
    // stay valid for any retry / cache use.
    const data = new Uint8Array(bytes);
    this.doc = await pdfjsLib.getDocument({ data }).promise;
    this.currentPageNum = 1;
    await this.renderPage(1);
  }

  /** Render a specific page (1-indexed). */
  async renderPage(pageNum: number): Promise<void> {
    if (!this.doc) throw new Error('PdfViewer: no document loaded');
    if (pageNum < 1 || pageNum > this.doc.numPages) {
      throw new Error(`PdfViewer: page ${pageNum} out of range [1, ${this.doc.numPages}]`);
    }

    // Cached screen-rects belong to the previous page/zoom; flush before
    // the canvas reflows under us.
    this.clearHighlight();

    // Tear down the previous text-layer builder (and its global selection
    // listener registration) before laying out the new one.
    this.cancelTextLayer();

    this.currentPageNum = pageNum;
    this.page = await this.doc.getPage(pageNum);
    this.viewport = this.page.getViewport({ scale: this.zoom });

    this.canvas.width = this.viewport.width;
    this.canvas.height = this.viewport.height;
    this.stage.style.width = `${this.viewport.width}px`;
    this.stage.style.height = `${this.viewport.height}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('PdfViewer: canvas 2D context unavailable');

    await this.page.render({
      canvasContext: ctx,
      viewport: this.viewport,
      canvas: this.canvas,
    }).promise;

    // Set up the text layer via PDF.js's reference TextLayerBuilder. The
    // builder creates its own div, wires its own selection trap, and renders
    // text into the div. We slot the div into the stage at the right z-order
    // and set the --total-scale-factor CSS variable PDF.js's text-layer CSS
    // reads at render time.
    this.renderAbortController = new AbortController();
    this.textLayerBuilder = new TextLayerBuilder({
      pdfPage: this.page,
      abortSignal: this.renderAbortController.signal,
    });
    const builderDiv = this.textLayerBuilder.div;
    builderDiv.style.width = `${this.viewport.width}px`;
    builderDiv.style.height = `${this.viewport.height}px`;
    builderDiv.style.setProperty('--total-scale-factor', String(this.zoom));
    // Legacy v3/v4 variable name; some code paths still read it.
    builderDiv.style.setProperty('--scale-factor', String(this.zoom));
    // Clear the persistent highlight overlay on a fresh mousedown inside the
    // text layer — without this a stale highlight stays visible until the
    // next non-collapsed selection (a stationary click never reaches
    // captureSelection). Coexists with TextLayerBuilder's own mousedown.
    builderDiv.addEventListener('mousedown', () => this.clearHighlight());
    this.stage.append(builderDiv);
    this.textLayerEl = builderDiv;

    await this.textLayerBuilder.render({ viewport: this.viewport } as never);

    // StructTreeLayer: appends a parallel DOM of structure-shaped <span>s
    // (from the PDF's tagged-PDF tree) into the canvas element, with
    // aria-owns links back to the textLayer spans. PDFPageView wires this in
    // at L7247–7248 of pdf_viewer.mjs.
    this.structTreeBuilder = new StructTreeLayerBuilder(
      this.page,
      // viewport.rawDims exists on PageViewport at runtime; type is not
      // exposed publicly so we cast through.
      (this.viewport as unknown as { rawDims: unknown }).rawDims,
    );
    const treeDom = await this.structTreeBuilder.render() as unknown as Node | null | undefined;
    if (treeDom) {
      this.structTreeBuilder.updateTextLayer();
      if (treeDom instanceof Node && treeDom.parentNode !== this.canvas) {
        this.canvas.append(treeDom);
      }
    }

    this.opts.onPageInfo?.({ page: this.currentPageNum, totalPages: this.doc.numPages });
  }

  /** Cancel the active text-layer builder + a11y manager + struct tree, and
   *  remove the textLayer div from the stage. Safe to call when nothing is
   *  set up yet. */
  private cancelTextLayer(): void {
    if (this.renderAbortController) {
      this.renderAbortController.abort();
      this.renderAbortController = null;
    }
    if (this.textLayerBuilder) {
      try { this.textLayerBuilder.cancel(); } catch { /* ignore */ }
      this.textLayerBuilder = null;
    }
    if (this.structTreeBuilder) {
      try { this.structTreeBuilder.hide(); } catch { /* ignore */ }
      this.structTreeBuilder = null;
    }
    if (this.textLayerEl && this.textLayerEl.parentNode === this.stage) {
      this.stage.removeChild(this.textLayerEl);
    }
    this.textLayerEl = null;
  }

  /** Navigation helpers. Out-of-range requests are clamped silently. */
  async nextPage(): Promise<void> {
    if (!this.doc) return;
    const next = Math.min(this.currentPageNum + 1, this.doc.numPages);
    if (next !== this.currentPageNum) await this.renderPage(next);
  }
  async prevPage(): Promise<void> {
    if (!this.doc) return;
    const prev = Math.max(this.currentPageNum - 1, 1);
    if (prev !== this.currentPageNum) await this.renderPage(prev);
  }
  async gotoPage(n: number): Promise<void> {
    if (!this.doc) return;
    const clamped = Math.max(1, Math.min(n, this.doc.numPages));
    if (clamped !== this.currentPageNum) await this.renderPage(clamped);
  }

  /** Navigate to the page that owns this anchor and paint a persistent
   * highlight at the captured PDF-space region. Drives the §9.1 "click a
   * comment card to jump to its anchor" affordance. The region was captured
   * in PDF points so it's stable across zoom. */
  async revealAnchor(page: number, region: { x: number; y: number; w: number; h: number }): Promise<void> {
    if (!this.doc) return;
    await this.gotoPage(page);
    if (!this.viewport) return;
    // PDF.js's PDF→viewport projection inverts Y (origin at top), so passing
    // both corners and bbox-ing the result is more robust than transforming
    // a single point + width/height.
    const corners = [
      [region.x, region.y],
      [region.x + region.w, region.y],
      [region.x + region.w, region.y + region.h],
      [region.x, region.y + region.h],
    ].map(([x, y]) => this.viewport!.convertToViewportPoint(x, y));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    const screenRect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    this.drawHighlight([screenRect]);
    // Scroll the highlight into the user's viewport — for tall pages the
    // anchor may be off-screen even after gotoPage. Use the first child of
    // the highlight layer as the scroll target.
    const first = this.highlightLayerEl.firstElementChild;
    if (first && first instanceof HTMLElement) {
      first.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
  }

  get totalPages(): number { return this.doc?.numPages ?? 0; }
  get currentPage(): number { return this.currentPageNum; }
  get currentZoom(): number { return this.zoom; }
  get anchorKind(): AnchorKind { return 'pdf-quad'; }

  /** §13.6 spike: toggle dark-mode rendering (CSS filter on the canvas
   * element only; text layer is unaffected so selection stays accurate). */
  setDarkMode(enabled: boolean): void {
    this.stage.classList.toggle('pdf-dark', enabled);
  }

  isDarkMode(): boolean {
    return this.stage.classList.contains('pdf-dark');
  }

  /** Re-render the current page at a new zoom level. */
  async setZoom(scale: number): Promise<void> {
    if (!this.doc) return;
    const clamped = Math.max(0.1, Math.min(scale, 8));
    if (clamped === this.zoom) return;
    this.zoom = clamped;
    await this.renderPage(this.currentPageNum);
  }

  /** Fit the page so the whole sheet is visible inside the viewer container.
   * Picks the smaller of width-fit and height-fit so neither dimension
   * overflows. */
  async fitPage(): Promise<void> {
    if (!this.page) return;
    const avail = this.availableContainerSize();
    if (!avail) return;
    const vp = this.page.getViewport({ scale: 1 });
    const scale = Math.min(avail.width / vp.width, avail.height / vp.height);
    await this.setZoom(scale);
  }

  /** Fit the page so its width matches the viewer container; vertical
   * dimension scrolls if needed (typical "reading" zoom for long pages). */
  async fitWidth(): Promise<void> {
    if (!this.page) return;
    const avail = this.availableContainerSize();
    if (!avail) return;
    const vp = this.page.getViewport({ scale: 1 });
    await this.setZoom(avail.width / vp.width);
  }

  /** Inner content-area dimensions of the mount container, excluding its
   * padding. Returns null if the container isn't visible yet. */
  private availableContainerSize(): { width: number; height: number } | null {
    const c = this.opts.container;
    const rect = c.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const style = getComputedStyle(c);
    const px = (s: string) => parseFloat(s) || 0;
    return {
      width: rect.width - px(style.paddingLeft) - px(style.paddingRight),
      height: rect.height - px(style.paddingTop) - px(style.paddingBottom),
    };
  }

  /** Disconnect listeners + tear down PDF.js state; safe to call multiple times. */
  dispose(): void {
    document.removeEventListener('mouseup', this.onDocumentMouseUp);
    this.cancelTextLayer();
    if (this.doc) { void this.doc.destroy().catch(() => { /* ignore */ }); }
  }

  // ─── Selection capture ─────────────────────────────────────────────────

  // Arrow fn so `this` is bound when used as the event listener.
  private onDocumentMouseUp = (): void => {
    // Let the browser finalize the selection range before we read it.
    requestAnimationFrame(() => this.captureSelection());
  };

  private captureSelection(): void {
    if (!this.viewport || !this.page || !this.textLayerEl) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

    const range = sel.getRangeAt(0);
    // Only act on selections inside our text layer.
    if (
      !this.textLayerEl.contains(range.commonAncestorContainer) &&
      !this.textLayerEl.contains(range.startContainer)
    ) {
      return;
    }

    const text = sel.toString();
    if (!text.trim()) return;

    const stageRect = this.stage.getBoundingClientRect();
    const rects = Array.from(range.getClientRects())
      .map((r) => ({
        x: r.left - stageRect.left,
        y: r.top - stageRect.top,
        w: r.width,
        h: r.height,
      }))
      .filter((r) => r.w > 0 && r.h > 0);

    if (rects.length === 0) return;

    // Mirror the rects into the persistent highlight overlay so the visual
    // survives the focus shift to the comment input (which collapses the
    // browser's native ::selection rendering).
    this.drawHighlight(rects);

    // Combined screen-space bbox, then convert to PDF coordinates.
    const screenBbox = {
      x: Math.min(...rects.map((r) => r.x)),
      y: Math.min(...rects.map((r) => r.y)),
      w: 0, h: 0,
    };
    screenBbox.w = Math.max(...rects.map((r) => r.x + r.w)) - screenBbox.x;
    screenBbox.h = Math.max(...rects.map((r) => r.y + r.h)) - screenBbox.y;

    const region = this.screenBboxToPdf(screenBbox);

    this.opts.onSelection?.({
      page: this.currentPageNum,
      region,
      screenRects: rects,
      highlighted_text: text,
    });
  }

  private drawHighlight(rects: { x: number; y: number; w: number; h: number }[]): void {
    // PDF.js's text-layer spans frequently overlap horizontally on the same
    // line, and Range.getClientRects() returns one rect per span. Drawing
    // them as-is double-shades the overlapping zones. Merge per visual line
    // so each line gets exactly one rect.
    const merged = mergeRectsByLine(rects);
    const next = merged.map((r) => {
      const el = document.createElement('div');
      el.className = 'pdf-highlight-rect';
      el.style.left = `${r.x}px`;
      el.style.top = `${r.y}px`;
      el.style.width = `${r.w}px`;
      el.style.height = `${r.h}px`;
      return el;
    });
    this.highlightLayerEl.replaceChildren(...next);
  }

  private screenBboxToPdf(s: { x: number; y: number; w: number; h: number }): SelectionPayload['region'] {
    if (!this.viewport) return { x: 0, y: 0, w: 0, h: 0 };
    const corners = [
      [s.x, s.y], [s.x + s.w, s.y],
      [s.x + s.w, s.y + s.h], [s.x, s.y + s.h],
    ].map(([x, y]) => this.viewport!.convertToPdfPoint(x, y));
    const xs = corners.map((p) => p[0]);
    const ys = corners.map((p) => p[1]);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }
}

/** Merge rects that share a visual line (vertical-center within `tol` px) into
 *  their horizontal bounding box. Prevents the multi-rect overlap on every
 *  line that PDF.js's text-layer spans produce. */
type Rect = { x: number; y: number; w: number; h: number };
function mergeRectsByLine(rects: Rect[], tol = 3): Rect[] {
  if (rects.length === 0) return [];
  // Sort top-to-bottom, then left-to-right so the merge sweep is stable.
  const sorted = [...rects].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const out: Rect[] = [];
  for (const r of sorted) {
    const center = r.y + r.h / 2;
    const fit = out.find((o) => Math.abs((o.y + o.h / 2) - center) <= tol);
    if (fit) {
      const right = Math.max(fit.x + fit.w, r.x + r.w);
      const bottom = Math.max(fit.y + fit.h, r.y + r.h);
      fit.x = Math.min(fit.x, r.x);
      fit.y = Math.min(fit.y, r.y);
      fit.w = right - fit.x;
      fit.h = bottom - fit.y;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}
