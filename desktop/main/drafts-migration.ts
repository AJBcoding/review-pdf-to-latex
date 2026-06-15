// §3.3 — LAZY read-time migration of drafts sidecars v1 → v2.
//
// This is the tolerant-reader half of the sidecar-migration precedent
// (domain trap #5), explicitly WITHOUT a startup sweep: `drafts:read` calls
// `migrateDraftsToV2` on the parsed JSON, migrates rows IN MEMORY, and the file
// is rewritten as v2 only on the next `drafts:write` (no startup-blocking
// pass — the Pass-3C startup-cost anti-pattern we deliberately don't repeat).
//
// The mapping is exhaustive over the FIVE real v1 row shapes (§3.3 step 2):
//   1. anchor_kind absent / 'pdf-glyph-rect'      → pdf-quad anchor
//   2. anchor_kind 'md-fuzzy-snippet' + md_anchor → text-quote anchor
//   3. md_anchor carrying smuggled selector fields → html-selector-hint anchor
//   4. new_anchor present (bare {page,region})    → pdf-quad (tolerant parse)
//   5. pdf_annotation_id present                  → native.comment_id
// Everything else: origin 'app-draft'; body/status copied verbatim.
//
// Already-v2 files pass through (with defensive normalization). The decision is
// driven by the per-comment SHAPE, not the file-level anchor_kind — that field
// lied for html/docx (C5/C6), so the comment's own md_anchor/selector is
// authoritative.

import {
  normalizeAnchor,
  type Anchor,
  type CommentOrigin,
  type CommentPayload,
  type CommentPayloadV1,
  type DocFormat,
  type DraftsFile,
} from '@shared/comments';

/** Smuggled-selector sniff — exactly the shipped sniff (renderer/index.ts):
 *  a v1 `md_anchor` that also carries a `selector` field is an html/docx
 *  hybrid, not a real md fuzzy-snippet. */
function hasSelector(md: unknown): md is Record<string, unknown> & { selector: string } {
  return !!md && typeof md === 'object' && typeof (md as Record<string, unknown>).selector === 'string';
}

/** Map one v1 comment's anchor(s) to the union (§3.3 step 2). */
function migrateAnchor(c: CommentPayloadV1): Anchor {
  const md = c.md_anchor as
    | (Record<string, unknown> & { char_start?: number; char_end?: number; prefix?: string; suffix?: string; quoted_text?: string })
    | null
    | undefined;

  // 3. Smuggled html/docx selector hybrid → html-selector-hint. Checked first:
  // the degenerate prefix:''/suffix:'' v1 context is NOT carried into a fake
  // text-quote (§3.3) — a true text-quote is re-captured lazily on next view.
  if (hasSelector(md)) {
    const quoted = typeof md.quoted_text === 'string' ? md.quoted_text : '';
    const charOffset = typeof md.char_offset === 'number' ? md.char_offset : 0;
    const charLength = typeof md.char_length === 'number' ? md.char_length : quoted.length;
    return {
      kind: 'html-selector-hint',
      selector: md.selector,
      char_offset: charOffset,
      char_length: charLength,
      quoted_text: quoted,
    };
  }

  // 2. Clean md fuzzy-snippet → text-quote. The v1 placeholder PDF anchor
  // (page:1, 0×0) is discarded, not preserved.
  if (md && typeof md.quoted_text === 'string') {
    return {
      kind: 'text-quote',
      char_start: typeof md.char_start === 'number' ? md.char_start : -1,
      char_end: typeof md.char_end === 'number' ? md.char_end : -1,
      prefix: typeof md.prefix === 'string' ? md.prefix : '',
      suffix: typeof md.suffix === 'string' ? md.suffix : '',
      quoted_text: md.quoted_text,
      relocated: null,
    };
  }

  // 1. Default: pdf-glyph-rect → pdf-quad from the v1 {page, region} anchor.
  const fromV1 = normalizeAnchor(c.anchor);
  if (fromV1) return fromV1;
  // Defensive fallback for a malformed/missing v1 anchor.
  return { kind: 'pdf-quad', page: 1, region: { x: 0, y: 0, w: 0, h: 0 } };
}

