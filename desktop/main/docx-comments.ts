// §5.3 / L5 — hand-rolled DOCX comments.xml adapter (main process). v1: flat
// comments (no replies, no `commentsExtended` threading).
//
// Charter amendment (spec §2, verified C14): "DOCX comments.xml read/write,
// body read-only" is true only for *editing comment text*. CREATE/DELETE must
// insert/remove range-marker elements (`commentRangeStart/End` +
// `commentReference`) in `word/document.xml`. Body **text** bytes are never
// altered — only marker elements are inserted, and existing runs are split
// (never rewritten in content) when an anchor starts/ends mid-run. This module
// enforces that: a split run reproduces the original run's `<w:rPr>` and the
// original text verbatim across the two halves.
//
// Anchor model (spec §3.1 rule 4, D3): DOCX comments anchor by `text-quote`
// over the document's linear run text; the OOXML range markers are the *native
// projection* of that anchor (`native.comment_id` = `w:id`), not a separate
// anchor kind. The same `fuzzyMatchAnchor` core that serves MD/HTML resolves
// the write position, so there is one resolver across formats (§3.1 rule 3).
//
// The module is split into a pure XML layer (string in, string out — unit
// tested without a zip) and a thin jszip I/O layer (D9: jszip is the sanctioned
// zip dep). mammoth — already a dependency — owns *display* of comments via a
// `comment-reference` style map in the renderer; it is not touched here.

import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { atomicWrite } from './atomic-write.js';
import { createMdAnchor, fuzzyMatchAnchor } from '@shared/md/anchors.js';
import type {
  CommentPayload,
  CommentStatus,
  EngagementLevel,
  TextQuoteAnchor,
} from '@shared/types.js';

// ─── OOXML constants ───────────────────────────────────────────────────────

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const COMMENTS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';
const COMMENTS_REL_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';

const DOCUMENT_PART = 'word/document.xml';
const COMMENTS_PART = 'word/comments.xml';
const DOCUMENT_RELS_PART = 'word/_rels/document.xml.rels';
const CONTENT_TYPES_PART = '[Content_Types].xml';

// ─── shared text helpers ─────────────────────────────────────────────────

/** Escape a string for use as XML text/attribute content. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Decode the XML entities that appear in `<w:t>` content. */
function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&'); // last — so "&amp;lt;" survives as "&lt;"
}

/** A `<w:r>…</w:r>` run as a single `<w:t>` plus its formatting, when the run
 *  is "simple" enough to split mid-text without losing content. */
interface RunSpan {
  /** index of the run's `<w:r` in document.xml. */
  xmlStart: number;
  /** index just past the run's `</w:r>` in document.xml. */
  xmlEnd: number;
  /** runText offset where this run's text begins. */
  charStart: number;
  /** runText offset just past this run's text. */
  charEnd: number;
  /** Decoded concatenation of the run's `<w:t>` content. */
  text: string;
  /** The run's `<w:rPr>…</w:rPr>` block verbatim, or '' if none. Reproduced on
   *  both halves when the run is split. */
  rPr: string;
  /** True when the run is exactly `(<w:rPr/>)?<w:t>…</w:t>` — the only shape we
   *  split. Non-simple runs (tabs, breaks, drawings, multiple `<w:t>`) are
   *  snapped to a run boundary instead, so their bytes are never rewritten. */
  simple: boolean;
}

/** Where a range marker sits, in runText offset terms (read side). */
interface MarkerHit {
  id: string;
  /** runText offset at the marker's position. */
  offset: number;
}

/** Parsed projection of document.xml's body needed by read and write. */
interface BodyScan {
  /** Concatenated run text (`<w:t>` content joined; `\n` between paragraphs). */
  runText: string;
  /** Text-bearing runs in document order. */
  runs: RunSpan[];
  /** `commentRangeStart` markers by id. */
  starts: MarkerHit[];
  /** `commentRangeEnd` markers by id. */
  ends: MarkerHit[];
  /** Insert index for body-end fallbacks (`</w:body>` or EOF). */
  bodyEndIndex: number;
}

/** Extract a run's `<w:rPr>…</w:rPr>` block (verbatim) if it is the first child. */
function extractRPr(runXml: string): string {
  // runXml is `<w:r …>INNER</w:r>` (or self-closed, handled by caller).
  const openEnd = runXml.indexOf('>');
  const inner = runXml.slice(openEnd + 1, runXml.lastIndexOf('</w:r>'));
  const m = inner.match(/^\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/);
  return m ? m[1] : '';
}

