import type { Anchor, AnchorKind, CommentPayload } from './types';

export interface FileViewerPageInfo {
  page: number;
  totalPages: number;
}

/** What a viewer can do — read by the host (X7) instead of branching on
 *  `classifyPath` at every decision point. `paged` gates the prev/next/fit
 *  chrome; `editableText` drives the .md save-debounce + external-change
 *  watch; `submit` is the pre-v2 C5 guard (PDF-only Submit pipeline). */
export interface ViewerCapabilities {
  readonly paged: boolean;
  readonly editableText: boolean;
  readonly submit: boolean;
}

/** Viewer-native selection, unified across formats as a discriminated union
 *  keyed by the anchor kind it produces (X7). Replaces the three divergent
 *  SelectionPayload / MdSelection / HtmlSelection callbacks and the matching
 *  trio of `lastSelection` module lets. */
export type ViewerSelection =
  | {
      kind: 'pdf-quad';
      text: string;
      page: number;
      region: { x: number; y: number; w: number; h: number };
    }
  | {
      kind: 'text-quote';
      text: string;
      from: number;
      to: number;
    }
  | {
      kind: 'html-selector-hint';
      text: string;
      selector: string;
      charOffset: number;
      charLength: number;
    };

/** Per-load context handed to `loadBytes`. Currently just the absolute path
 *  (the iframe viewers resolve a `<base href>` from it); kept as an object so
 *  later milestones can thread format/version hints without another signature
 *  break. */
export interface ViewerLoadContext {
  path: string;
}

export interface FileViewer {
  readonly totalPages: number;
  readonly currentPage: number;
  readonly anchorKind: AnchorKind;
  readonly capabilities: ViewerCapabilities;

  loadBytes(bytes: Uint8Array, ctx?: ViewerLoadContext): Promise<void>;
  nextPage(): Promise<void>;
  prevPage(): Promise<void>;
  fitPage(): Promise<void>;
  fitWidth(): Promise<void>;
  setDarkMode(enabled: boolean): void;
  isDarkMode(): boolean;

  /** Re-project the live comment set into viewer state: fuzzy-track the
   *  anchored ranges (md), highlight them (html/docx), or no-op (pdf). The
   *  viewer may mutate the passed anchors' resolved offsets in place (md
   *  keeps the v1 in-place re-anchor until X12 rewires provenance). */
  applyAnchors(comments: CommentPayload[]): void;

  /** Scroll/navigate to a comment's anchor and surface it. No-op for formats
   *  that can't meaningfully reveal (md/html/docx today). */
  reveal(anchor: Anchor): void;

  dispose(): void;
}
