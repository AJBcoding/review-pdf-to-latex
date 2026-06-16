// §5.2 / L4 — PDF round-trip WRITE half: the `pdf-comments.ts` adapter.
//
// This module extends bundle.ts's hand-built /Highlight writer (bundle.ts:62-112)
// into the full per-format PDF adapter (spec §5.1/§5.2): READ native annotations,
// CREATE (Highlight + StrikeOut + Text/sticky), EDIT (locate by /NM, else by the
// read-time `(page_index, annot_index)` handle — stamping /NM on first edit of a
// foreign annot so subsequent edits are id-addressed), DELETE (remove the ref from
// /Annots), and reply chains via /IRT.
//
// Split-library convention (spec §5.2): pdf.js reads + displays in the renderer;
// pdf-lib writes in the main process. The pdf-lib READ here is the main-process
// twin used by EDIT/DELETE to resolve handles and to ingest foreign annotations —
// it is NOT the renderer display path.
//
// Spike provenance:
//   - rev-cvr (spike.mjs): the Highlight/StrikeOut/Text dict shapes + the
//     PDF.js→pdf-lib coord identity. buildQuadMarkup mirrors spike `buildHighlight`.
//   - rev-n7 (spike-irt.mjs): /IRT reply chains PROVEN read+write — the kill ladder
//     did NOT fire, so the adapter keeps full reply scope (capabilities.replies =
//     true). A reply is a /Text annot carrying /IRT (an indirect REF to the parent)
//     + /RT /R. pdf.js exposes `.inReplyTo` as the parent's REF-ID string (e.g.
//     '10R'), NOT /NM — so every annot we write is stamped with a stable /NM and
//     the read side resolves IRT-ref → parent's comment_id via a ref-key map.
//   - rev-n8 (spike per-line quads): per-line /QuadPoints write-back survives the
//     Acrobat re-save cycle — so PdfQuadAnchor.quads[] is FULL-FIDELITY: one quad
//     per visual line. /Rect stays the union bbox; the single-line case is
//     byte-identical to the shipped single-bbox writer (backward compatible).
//
// Deferred (port-don't-invoke, spec §5.2): the engine's pdfplumber bbox-crop
// fallback (extract.py:113-156) and sticky→highlight association (extract.py:176-243)
// are port candidates into this adapter WHEN foreign-PDF breadth lands. They are not
// wired here; the live read path is pdf.js/pdf-lib, never engine extraction
// (5A PDF-C rejection). See the follow-up bead filed by L4.

import { readFile } from 'node:fs/promises';
import { atomicWrite } from './atomic-write.js';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFHexString,
  PDFNumber,
  PDFArray,
  PDFDict,
  PDFRef,
} from 'pdf-lib';
import type { PDFPage } from 'pdf-lib';
import type {
  Anchor,
  CommentOrigin,
  CommentPayload,
  CommentStatus,
  EngagementLevel,
  NativeAnnotationRef,
  PdfQuadAnchor,
  Quad,
} from '@shared/types.js';
import { ENGAGEMENT_PALETTE } from '@shared/bundle.js';

// ─── adapter capabilities (spec §5.1 table) ───────────────────────────────
//
// `replies: true` per the rev-n7 spike outcome (BOTH halves proven). PDF body
// text is not editable (only the comment/markup, not the page content).
export const PDF_CAPABILITIES = {
  format: 'pdf' as const,
  readNative: true,
  writeNative: true,
  editNative: true,
  deleteNative: true,
  replies: true,
  bodyEditable: false,
} as const;

/** PDF markup subtypes the adapter understands. Quad-based markups
 *  (Highlight/StrikeOut/Underline/Squiggly) share one dict shape; Text is the
 *  sticky-note icon. Anything else read off a foreign PDF is preserved but
 *  surfaced under its raw subtype string. */