/** Concatenate + decode a run's `<w:t>` text content. */
function extractRunText(runXml: string): string {
  let out = '';
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(runXml)) !== null) out += decodeXml(m[1]);
  return out;
}

/** Decide whether a run is a single-`<w:t>` run we may split. */
function isSimpleRun(runXml: string, rPr: string): boolean {
  const openEnd = runXml.indexOf('>');
  const inner = runXml.slice(openEnd + 1, runXml.lastIndexOf('</w:r>'));
  const remainder = inner.slice(rPr.length);
  // Exactly one `<w:t>` (possibly empty/self-closed) and nothing else.
  return /^\s*(<w:t\b[^>]*>[\s\S]*?<\/w:t>|<w:t\b[^>]*\/>)?\s*$/.test(remainder);
}

/** Scan document.xml's body into runText + run spans + marker offsets. The walk
 *  visits runs, paragraph closes, and range markers in document order, building
 *  runText the same way for read and write so offsets round-trip. */
function scanBody(documentXml: string): BodyScan {
  const bodyEndIndex = (() => {
    const i = documentXml.indexOf('</w:body>');
    return i === -1 ? documentXml.length : i;
  })();

  const runs: RunSpan[] = [];
  const starts: MarkerHit[] = [];
  const ends: MarkerHit[] = [];

  let out = '';
  let pendingBreak = false;

  // One alternation over the token shapes we care about, walked in order.
  const tokenRe = new RegExp(
    [
      '<w:commentRangeStart\\b[^>]*\\/>',
      '<w:commentRangeEnd\\b[^>]*\\/>',
      '<\\/w:p>',
      '<w:r\\b[^>]*\\/>', // self-closed empty run
      '<w:r\\b[^>]*>[\\s\\S]*?<\\/w:r>', // full run
    ].join('|'),
    'g',
  );

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(documentXml)) !== null) {
    const tok = m[0];
    if (tok.startsWith('<w:commentRangeStart')) {
      starts.push({ id: readAttr(tok, 'w:id') ?? '', offset: out.length });
    } else if (tok.startsWith('<w:commentRangeEnd')) {
      ends.push({ id: readAttr(tok, 'w:id') ?? '', offset: out.length });
    } else if (tok === '</w:p>') {
      pendingBreak = true;
    } else if (tok.startsWith('<w:r')) {
      if (tok.endsWith('/>')) continue; // empty self-closed run, no text
      const text = extractRunText(tok);
      if (text.length === 0) continue; // no text: preserved verbatim, not a span
      if (pendingBreak && out.length > 0) out += '\n';
      pendingBreak = false;
      const charStart = out.length;
      out += text;
      const rPr = extractRPr(tok);
      runs.push({
        xmlStart: m.index,
        xmlEnd: m.index + tok.length,
        charStart,
        charEnd: out.length,
        text,
        rPr,
        simple: isSimpleRun(tok, rPr),
      });
    }
  }

  return { runText: out, runs, starts, ends, bodyEndIndex };
}

