// Text-quote re-anchoring (X12). The text-anchor leg of the unified comment
// model: ONE resolver shared by MD, HTML, and DOCX body text (spec §3.1 rule 3,
// §5.4). Pure and side-effect-free — the caller decides how to persist the
// result.
//
// Two invariants, both from the Pass-4B fuzzy-re-anchoring finding (roadmap X12):
//   1. Verify before trusting. Steps 3–4 used to return the FIRST structural
//      guess unchecked, so a moved prefix/suffix could persist a relocation
//      pointing at unrelated text. Every fuzzy candidate is now slice-verified
//      against the immutable `quoted_text` (SIMILARITY_THRESHOLD); failures
//      downgrade to `orphaned` rather than fabricating a location.
//   2. Originals are immutable (§3.1 rule 2). `quoted_text/prefix/suffix/char_*`
//      are write-once provenance; a relocation lands in `relocated`, never on
//      top of the original capture. `relocateAnchor` returns a NEW anchor and
//      mutates nothing.

import type { TextQuoteAnchor } from '../comments.js';

/** Context window (chars) captured on each side of a text-quote selection.
 *  Exported (X12) so the HTML/DOCX capture legs and the tests share this one
 *  constant instead of re-deriving 40 in three places. */
export const CONTEXT_CHARS = 40;

/** Minimum normalized similarity (0..1) a fuzzy candidate slice must share with
 *  the immutable `quoted_text` before the resolver will trust it. Below this the
 *  guess is discarded — the anchor downgrades to `orphaned` rather than
 *  persisting an unverified relocation (X12 invariant 1). */
export const SIMILARITY_THRESHOLD = 0.7;

/** A context affix (prefix/suffix) shorter than this carries too little signal
 *  to disambiguate, so it is not used as a structural search key. */
const MIN_AFFIX_CHARS = 6;

/** Levenshtein is O(n·m); cap the compared length so a pathologically long
 *  selection can't make verification quadratic-expensive. The leading window is
 *  the discriminating part of a prose selection. */
const SIMILARITY_COMPARE_CAP = 512;

/** Legacy alias for the text-quote shape. `MdAnchor` was the MD-only name before
 *  the anchor union (X5) made `text-quote` the one kind for MD/HTML/DOCX; kept so
 *  existing `MdAnchor` type-imports keep resolving. New code should name the union
 *  member, `TextQuoteAnchor`, directly. */
export type MdAnchor = TextQuoteAnchor;

/** Build a fresh text-quote anchor over `doc[from, to)`. Captures the immutable
 *  provenance (quoted text + bounded context affixes + the hint offsets). A
 *  freshly-created anchor has no `relocated` field — it is born at its hint. */
export function createMdAnchor(
  doc: string,
  from: number,
  to: number,
): TextQuoteAnchor {
  const prefixStart = Math.max(0, from - CONTEXT_CHARS);
  const suffixEnd = Math.min(doc.length, to + CONTEXT_CHARS);
  return {
    kind: 'text-quote',
    char_start: from,
    char_end: to,
    prefix: doc.slice(prefixStart, from),
    suffix: doc.slice(to, suffixEnd),
    quoted_text: doc.slice(from, to),
  };
}

export interface AnchorMatch {
  from: number;
  to: number;
  confidence: 'exact' | 'fuzzy' | 'orphaned';
}

/** Normalized Levenshtein similarity in [0, 1]; 1 = identical. Case-insensitive
 *  — a recased selection ("Brown Fox" → "BROWN FOX") is the same anchored text,
 *  not a relocation failure. Both inputs are capped to SIMILARITY_COMPARE_CAP
 *  chars to bound cost. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const s = (a.length > SIMILARITY_COMPARE_CAP ? a.slice(0, SIMILARITY_COMPARE_CAP) : a).toLowerCase();
  const t = (b.length > SIMILARITY_COMPARE_CAP ? b.slice(0, SIMILARITY_COMPARE_CAP) : b).toLowerCase();
  if (s.length === 0 || t.length === 0) return 0;
  if (s === t) return 1;
  const dist = levenshtein(s, t);
  return 1 - dist / Math.max(s.length, t.length);
}

function levenshtein(s: string, t: string): number {
  const m = s.length;
  const n = t.length;
  let prev = new Array<number>(n + 1);
  let curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const sc = s.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = sc === t.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** Index of the occurrence of `needle` in `doc` whose start is nearest `hint`,
 *  or -1 if absent. Disambiguates repeated text by locality (X12) instead of
 *  blindly taking the first occurrence. */
function findNearestOccurrence(doc: string, needle: string, hint: number): number {
  if (needle.length === 0) return -1;
  let idx = doc.indexOf(needle);
  if (idx === -1) return -1;
  let best = idx;
  let bestDist = Math.abs(idx - hint);
  while ((idx = doc.indexOf(needle, idx + 1)) !== -1) {
    const dist = Math.abs(idx - hint);
    if (dist < bestDist) {
      best = idx;
      bestDist = dist;
    }
  }
  return best;
}

/** A verified fuzzy candidate: a slice that passed the similarity gate. */
interface Candidate {
  from: number;
  to: number;
  sim: number;
}