const QUAD_MARKUP_SUBTYPES = ['Highlight', 'StrikeOut', 'Underline', 'Squiggly'] as const;
const MARKUP_SUBTYPES = [...QUAD_MARKUP_SUBTYPES, 'Text'] as const;
type MarkupSubtype = (typeof MARKUP_SUBTYPES)[number];

const STICKY_ICON_SIZE = 20; // pt; the conventional /Text icon box (spike.mjs)

// ─── date helpers ──────────────────────────────────────────────────────────

/** PDF date format: `D:YYYYMMDDHHmmSSOHH'mm'`. UTC; offset always +00'00'.
 *  Verbatim from bundle.ts so app-written annots carry one consistent shape. */
function pdfDateUtc(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `D:${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}` +
    `+00'00'`
  );
}

/** Parse a PDF `/M` date string into an ISO timestamp, best-effort. Accepts the
 *  `D:YYYYMMDDHHmmSS` core (with or without `D:`, with any trailing offset/`Z`).
 *  Returns null when the string is not a recognizable PDF date so the caller can
 *  fall back without inventing a timestamp. */
function parsePdfDate(raw: string | null): string | null {
  if (!raw) return null;
  const m = raw.match(/^D?:?(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const [, y, mo, da, h = '00', mi = '00', s = '00'] = m;
  const iso = `${y}-${mo}-${da}T${h}:${mi}:${s}.000Z`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// ─── geometry: per-line quads (rev-n8) ─────────────────────────────────────

/** QuadPoints for one region in Acrobat order (UL, UR, LL, LR) — 8 numbers.
 *  This is the order every viewer of consequence uses (spike.mjs note), despite
 *  the spec's CCW wording. */
function regionQuad(r: { x: number; y: number; w: number; h: number }): number[] {
  return [
    r.x,       r.y + r.h, // UL
    r.x + r.w, r.y + r.h, // UR
    r.x,       r.y,       // LL
    r.x + r.w, r.y,       // LR
  ];
}

/** A typed Quad → the 8-number Acrobat-order run. */
function quadToNumbers(q: Quad): number[] {
  return [q.x1, q.y1, q.x2, q.y2, q.x3, q.y3, q.x4, q.y4];
}

/** Flatten an anchor into the /QuadPoints number array. Prefers the per-line
 *  `quads[]` (rev-n8 full fidelity — one quad per visual line); falls back to a
 *  single quad over the bbox `region` (byte-identical to the shipped single-bbox
 *  writer when there is exactly one line). */
function quadPointsForAnchor(anchor: PdfQuadAnchor): number[] {
  if (anchor.quads && anchor.quads.length > 0) {
    return anchor.quads.flatMap(quadToNumbers);
  }
  return regionQuad(anchor.region);
}

/** Union bbox `[x1,y1,x2,y2]` of all quads (or the region when there are none).
 *  /Rect must enclose every /QuadPoints quad (PDF 1.7 §12.5.6.10). */
function rectForAnchor(anchor: PdfQuadAnchor): [number, number, number, number] {
  const nums = quadPointsForAnchor(anchor);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < nums.length; i += 2) {
    xs.push(nums[i]);
    ys.push(nums[i + 1]);
  }
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

// ─── /Annots access helpers ────────────────────────────────────────────────

/** The page's /Annots array, or null when the page has none. */
function pageAnnots(page: PDFPage): PDFArray | null {
  const existing = page.node.lookup(PDFName.of('Annots'));
  return existing instanceof PDFArray ? existing : null;
}

/** Append an annotation ref to a page's /Annots, creating the array if absent. */
function appendAnnotRef(doc: PDFDocument, page: PDFPage, ref: PDFRef): void {
  const existing = pageAnnots(page);
  if (existing) {
    existing.push(ref);
  } else {
    page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
  }
}

/** Decode a PDF string value (literal or hex, incl. UTF-16BE) to JS text. */
function decodePdfString(v: unknown): string | null {
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  return null;
}

/** Look up `key` and return it only if it resolves to a PDFArray, else null.
 *  Unlike pdf-lib's two-arg `lookup(key, PDFArray)`, this does NOT throw when the
 *  key is absent (a sticky /Text annot has no /QuadPoints). */
function lookupArray(dict: PDFDict, key: string): PDFArray | null {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFArray ? v : null;
}

/** `${objectNumber}R` ref-key, matching pdf.js's `.inReplyTo` id strings so a
 *  read can map an /IRT ref to the parent it points at. */
function refKey(ref: PDFRef | null): string | null {
  return ref ? `${ref.objectNumber}R` : null;
}

// ─── name (/NM) minting ────────────────────────────────────────────────────

/** Collect every /NM already present in the document so minting never collides
 *  (app `annot-<n>` ids AND arbitrary foreign names). */
function collectExistingNames(doc: PDFDocument): Set<string> {
  const names = new Set<string>();
  for (const page of doc.getPages()) {
    const annots = pageAnnots(page);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict);
      const nm = a && decodePdfString(a.lookup(PDFName.of('NM')));
      if (nm) names.add(nm);
    }
  }
  return names;
}

/** A deterministic, collision-free /NM for a foreign annot located by its
 *  `(page_index, annot_index)` handle. Deterministic (no RNG) so a re-edit of
 *  the same foreign annot before the first save still resolves; the `taken` set
 *  guards the rare clash with an existing name. */
function nameForHandle(pageIndex: number, annotIndex: number, taken: Set<string>): string {
  let base = `annot-p${pageIndex}-i${annotIndex}`;
  let name = base;
  let n = 1;
  while (taken.has(name)) name = `${base}-${n++}`;
  return name;
}

// ─── colour ────────────────────────────────────────────────────────────────

/** /C colour for an app-written annot: the engagement palette, unless the
 *  comment carries a native colour to round-trip. Returns [r,g,b] in [0,1]. */
function colorForComment(comment: CommentPayload): [number, number, number] {
  const palette = ENGAGEMENT_PALETTE[comment.engagement_level];
  return [palette.pdfC[0], palette.pdfC[1], palette.pdfC[2]];
}

// ─── builders ──────────────────────────────────────────────────────────────

interface MarkupBuildArgs {
  subtype: MarkupSubtype;
  anchor: PdfQuadAnchor;
  contents: string;
  author: string;
  color: [number, number, number];
  opacity: number;
  /** Stable annotation name → maps to native.comment_id. */
  name: string;
  date: Date;
  /** Reply pointer: an indirect REF to the parent annot (rev-n7 /IRT). */
  inReplyToRef?: PDFRef;
}

/** Build a markup annotation dict (Highlight/StrikeOut/Underline/Squiggly/Text).
 *  Quad markups carry /QuadPoints (per-line, rev-n8); /Text is a sticky-note icon
 *  sized at the region's lower-left corner. A reply adds /IRT (ref→parent) + /RT
 *  /R (threaded reply) and is always emitted as /Text (rev-n7). */
function buildMarkupAnnot(doc: PDFDocument, pageRef: PDFRef, args: MarkupBuildArgs): PDFDict {
  const ctx = doc.context;
  const isQuadMarkup = (QUAD_MARKUP_SUBTYPES as readonly string[]).includes(args.subtype);

  const dict = ctx.obj({
    Type: PDFName.of('Annot'),
    Subtype: PDFName.of(args.subtype),
    Rect: ctx.obj(isQuadMarkup ? rectForAnchor(args.anchor) : stickyRect(args.anchor)),
    Contents: PDFString.of(args.contents),
    T: PDFString.of(args.author),
    M: PDFString.of(pdfDateUtc(args.date)),
    NM: PDFString.of(args.name),
    F: PDFNumber.of(4), // /F=4 = print
    C: ctx.obj(args.color),
    CA: PDFNumber.of(args.opacity),
    P: pageRef,
  });

  if (isQuadMarkup) {
    dict.set(PDFName.of('QuadPoints'), ctx.obj(quadPointsForAnchor(args.anchor)));
  } else {
    // /Text sticky-note: pick an icon, default closed.
    dict.set(PDFName.of('Name'), PDFName.of('Note'));
    dict.set(PDFName.of('Open'), ctx.obj(false));
  }

  if (args.inReplyToRef) {
    dict.set(PDFName.of('IRT'), args.inReplyToRef); // indirect ref to the parent annot
    dict.set(PDFName.of('RT'), PDFName.of('R'));     // threaded-reply type
  }

  return dict;
}

/** /Rect for a /Text sticky: a `STICKY_ICON_SIZE` box at the region's
 *  lower-left, so the icon lands on the anchored span. */
function stickyRect(anchor: PdfQuadAnchor): [number, number, number, number] {
  const r = anchor.region;
  return [r.x, r.y, r.x + STICKY_ICON_SIZE, r.y + STICKY_ICON_SIZE];
}

/** The /Subtype to write for an app-draft comment: its declared
 *  `native.subtype` when it is one we emit, else /Highlight (the v1 default). A
 *  reply is forced to /Text by the writer regardless. */
function subtypeForComment(comment: CommentPayload): MarkupSubtype {
  const declared = comment.native?.subtype;
  if (declared && (MARKUP_SUBTYPES as readonly string[]).includes(declared)) {
    return declared as MarkupSubtype;
  }
  return 'Highlight';
}

/** The /Contents text for a comment, mirroring bundle.ts: the comment body with
 *  an appended `[redraft] …` block when the user supplied a redraft. */
function contentsForComment(comment: CommentPayload): string {
  return comment.redraft
    ? `${comment.comment}\n[redraft] ${comment.redraft}`.trim()
    : (comment.comment || '');
}

// ─── WRITE: create (in-place, duplicate-safe) ──────────────────────────────

export interface PdfWriteResult {
  /** commentId → the /NM stamped onto its annotation. */
  idMap: Record<string, string>;
  /** Comments skipped (out-of-range page, unresolved reply parent, …). */
  skipped: { id: string; reason: string }[];
}

/** Add app-draft comments to an already-loaded document, in place. Honors the
 *  §5.2 duplicate-prevention rule: ONLY `origin === 'app-draft'` comments are
 *  emitted as new annotations; `native-*` rows already live in the file and are
 *  preserved (never re-emitted). Replies (`native.in_reply_to` set) are written
 *  as /Text + /IRT pointing at the parent's annot ref, resolved by /NM across
 *  both pre-existing annots and comments created earlier in this same call.
 *
 *  Pages outside [1, pageCount] are skipped with a soft record — a stale anchor
 *  must not fail the whole write. Returns the id→/NM map so the caller can mirror
 *  the stamped ids onto the in-memory drafts (saves a round-trip), mirroring the
 *  bundle writer's `annotationIds` contract. */
export function addCommentsToDoc(doc: PDFDocument, comments: CommentPayload[], date: Date): PdfWriteResult {
  const idMap: Record<string, string> = {};
  const skipped: { id: string; reason: string }[] = [];
  const taken = collectExistingNames(doc);
  const totalPages = doc.getPageCount();

  // Ref-by-/NM index over annots already in the file, so replies can target a
  // foreign or previously-written parent. Extended as we mint new annots.
  const refByName = indexRefsByName(doc);

  // Mint app ids as `annot-<n>` above any existing numeric suffix (bundle.ts
  // precedent), so app ids stay stable and human-legible.
  let counter = highestAnnotCounter(taken);
  const mintAppName = (): string => {
    let name = `annot-${++counter}`;
    while (taken.has(name)) name = `annot-${++counter}`;
    taken.add(name);
    return name;
  };

  for (const comment of comments) {
    if (comment.origin !== 'app-draft') continue; // duplicate-prevention rule
    if (comment.anchor.kind !== 'pdf-quad') {
      skipped.push({ id: comment.id, reason: `non-pdf-quad anchor (${comment.anchor.kind})` });
      continue;
    }
    const anchor = comment.anchor;
    if (anchor.page < 1 || anchor.page > totalPages) {
      skipped.push({ id: comment.id, reason: `out-of-range page ${anchor.page}` });
      continue;
    }

    // Reply target (if any) must resolve to an annot ref by /NM.
    let inReplyToRef: PDFRef | undefined;
    const parentName = comment.native?.in_reply_to;
    if (parentName) {
      const parentRef = refByName.get(parentName);
      if (!parentRef) {
        skipped.push({ id: comment.id, reason: `reply parent '${parentName}' not found` });
        continue;
      }
      inReplyToRef = parentRef;
    }

    const name = comment.native?.comment_id ?? mintAppName();
    const subtype: MarkupSubtype = inReplyToRef ? 'Text' : subtypeForComment(comment);
    const palette = ENGAGEMENT_PALETTE[comment.engagement_level];

    const dict = buildMarkupAnnot(doc, doc.getPage(anchor.page - 1).ref, {
      subtype,
      anchor,
      contents: contentsForComment(comment),
      author: comment.author,
      color: colorForComment(comment),
      opacity: palette.pdfCA,
      name,
      date,
      inReplyToRef,
    });
    const ref = doc.context.register(dict);
    appendAnnotRef(doc, doc.getPage(anchor.page - 1), ref);
    refByName.set(name, ref);
    taken.add(name);
    idMap[comment.id] = name;
  }

  return { idMap, skipped };
}

/** Highest `annot-<n>` numeric suffix among existing names (or 0). */
function highestAnnotCounter(names: Set<string>): number {
  let max = 0;
  for (const n of names) {
    const m = n.match(/^annot-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max;
}

/** Map every annot's /NM → its indirect ref, for reply targeting. */
function indexRefsByName(doc: PDFDocument): Map<string, PDFRef> {
  const out = new Map<string, PDFRef>();
  for (const page of doc.getPages()) {
    const annots = pageAnnots(page);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const own = annots.get(i);
      const a = annots.lookup(i, PDFDict);
      if (!(own instanceof PDFRef) || !a) continue;
      const nm = decodePdfString(a.lookup(PDFName.of('NM')));
      if (nm) out.set(nm, own);
    }
  }
  return out;
}

// ─── EDIT / DELETE: annot location ─────────────────────────────────────────

/** A located annotation: the page it lives on, its /Annots array, its index in
 *  that array, and the dict itself. */
interface AnnotLocation {
  page: PDFPage;
  pageIndex: number;
  annots: PDFArray;
  index: number;
  dict: PDFDict;
}

/** Locate an annot by /NM. O(annots), first match wins. */
function locateByName(doc: PDFDocument, name: string): AnnotLocation | null {
  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p++) {
    const annots = pageAnnots(pages[p]);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const a = annots.lookup(i, PDFDict);
      if (a && decodePdfString(a.lookup(PDFName.of('NM'))) === name) {
        return { page: pages[p], pageIndex: p, annots, index: i, dict: a };
      }
    }
  }
  return null;
}