/** Read one attribute value off a tag or raw attribute string. */
function readAttr(s: string, name: string): string | null {
  const m = s.match(new RegExp(`${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? decodeXml(m[1]) : null;
}

// ─── READ ────────────────────────────────────────────────────────────────

/** A native DOCX comment as read off disk, before mapping into the unified
 *  CommentPayload (the doc_id / doc_version come from the caller). */
export interface DocxNativeComment {
  /** OOXML `w:id`. */
  wid: string;
  author: string | null;
  /** ISO date from `w:date`, or null. */
  date: string | null;
  initials: string | null;
  /** Comment body text (paragraphs joined with `\n`). */
  text: string;
  /** Text-quote anchor over the document's run text (best-effort). */
  anchor: TextQuoteAnchor;
  /** True when both range markers were found and the span was non-empty. */
  resolved: boolean;
}

/** Parse the body text of one `<w:comment>` element (its `<w:p>`/`<w:t>` runs). */
function commentBodyText(commentInner: string): string {
  return commentInner
    .split(/<\/w:p>/)
    .map((para) => {
      let t = '';
      const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(para)) !== null) t += decodeXml(mm[1]);
      return t;
    })
    .join('\n')
    .replace(/\n+$/, '');
}

/** Read native comments from the (already-unzipped) document + comments parts.
 *  `commentsXml` is null when the document has no comments part. */
export function readCommentsFromXml(
  documentXml: string,
  commentsXml: string | null,
): DocxNativeComment[] {
  if (!commentsXml) return [];

  const scan = scanBody(documentXml);
  const startById = new Map(scan.starts.map((s) => [s.id, s.offset]));
  const endById = new Map(scan.ends.map((e) => [e.id, e.offset]));

  const out: DocxNativeComment[] = [];
  const re = /<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(commentsXml)) !== null) {
    const head = m[1];
    const inner = m[2];
    const wid = readAttr(head, 'w:id') ?? '';
    const author = readAttr(head, 'w:author');
    const date = readAttr(head, 'w:date');
    const initials = readAttr(head, 'w:initials');
    const text = commentBodyText(inner);

    const from = startById.get(wid);
    const to = endById.get(wid);
    let anchor: TextQuoteAnchor;
    let resolved = false;
    if (from != null && to != null && to > from) {
      anchor = createMdAnchor(scan.runText, from, to);
      resolved = true;
    } else {
      // Orphaned native comment (no usable range) — emit a zero-width anchor at
      // the marker (or doc start) so the card still surfaces; resolved=false.
      const at = from ?? to ?? 0;
      anchor = createMdAnchor(scan.runText, at, at);
    }
    out.push({ wid, author, date, initials, text, anchor, resolved });
  }
  return out;
}

/** Map a native DOCX comment into the unified v2 CommentPayload (§3.2). The
 *  caller supplies the document identity; provenance is `native-docx` and the
 *  `w:id` is recorded in `native.comment_id` (the OOXML range is the native
 *  projection of the text-quote anchor). */
export function nativeCommentToPayload(
  c: DocxNativeComment,
  ctx: { docId: string; docVersion: string; createdAt?: string },
): CommentPayload {
  const status: CommentStatus = 'open';
  const engagement: EngagementLevel = 'comment';
  return {
    id: `native-docx-${c.wid}`,
    doc_id: ctx.docId,
    doc_version: ctx.docVersion,
    anchor: c.anchor,
    highlighted_text: c.anchor.quoted_text,
    comment: c.text,
    redraft: null,
    redraft_suggestion: null,
    engagement_level: engagement,
    author: c.author ?? 'Unknown',
    kind: 'comment',
    status,
    created_at: c.date ?? ctx.createdAt ?? new Date(0).toISOString(),
    origin: 'native-docx',
    native: {
      comment_id: c.wid,
      author: c.author ?? undefined,
      created: c.date ?? undefined,
    },
  };
}

// ─── WRITE: id minting + part scaffolding ─────────────────────────────────

/** Next free `w:id` across the comments part and the document markers. */
function mintCommentId(documentXml: string, commentsXml: string | null): number {
  let max = -1;
  const consider = (s: string | null) => {
    if (!s) return;
    const re = /w:id="(\d+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) max = Math.max(max, Number(m[1]));
  };
  consider(commentsXml);
  // Only marker ids in the document — `w:id` also appears on e.g. `w:ins`, but
  // those share the same numeric space in practice; taking the global max is
  // safe (we only need an unused value).
  consider(documentXml);
  return max + 1;
}

/** Build a fresh empty `word/comments.xml`. */
function emptyCommentsXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:comments xmlns:w="${W_NS}"></w:comments>`
  );
}

/** A `<w:comment>` element for the given fields. Body text is split on `\n`
 *  into paragraphs. */
function buildCommentElement(
  id: number,
  text: string,
  author: string,
  dateIso: string,
  initials: string,
): string {
  const paras = text.split('\n').map((line) =>
    `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
  );
  return (
    `<w:comment w:id="${id}" w:author="${escapeXml(author)}" ` +
    `w:date="${escapeXml(dateIso)}" w:initials="${escapeXml(initials)}">` +
    `${paras.join('')}</w:comment>`
  );
}

/** Insert a `<w:comment>` before `</w:comments>`. */
function appendComment(commentsXml: string, element: string): string {
  const close = '</w:comments>';
  const i = commentsXml.lastIndexOf(close);
  if (i === -1) return commentsXml; // malformed; caller guards
  return commentsXml.slice(0, i) + element + commentsXml.slice(i);
}

/** Replace the body of `<w:comment w:id=ID>` with new paragraphs. */
function replaceCommentBody(commentsXml: string, id: string, text: string): string {
  const re = new RegExp(`(<w:comment\\b[^>]*w:id="${id}"[^>]*>)([\\s\\S]*?)(</w:comment>)`);
  const paras = text
    .split('\n')
    .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`)
    .join('');
  return commentsXml.replace(re, (_full, open, _body, close) => `${open}${paras}${close}`);
}

/** Remove `<w:comment w:id=ID>` from the comments part. */
function removeCommentElement(commentsXml: string, id: string): string {
  const re = new RegExp(`<w:comment\\b[^>]*w:id="${id}"[^>]*>[\\s\\S]*?</w:comment>`);
  return commentsXml.replace(re, '');
}

/** Ensure the comments Override exists in `[Content_Types].xml`. */
function ensureContentType(contentTypesXml: string): string {
  if (contentTypesXml.includes(`PartName="/${COMMENTS_PART}"`)) return contentTypesXml;
  const override =
    `<Override PartName="/${COMMENTS_PART}" ContentType="${COMMENTS_CONTENT_TYPE}"/>`;
  const close = '</Types>';
  const i = contentTypesXml.lastIndexOf(close);
  if (i === -1) return contentTypesXml;
  return contentTypesXml.slice(0, i) + override + contentTypesXml.slice(i);
}

/** Ensure document.xml.rels has a comments relationship; returns the rels XML
 *  (creating the whole part when absent). */
function ensureCommentsRel(relsXml: string | null): string {
  const base =
    relsXml ??
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '</Relationships>';
  if (base.includes(`Type="${COMMENTS_REL_TYPE}"`)) return base;
  // Mint an unused rId.
  let max = 0;
  const re = /Id="rId(\d+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(base)) !== null) max = Math.max(max, Number(m[1]));
  const rel =
    `<Relationship Id="rId${max + 1}" Type="${COMMENTS_REL_TYPE}" Target="comments.xml"/>`;
  const close = '</Relationships>';
  const i = base.lastIndexOf(close);
  if (i === -1) return base;
  return base.slice(0, i) + rel + base.slice(i);
}

// ─── WRITE: range-marker insertion (run-splitting) ────────────────────────

function startMarker(id: number): string {
  return `<w:commentRangeStart w:id="${id}"/>`;
}
function endMarker(id: number): string {
  return `<w:commentRangeEnd w:id="${id}"/>`;
}
function referenceRun(id: number): string {
  return (
    '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>' +
    `<w:commentReference w:id="${id}"/></w:r>`
  );
}

/** Reproduce a run from its (verbatim) rPr + a text slice; '' for empty text. */
function makeRun(rPr: string, text: string): string {
  if (text.length === 0) return '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

interface RunFinders {
  runAt(offset: number): RunSpan | null;
  firstRunFrom(offset: number): RunSpan | null;
  lastRunBefore(offset: number): RunSpan | null;
}

function runFinders(runs: RunSpan[]): RunFinders {
  return {
    runAt: (o) => runs.find((r) => r.charStart <= o && o < r.charEnd) ?? null,
    firstRunFrom: (o) => runs.find((r) => r.charStart >= o) ?? null,
    lastRunBefore: (o) => [...runs].reverse().find((r) => r.charEnd <= o) ?? null,
  };
}

export type InsertResult =
  | { ok: true; documentXml: string; commentsXml: string; contentTypesXml: string; relsXml: string; mintedId: number }
  | { ok: false; reason: 'anchor_unresolved' | 'no_text' };

/** Insert a new comment over `anchor`'s resolved span. Splits the boundary runs
 *  when the span starts/ends mid-run (C14); snaps non-simple runs to their
 *  boundary so their bytes are never rewritten. Creates comments.xml, the
 *  content-type Override and the .rels relationship when the document has no
 *  comments yet. */
export function insertCommentIntoXml(parts: {
  documentXml: string;
  commentsXml: string | null;
  contentTypesXml: string;
  relsXml: string | null;
  anchor: TextQuoteAnchor;
  commentText: string;
  author: string;
  dateIso: string;
  initials?: string;
}): InsertResult {
  const scan = scanBody(parts.documentXml);
  if (scan.runs.length === 0) return { ok: false, reason: 'no_text' };

  const match = fuzzyMatchAnchor(scan.runText, parts.anchor);
  if (match.confidence === 'orphaned' || match.from < 0 || match.to <= match.from) {
    return { ok: false, reason: 'anchor_unresolved' };
  }
  const { from, to } = match;

  const id = mintCommentId(parts.documentXml, parts.commentsXml);
  const fin = runFinders(scan.runs);

  // Resolve START edit: split | insert-at.
  let splitS = false, runS: RunSpan | null = null, kS = 0, startInsert = scan.bodyEndIndex;
  {
    const r = fin.runAt(from);
    if (r && from > r.charStart) {
      if (r.simple) { splitS = true; runS = r; kS = from - r.charStart; }
      else { startInsert = r.xmlStart; }
    } else if (r && from === r.charStart) {
      startInsert = r.xmlStart;
    } else {
      const nr = fin.firstRunFrom(from);
      startInsert = nr ? nr.xmlStart : scan.bodyEndIndex;
    }
  }

  // Resolve END edit: split | insert-at. `to` is exclusive (last covered char to-1).
  let splitE = false, runE: RunSpan | null = null, kE = 0, endInsert = scan.bodyEndIndex;
  {
    const r = fin.runAt(to - 1);
    if (r && to < r.charEnd) {
      if (r.simple) { splitE = true; runE = r; kE = to - r.charStart; }
      else { endInsert = r.xmlEnd; }
    } else if (r && to === r.charEnd) {
      endInsert = r.xmlEnd;
    } else {
      const pr = fin.lastRunBefore(to);
      endInsert = pr ? pr.xmlEnd : scan.bodyEndIndex;
    }
  }

  const sMark = startMarker(id);
  const eMark = endMarker(id) + referenceRun(id);

  let documentXml: string;
  if (splitS && splitE && runS === runE && runS) {
    // Whole selection inside one simple run → 3-way split.
    const r = runS;
    const a = from - r.charStart;
    const b = to - r.charStart;
    const rebuilt =
      makeRun(r.rPr, r.text.slice(0, a)) +
      sMark +
      makeRun(r.rPr, r.text.slice(a, b)) +
      eMark +
      makeRun(r.rPr, r.text.slice(b));
    documentXml =
      parts.documentXml.slice(0, r.xmlStart) + rebuilt + parts.documentXml.slice(r.xmlEnd);
  } else {
    // General contiguous splice: rebuild only the boundary runs; everything
    // between them is copied verbatim (interior runs, existing markers).
    const regionStart = splitS && runS ? runS.xmlStart : startInsert;
    const regionEnd = splitE && runE ? runE.xmlEnd : endInsert;
    const interiorStart = splitS && runS ? runS.xmlEnd : startInsert;
    const interiorEnd = splitE && runE ? runE.xmlStart : endInsert;
    const interior = parts.documentXml.slice(interiorStart, interiorEnd);

    const replacement =
      (splitS && runS ? makeRun(runS.rPr, runS.text.slice(0, kS)) : '') +
      sMark +
      (splitS && runS ? makeRun(runS.rPr, runS.text.slice(kS)) : '') +
      interior +
      (splitE && runE ? makeRun(runE.rPr, runE.text.slice(0, kE)) : '') +
      eMark +
      (splitE && runE ? makeRun(runE.rPr, runE.text.slice(kE)) : '');

    documentXml =
      parts.documentXml.slice(0, regionStart) + replacement + parts.documentXml.slice(regionEnd);
  }

  // Comments part + scaffolding.
  const baseComments = parts.commentsXml ?? emptyCommentsXml();
  const element = buildCommentElement(
    id,
    parts.commentText,
    parts.author,
    parts.dateIso,
    parts.initials ?? initialsFor(parts.author),
  );
  const commentsXml = appendComment(baseComments, element);
  const contentTypesXml = ensureContentType(parts.contentTypesXml);
  const relsXml = ensureCommentsRel(parts.relsXml);

  return { ok: true, documentXml, commentsXml, contentTypesXml, relsXml, mintedId: id };
}

/** Initials from an author name (e.g. "Anthony Byrnes" → "AB"). */
function initialsFor(author: string): string {
  return (
    author
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('')
      .slice(0, 4) || 'AJB'
  );
}

/** Edit a comment's text in the comments part. */
export function editCommentInXml(commentsXml: string, id: string, newText: string): string {
  return replaceCommentBody(commentsXml, id, newText);
}

/** Delete a comment: drop its `<w:comment>` and its three document markers
 *  (`commentRangeStart`, `commentRangeEnd`, the `commentReference` run). Body
 *  text bytes are untouched. */
export function deleteCommentFromXml(
  documentXml: string,
  commentsXml: string,
  id: string,
): { documentXml: string; commentsXml: string } {
  const doc = documentXml
    .replace(new RegExp(`<w:commentRangeStart\\b[^>]*w:id="${id}"[^>]*/>`, 'g'), '')
    .replace(new RegExp(`<w:commentRangeEnd\\b[^>]*w:id="${id}"[^>]*/>`, 'g'), '')
    // The reference run: `<w:r>…<w:commentReference w:id=ID/>…</w:r>`.
    .replace(
      new RegExp(`<w:r\\b[^>]*>(?:(?!</w:r>)[\\s\\S])*?<w:commentReference\\b[^>]*w:id="${id}"[^>]*/>[\\s\\S]*?</w:r>`, 'g'),
      '',
    );
  return { documentXml: doc, commentsXml: removeCommentElement(commentsXml, id) };
}

// ─── jszip I/O layer ──────────────────────────────────────────────────────

async function loadZip(filePath: string): Promise<JSZip> {
  const buf = await readFile(filePath);
  return JSZip.loadAsync(buf);
}

async function partText(zip: JSZip, part: string): Promise<string | null> {
  const f = zip.file(part);
  return f ? f.async('string') : null;
}

async function writeZip(zip: JSZip, filePath: string): Promise<void> {
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await atomicWrite(filePath, buf);
}

/** Read native comments from a .docx on disk, mapped into CommentPayloads. */
export async function readDocxComments(
  filePath: string,
  ctx: { docId: string; docVersion: string },
): Promise<CommentPayload[]> {
  const zip = await loadZip(filePath);
  const documentXml = await partText(zip, DOCUMENT_PART);
  if (!documentXml) return [];
  const commentsXml = await partText(zip, COMMENTS_PART);
  return readCommentsFromXml(documentXml, commentsXml).map((c) =>
    nativeCommentToPayload(c, ctx),
  );
}

export type CreateDocxCommentResult =
  | { ok: true; commentId: number }
  | { ok: false; reason: 'anchor_unresolved' | 'no_text' | 'no_document' };

/** Create a comment in a .docx on disk: resolve the anchor, mint the id, insert
 *  the markers (run-splitting), scaffold the comments part if needed, and write
 *  the zip atomically. */
export async function createDocxComment(
  filePath: string,
  args: { anchor: TextQuoteAnchor; commentText: string; author: string; dateIso?: string },
): Promise<CreateDocxCommentResult> {
  const zip = await loadZip(filePath);
  const documentXml = await partText(zip, DOCUMENT_PART);
  if (!documentXml) return { ok: false, reason: 'no_document' };
  const commentsXml = await partText(zip, COMMENTS_PART);
  const contentTypesXml = (await partText(zip, CONTENT_TYPES_PART)) ?? '<Types></Types>';
  const relsXml = await partText(zip, DOCUMENT_RELS_PART);

  const res = insertCommentIntoXml({
    documentXml,
    commentsXml,
    contentTypesXml,
    relsXml,
    anchor: args.anchor,
    commentText: args.commentText,
    author: args.author,
    dateIso: args.dateIso ?? new Date(0).toISOString(),
  });
  if (!res.ok) return res;

  zip.file(DOCUMENT_PART, res.documentXml);
  zip.file(COMMENTS_PART, res.commentsXml);
  zip.file(CONTENT_TYPES_PART, res.contentTypesXml);
  zip.file(DOCUMENT_RELS_PART, res.relsXml);
  await writeZip(zip, filePath);
  return { ok: true, commentId: res.mintedId };
}

/** Edit a comment's text in a .docx on disk. */
export async function editDocxComment(
  filePath: string,
  id: string,
  newText: string,
): Promise<{ ok: boolean }> {
  const zip = await loadZip(filePath);
  const commentsXml = await partText(zip, COMMENTS_PART);
  if (!commentsXml) return { ok: false };
  zip.file(COMMENTS_PART, editCommentInXml(commentsXml, id, newText));
  await writeZip(zip, filePath);
  return { ok: true };
}

/** Delete a comment (and its markers) from a .docx on disk. */
export async function deleteDocxComment(
  filePath: string,
  id: string,
): Promise<{ ok: boolean }> {
  const zip = await loadZip(filePath);
  const documentXml = await partText(zip, DOCUMENT_PART);
  const commentsXml = await partText(zip, COMMENTS_PART);
  if (!documentXml || !commentsXml) return { ok: false };
  const next = deleteCommentFromXml(documentXml, commentsXml, id);
  zip.file(DOCUMENT_PART, next.documentXml);
  zip.file(COMMENTS_PART, next.commentsXml);
  await writeZip(zip, filePath);
  return { ok: true };
}