/** Migrate one v1 comment row to v2. */
function migrateComment(c: CommentPayloadV1): CommentPayload {
  const origin: CommentOrigin = 'app-draft';
  // 4. new_anchor (bare {page,region}) → tolerant pdf-quad; null/absent passes.
  const newAnchor = c.new_anchor == null ? null : normalizeAnchor(c.new_anchor);
  // 5. pdf_annotation_id → native.comment_id (app-written, /NM-stamped).
  const native = c.pdf_annotation_id ? { comment_id: c.pdf_annotation_id } : null;
  return {
    id: c.id,
    doc_id: c.doc_id,
    doc_version: c.doc_version,
    anchor: migrateAnchor(c),
    highlighted_text: c.highlighted_text,
    comment: c.comment,
    redraft: c.redraft,
    redraft_suggestion: c.redraft_suggestion,
    engagement_level: c.engagement_level,
    author: c.author,
    kind: 'comment',
    status: c.status,
    created_at: c.created_at,
    submitted_at: c.submitted_at ?? null,
    agent_note: c.agent_note ?? null,
    new_anchor: newAnchor,
    derived_from: c.derived_from ?? null,
    origin,
    native,
  };
}

/** Best-effort format inference when the caller can't supply a path-derived
 *  hint. The next `drafts:write` overwrites `format` from the doc path anyway,
 *  so this only needs to produce a valid value, not a perfect one. */
function inferFormat(comments: CommentPayload[], hint?: DocFormat): DocFormat {
  if (hint) return hint;
  if (comments.some((c) => c.anchor.kind === 'html-selector-hint')) return 'html';
  if (comments.some((c) => c.anchor.kind === 'text-quote')) return 'md';
  return 'pdf';
}

/** Defensive normalization for an already-v2 comment (e.g. one read straight
 *  off a v2 file): ensure `origin` is present and the anchor is union-shaped. */
function normalizeV2Comment(c: CommentPayload): CommentPayload {
  const anchor = normalizeAnchor(c.anchor) ?? c.anchor;
  const newAnchor = c.new_anchor == null ? (c.new_anchor ?? null) : normalizeAnchor(c.new_anchor);
  return {
    ...c,
    anchor,
    new_anchor: newAnchor,
    origin: c.origin ?? 'app-draft',
    native: c.native ?? null,
  };
}

/** Migrate a just-parsed drafts sidecar (any version) to a v2 `DraftsFile`.
 *  `formatHint` should be the path-derived format when available (main passes
 *  it from `classifyPath`); omitted in tests that exercise inference. */
export function migrateDraftsToV2(parsed: unknown, formatHint?: DocFormat): DraftsFile {
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const docVersion = typeof obj.doc_version === 'string' ? obj.doc_version : '';
  const rawComments = Array.isArray(obj.comments) ? obj.comments : [];

  // Already v2 — pass through with defensive normalization.
  if (obj.schema_version === 2) {
    const comments = (rawComments as CommentPayload[]).map(normalizeV2Comment);
    const existingFormat = typeof obj.format === 'string' ? (obj.format as DocFormat) : undefined;
    const out: DraftsFile = {
      schema_version: 2,
      doc_version: docVersion,
      format: existingFormat ?? inferFormat(comments, formatHint),
      comments,
    };
    if (obj.doc_fingerprint) out.doc_fingerprint = obj.doc_fingerprint as DraftsFile['doc_fingerprint'];
    return out;
  }

  // v1 (schema_version 1 or legacy/absent): migrate every row.
  const comments = (rawComments as CommentPayloadV1[]).map(migrateComment);
  const out: DraftsFile = {
    schema_version: 2,
    doc_version: docVersion,
    format: inferFormat(comments, formatHint),
    comments,
  };
  if (obj.doc_fingerprint) out.doc_fingerprint = obj.doc_fingerprint as DraftsFile['doc_fingerprint'];
  return out;
}