/** Locate an annot by its read-time `(page_index, annot_index)` handle — the
 *  fallback for foreign annots that lack a /NM (5A rec (i)). */
function locateByHandle(doc: PDFDocument, pageIndex: number, annotIndex: number): AnnotLocation | null {
  const pages = doc.getPages();
  if (pageIndex < 0 || pageIndex >= pages.length) return null;
  const annots = pageAnnots(pages[pageIndex]);
  if (!annots || annotIndex < 0 || annotIndex >= annots.size()) return null;
  const a = annots.lookup(annotIndex, PDFDict);
  if (!a) return null;
  return { page: pages[pageIndex], pageIndex, annots, index: annotIndex, dict: a };
}

/** A handle into a PDF annotation: prefer the /NM; fall back to the read-time
 *  `(pageIndex, annotIndex)` position for foreign annots that have no name yet. */
export type AnnotHandle = { nm: string } | { pageIndex: number; annotIndex: number };

function locate(doc: PDFDocument, handle: AnnotHandle): AnnotLocation | null {
  return 'nm' in handle
    ? locateByName(doc, handle.nm)
    : locateByHandle(doc, handle.pageIndex, handle.annotIndex);
}

export interface EditResult {
  ok: boolean;
  /** The stable /NM the annot is now addressed by (minted on first edit of a
   *  foreign annot). Null when the annot could not be located. */
  name: string | null;
}

