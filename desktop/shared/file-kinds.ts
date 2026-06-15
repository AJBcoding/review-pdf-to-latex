// Single source of truth for path → document-format classification (X7).
//
// Before this module the same suffix→kind knowledge was hand-rolled in ≥4
// places that drifted apart: renderer `classifyPath`, main `classifyFile`
// (extname-based), main `draftFormatForPath`, and the recursive PDF indexer.
// They now all funnel through `classifyPath` here so a new format is taught to
// the app in exactly one spot.

import type { DocFormat } from './comments';

/** Kinds the tree distinguishes. `pdf`/`md`/`html`/`docx` open in the middle
 *  pane; `other` renders dimmed and inert (§3.2). */
export type FileKind = 'pdf' | 'md' | 'html' | 'docx' | 'other';

/** Classify a path (or bare basename) by its filename suffix. Case-insensitive.
 *  This is the ONE place that maps extensions to kinds — `classifyFile`, the
 *  PDF indexer, and the drafts `format` hint all defer to it. */
export function classifyPath(path: string): FileKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.docx')) return 'docx';
  return 'other';
}

/** Path-derived DraftsFile v2 `format` (§3.3). `other` collapses to `pdf` —
 *  the same safe default the v1 `anchor_kind` carried. */
export function docFormatForPath(path: string): DocFormat {
  const k = classifyPath(path);
  return k === 'other' ? 'pdf' : k;
}