/** Verify a candidate span against the immutable quoted text. Returns the scored
 *  candidate when its slice clears SIMILARITY_THRESHOLD, else null. Out-of-range
 *  spans are rejected. */
function verify(
  doc: string,
  from: number,
  to: number,
  quoted: string,
): Candidate | null {
  if (from < 0 || to > doc.length || from >= to) return null;
  const sim = similarity(doc.slice(from, to), quoted);
  return sim >= SIMILARITY_THRESHOLD ? { from, to, sim } : null;
}

/** Resolve a text-quote anchor against the current document.
 *
 *  Strategy ladder (first confident win, fuzzy guesses verified):
 *    1. exact slice still sits at the live hint            → exact
 *    2. exact quoted_text elsewhere, occurrence nearest hint → exact
 *    3. relocate by prefix/suffix context, slice verified   → fuzzy
 *    4. relocate by a leading partial, slice verified       → fuzzy
 *    5. nothing verifiable                                  → orphaned
 *
 *  The hint is the LIVE position (`relocated` when present, else the original
 *  `char_*`); matching always uses the immutable `quoted_text/prefix/suffix`. */
export function fuzzyMatchAnchor(
  doc: string,
  anchor: TextQuoteAnchor,
): AnchorMatch {
  const quoted = anchor.quoted_text;
  const hintStart = anchor.relocated?.char_start ?? anchor.char_start;
  const hintEnd = anchor.relocated?.char_end ?? anchor.char_end;

  // 1. Exact match still at the live hint position.
  if (hintStart >= 0 && hintEnd <= doc.length && hintStart < hintEnd) {
    if (doc.slice(hintStart, hintEnd) === quoted) {
      return { from: hintStart, to: hintEnd, confidence: 'exact' };
    }
  }

  // 2. Exact quoted text anywhere — pick the occurrence nearest the hint.
  if (quoted.length > 0) {
    const idx = findNearestOccurrence(doc, quoted, hintStart);
    if (idx !== -1) {
      return { from: idx, to: idx + quoted.length, confidence: 'exact' };
    }
  }

  // 3–4. Verified fuzzy candidates. Collect from each structural strategy,
  // keep only slices that resemble the quoted text, then choose the best
  // (highest similarity, ties broken by proximity to the hint).
  const candidates: Candidate[] = [];

  // 3a. Anchor off the prefix: quoted text begins where the prefix ends.
  if (anchor.prefix.length >= MIN_AFFIX_CHARS) {
    const pIdx = findNearestOccurrence(doc, anchor.prefix, hintStart);
    if (pIdx !== -1) {
      const from = pIdx + anchor.prefix.length;
      const c = verify(doc, from, from + quoted.length, quoted);
      if (c) candidates.push(c);
    }
  }

  // 3b. Anchor off the suffix: quoted text ends where the suffix begins.
  if (anchor.suffix.length >= MIN_AFFIX_CHARS) {
    const sIdx = findNearestOccurrence(doc, anchor.suffix, hintEnd);
    if (sIdx !== -1) {
      const to = sIdx;
      const c = verify(doc, to - quoted.length, to, quoted);
      if (c) candidates.push(c);
    }
  }

  // 4. Leading partial of the quoted text (handles tail edits within the span).
  if (quoted.length > 20) {
    const partial = quoted.slice(0, 20);
    const partIdx = findNearestOccurrence(doc, partial, hintStart);
    if (partIdx !== -1) {
      const c = verify(doc, partIdx, Math.min(doc.length, partIdx + quoted.length), quoted);
      if (c) candidates.push(c);
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => {
      if (b.sim !== a.sim) return b.sim - a.sim;
      return Math.abs(a.from - hintStart) - Math.abs(b.from - hintStart);
    });
    const best = candidates[0];
    return { from: best.from, to: best.to, confidence: 'fuzzy' };
  }

  // 5. Orphaned — no verifiable location remains.
  return { from: -1, to: -1, confidence: 'orphaned' };
}

/** Re-resolve an anchor against `doc` and return a NEW anchor carrying the
 *  outcome, honoring the immutability invariant (§3.1 rule 2):
 *  `quoted_text/prefix/suffix/char_*` are copied verbatim; only `relocated`
 *  reflects movement.
 *
 *    - moved (exact-elsewhere or fuzzy) → `relocated = { char_start, char_end }`
 *    - back at its original capture      → `relocated = null`
 *    - orphaned                          → `relocated = null`
 *
 *  Callers persist this returned anchor; the original on disk is never
 *  overwritten in place. */
export function relocateAnchor(
  doc: string,
  anchor: TextQuoteAnchor,
): { anchor: TextQuoteAnchor; match: AnchorMatch } {
  const match = fuzzyMatchAnchor(doc, anchor);
  const atOrigin =
    match.confidence !== 'orphaned' &&
    match.from === anchor.char_start &&
    match.to === anchor.char_end;
  const relocated =
    match.confidence === 'orphaned' || atOrigin
      ? null
      : { char_start: match.from, char_end: match.to };
  return { anchor: { ...anchor, relocated }, match };
}