/** Edit an annot's comment text in place. Locates by /NM or by the
 *  `(page,index)` handle; **stamps a /NM on the first edit of a foreign annot**
 *  (rev-n7 stable-id requirement) so subsequent edits are id-addressed. Updates
 *  /Contents and refreshes /M. */
export function editAnnotInDoc(doc: PDFDocument, handle: AnnotHandle, newText: string, date: Date): EditResult {
  const loc = locate(doc, handle);
  if (!loc) return { ok: false, name: null };

  let name = decodePdfString(loc.dict.lookup(PDFName.of('NM')));
  if (!name) {
    // Foreign annot, no /NM yet → stamp a deterministic one now.
    const taken = collectExistingNames(doc);
    name = nameForHandle(loc.pageIndex, loc.index, taken);
    loc.dict.set(PDFName.of('NM'), PDFString.of(name));
  }
  loc.dict.set(PDFName.of('Contents'), PDFString.of(newText));
  loc.dict.set(PDFName.of('M'), PDFString.of(pdfDateUtc(date)));
  return { ok: true, name };
}

/** Delete an annot in place: remove its ref from the page's /Annots, then
 *  cascade to any replies that /IRT it (transitively) so no dangling reply
 *  pointer survives the re-save. Returns the /NM (or handle key) of every annot
 *  removed. */
