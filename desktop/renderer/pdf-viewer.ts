// PDF viewer — renders one page at a time, with PDF.js's TextLayer overlaid
// on the canvas so native browser text selection produces a glyph-accurate
// highlight payload (per ux-spec §5.2).
//
// Architecture validated by the 2026-05-20 spike (see
// docs/research/2026-05-20-pdf-text-layer-spike/README.md). This module is the
// production port of the spike's spike.html: same TextLayer approach, same
// selection-rect math, same coordinate conversion.
//
// Out of scope for this milestone:
// - File picker (#2)
// - Health banner integration (#2)
// - Routing the captured selection to a comment-card stream (#3 + #4)
// Selections are surfaced into a callback the host wires up; for now the
// host just logs them.

import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from 'pdfjs-dist';
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

export class PdfViewer {
  private opts: Required<Omit<PdfViewerOptions, 'onSelection' | 'onPageInfo'>>
              & Pick<PdfViewerOptions, 'onSelection' | 'onPageInfo'>;

  // DOM
  private stage: HTMLElement;
  private canvas: HTMLCanvasElement;
  private textLayerEl: HTMLDivElement;

  // PDF.js state
  private doc: PDFDocumentProxy | null = null;
  private page: PDFPageProxy | null = null;
  private viewport: PageViewport | null = null;
  private currentPageNum = 1;
  private zoom: number;

  // Selection debouncer so we capture at the END of the drag, not on every
  // intermediate selectionchange event.
  private selectionDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PdfViewerOptions) {
    this.opts = {
      container: opts.container,
      initialZoom: opts.initialZoom ?? 1,
      onSelection: opts.onSelection,
      onPageInfo: opts.onPageInfo,
    };
    this.zoom = this.opts.initialZoom;

    // Stage: positioned wrapper so the text layer can absolute-position
    // over the canvas at the same dimensions.
    this.stage = document.createElement('div');
    this.stage.className = 'pdf-stage';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pdf-canvas';
    this.textLayerEl = document.createElement('div');
    this.textLayerEl.className = 'textLayer';

    this.stage.append(this.canvas, this.textLayerEl);
    this.opts.container.replaceChildren(this.stage);

    document.addEventListener('selectionchange', this.onSelectionChange);
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

    this.currentPageNum = pageNum;
    this.page = await this.doc.getPage(pageNum);
    this.viewport = this.page.getViewport({ scale: this.zoom });

    this.canvas.width = this.viewport.width;
    this.canvas.height = this.viewport.height;
    this.stage.style.width = `${this.viewport.width}px`;
    this.stage.style.height = `${this.viewport.height}px`;
    this.textLayerEl.style.width = `${this.viewport.width}px`;
    this.textLayerEl.style.height = `${this.viewport.height}px`;
    // PDF.js v4+ TextLayer reads --scale-factor off the container.
    // PDF.js v5 reads --total-scale-factor (not --scale-factor) off the
    // container; --scale-factor is the legacy v3/v4 name. Setting both for
    // belt-and-suspenders against any code path that still reads the old.
    this.textLayerEl.style.setProperty('--scale-factor', String(this.zoom));
    this.textLayerEl.style.setProperty('--total-scale-factor', String(this.zoom));

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('PdfViewer: canvas 2D context unavailable');

    await this.page.render({ canvasContext: ctx, viewport: this.viewport, canvas: this.canvas }).promise;

    // Build the text layer.
    this.textLayerEl.replaceChildren();
    const textContent = await this.page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: this.textLayerEl,
      viewport: this.viewport,
    });
    await textLayer.render();

    this.opts.onPageInfo?.({ page: this.currentPageNum, totalPages: this.doc.numPages });
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

  get totalPages(): number { return this.doc?.numPages ?? 0; }
  get currentPage(): number { return this.currentPageNum; }
  get currentZoom(): number { return this.zoom; }

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

  /** Disconnect listeners; safe to call multiple times. */
  dispose(): void {
    document.removeEventListener('selectionchange', this.onSelectionChange);
    if (this.selectionDebounce) clearTimeout(this.selectionDebounce);
    if (this.doc) { void this.doc.destroy().catch(() => { /* ignore */ }); }
  }

  // ─── Selection capture ─────────────────────────────────────────────────

  // Arrow fn so `this` is bound when used as the event listener.
  private onSelectionChange = (): void => {
    if (this.selectionDebounce) clearTimeout(this.selectionDebounce);
    this.selectionDebounce = setTimeout(() => this.captureSelection(), 120);
  };

  private captureSelection(): void {
    if (!this.viewport || !this.page) return;
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