export function deleteAnnotFromDoc(doc: PDFDocument, handle: AnnotHandle): { ok: boolean; removed: string[] } {
  const loc = locate(doc, handle);
  if (!loc) return { ok: false, removed: [] };

  // Collect the target ref + the full reply subtree (by /IRT) before mutating.
  const targetRef = loc.annots.get(loc.index);
  if (!(targetRef instanceof PDFRef)) return { ok: false, removed: [] };

  const toRemove = collectReplySubtree(doc, targetRef);
  const removed: string[] = [];

  // Remove from each page's /Annots. Walk indices high→low so removals don't
  // shift the indices still to be checked.
  for (const page of doc.getPages()) {
    const annots = pageAnnots(page);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const own = annots.get(i);
      if (own instanceof PDFRef && toRemove.has(refKey(own)!)) {
        const dict = annots.lookup(i, PDFDict);
        const nm = dict && decodePdfString(dict.lookup(PDFName.of('NM')));
        removed.push(nm ?? refKey(own)!);
        annots.remove(i);
      }
    }
  }
  return { ok: removed.length > 0, removed };
}

/** Ref-keys of `rootRef` plus every annot that replies to it transitively. */
function collectReplySubtree(doc: PDFDocument, rootRef: PDFRef): Set<string> {
  const keep = new Set<string>([refKey(rootRef)!]);
  // Repeated passes until no new descendant is found (reply chains are short).
  let grew = true;
  while (grew) {
    grew = false;
    for (const page of doc.getPages()) {
      const annots = pageAnnots(page);
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const own = annots.get(i);
        if (!(own instanceof PDFRef) || keep.has(refKey(own)!)) continue;
        const a = annots.lookup(i, PDFDict);
        const irt = a?.get(PDFName.of('IRT'));
        if (irt instanceof PDFRef && keep.has(refKey(irt)!)) {
          keep.add(refKey(own)!);
          grew = true;
        }
      }
    }
  }
  return keep;
}

// ─── READ: native annotations → CommentPayload ─────────────────────────────

/** A native PDF annotation as read off disk (pdf-lib walk), before mapping into
 *  the unified CommentPayload. */
export interface PdfNativeAnnot {
  /** Stable id: the /NM if present, else a synthetic `p{page}-i{index}` handle. */
  commentId: string;
  /** True when the id came from a real /NM (vs a synthetic handle). */
  hasName: boolean;
  subtype: string;
  pageIndex: number;
  annotIndex: number;
  region: { x: number; y: number; w: number; h: number };
  quads: Quad[];
  contents: string;
  author: string | null;
  color: string | null;
  created: string | null;
  /** Parent's commentId, resolved from this annot's /IRT ref (rev-n7). */
  inReplyTo: string | null;
}

/** Quads parsed from a /QuadPoints array (8 numbers per quad, Acrobat order). */
function parseQuads(qp: PDFArray | null): Quad[] {
  if (!qp) return [];
  const out: Quad[] = [];
  for (let k = 0; k + 7 < qp.size(); k += 8) {
    const n = (j: number) => {
      const v = qp.lookup(k + j, PDFNumber);
      return v ? v.asNumber() : 0;
    };
    out.push({ x1: n(0), y1: n(1), x2: n(2), y2: n(3), x3: n(4), y3: n(5), x4: n(6), y4: n(7) });
  }
  return out;
}

/** Walk every markup annotation in the document. Two passes: pass 1 assigns each
 *  annot a commentId (/NM or synthetic handle) and records its ref-key; pass 2
 *  resolves /IRT refs to the parent's commentId. */
export function readAnnotsFromDoc(doc: PDFDocument): PdfNativeAnnot[] {
  interface Raw {
    annot: PdfNativeAnnot;
    ownKey: string | null;
    irtKey: string | null;
  }
  const raws: Raw[] = [];
  const idByRefKey = new Map<string, string>();

  const pages = doc.getPages();
  for (let p = 0; p < pages.length; p++) {
    const annots = pageAnnots(pages[p]);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const own = annots.get(i);
      const a = annots.lookup(i, PDFDict);
      if (!a) continue;
      const subtypeName = a.lookup(PDFName.of('Subtype'));
      if (!(subtypeName instanceof PDFName)) continue;
      const subtype = subtypeName.asString().replace(/^\//, '');
      if (!(MARKUP_SUBTYPES as readonly string[]).includes(subtype)) continue;

      const nm = decodePdfString(a.lookup(PDFName.of('NM')));
      const commentId = nm ?? `p${p}-i${i}`;
      const ownKey = own instanceof PDFRef ? refKey(own) : null;
      if (ownKey) idByRefKey.set(ownKey, commentId);

      const rectArr = lookupArray(a, 'Rect');
      const rect = rectArr ? rectArr.asRectangle() : null;
      const qp = lookupArray(a, 'QuadPoints');
      const colorArr = lookupArray(a, 'C');
      const irt = a.get(PDFName.of('IRT'));

      raws.push({
        ownKey,
        irtKey: irt instanceof PDFRef ? refKey(irt) : null,
        annot: {
          commentId,
          hasName: nm != null,
          subtype,
          pageIndex: p,
          annotIndex: i,
          region: rect
            ? { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
            : { x: 0, y: 0, w: 0, h: 0 },
          quads: parseQuads(qp),
          contents: decodePdfString(a.lookup(PDFName.of('Contents'))) ?? '',
          author: decodePdfString(a.lookup(PDFName.of('T'))),
          color: colorArr ? colorArr.asArray().map((n) => (n as PDFNumber).asNumber()).join(',') : null,
          created: parsePdfDate(decodePdfString(a.lookup(PDFName.of('M')))),
          inReplyTo: null,
        },
      });
    }
  }

  // Pass 2: resolve IRT ref-keys to the parent's commentId.
  for (const raw of raws) {
    if (raw.irtKey) raw.annot.inReplyTo = idByRefKey.get(raw.irtKey) ?? null;
  }
  return raws.map((r) => r.annot);
}

/** Map a native PDF annotation into the unified v2 CommentPayload (§3.2). The
 *  caller supplies the document identity; provenance is `native-pdf` and the
 *  /NM (or synthetic handle) is recorded in `native.comment_id`. The annotation
 *  region/quads become the `pdf-quad` anchor. */
export function nativeAnnotToPayload(
  a: PdfNativeAnnot,
  ctx: { docId: string; docVersion: string; createdAt?: string },
): CommentPayload {
  const status: CommentStatus = 'open';
  const engagement: EngagementLevel = 'comment';
  const origin: CommentOrigin = 'native-pdf';
  const anchor: Anchor = {
    kind: 'pdf-quad',
    page: a.pageIndex + 1, // anchors are 1-indexed (PdfQuadAnchor.page)
    region: a.region,
    ...(a.quads.length > 0 ? { quads: a.quads } : {}),
  };
  const native: NativeAnnotationRef = {
    comment_id: a.commentId,
    subtype: a.subtype,
    page_index: a.pageIndex,
    annot_index: a.annotIndex,
    ...(a.author ? { author: a.author } : {}),
    ...(a.color ? { color: a.color } : {}),
    ...(a.created ? { created: a.created } : {}),
    ...(a.inReplyTo ? { in_reply_to: a.inReplyTo } : {}),
  };
  return {
    id: `native-pdf-${a.commentId}`,
    doc_id: ctx.docId,
    doc_version: ctx.docVersion,
    anchor,
    highlighted_text: '',
    comment: a.contents,
    redraft: null,
    redraft_suggestion: null,
    engagement_level: engagement,
    author: a.author ?? 'Unknown',
    kind: 'comment',
    status,
    created_at: a.created ?? ctx.createdAt ?? new Date(0).toISOString(),
    origin,
    native,
  };
}

// ─── disk I/O layer (mirrors docx-comments.ts) ─────────────────────────────

async function loadDoc(filePath: string): Promise<PDFDocument> {
  const bytes = await readFile(filePath);
  return PDFDocument.load(bytes);
}

async function saveDoc(doc: PDFDocument, filePath: string): Promise<void> {
  const bytes = await doc.save();
  await atomicWrite(filePath, bytes);
}

/** Read native PDF annotations from a file, mapped into CommentPayloads. */
export async function readPdfComments(
  filePath: string,
  ctx: { docId: string; docVersion: string },
): Promise<CommentPayload[]> {
  const doc = await loadDoc(filePath);
  return readAnnotsFromDoc(doc).map((a) => nativeAnnotToPayload(a, ctx));
}

/** Add app-draft comments to a PDF on disk, in place (duplicate-safe). Returns
 *  the commentId → /NM map and any skipped comments. */
export async function writePdfComments(
  filePath: string,
  comments: CommentPayload[],
  opts?: { date?: Date },
): Promise<PdfWriteResult> {
  const doc = await loadDoc(filePath);
  const res = addCommentsToDoc(doc, comments, opts?.date ?? new Date());
  await saveDoc(doc, filePath);
  return res;
}

/** Edit a comment's text in a PDF on disk. Stamps /NM on first edit of a foreign
 *  annot; returns the stable /NM it is now addressed by. */
export async function editPdfComment(
  filePath: string,
  handle: AnnotHandle,
  newText: string,
  opts?: { date?: Date },
): Promise<EditResult> {
  const doc = await loadDoc(filePath);
  const res = editAnnotInDoc(doc, handle, newText, opts?.date ?? new Date());
  if (res.ok) await saveDoc(doc, filePath);
  return res;
}

/** Delete a comment (and its reply subtree) from a PDF on disk. */
export async function deletePdfComment(
  filePath: string,
  handle: AnnotHandle,
): Promise<{ ok: boolean; removed: string[] }> {
  const doc = await loadDoc(filePath);
  const res = deleteAnnotFromDoc(doc, handle);
  if (res.ok) await saveDoc(doc, filePath);
  return res;
}
