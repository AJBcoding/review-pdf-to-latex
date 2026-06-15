import { describe, expect, it } from 'vitest';
import {
  CONTEXT_CHARS,
  createMdAnchor,
  fuzzyMatchAnchor,
  relocateAnchor,
} from './anchors.js';
import type { TextQuoteAnchor } from '../comments.js';

describe('createMdAnchor', () => {
  it('captures prefix, suffix, and quoted text', () => {
    const doc = 'Hello world, this is a test document with some content.';
    const anchor = createMdAnchor(doc, 13, 30);
    expect(anchor.quoted_text).toBe(doc.slice(13, 30));
    expect(anchor.char_start).toBe(13);
    expect(anchor.char_end).toBe(30);
    expect(anchor.prefix).toBe('Hello world, ');
    expect(anchor.suffix.startsWith('cument')).toBe(true);
  });

  it('handles selection at document start', () => {
    const doc = 'Start of the document.';
    const anchor = createMdAnchor(doc, 0, 5);
    expect(anchor.quoted_text).toBe('Start');
    expect(anchor.prefix).toBe('');
    expect(anchor.char_start).toBe(0);
  });

  it('handles selection at document end', () => {
    const doc = 'End of document.';
    const anchor = createMdAnchor(doc, 7, 16);
    expect(anchor.quoted_text).toBe('document.');
    expect(anchor.suffix).toBe('');
  });
});

describe('fuzzyMatchAnchor', () => {
  const doc = 'The quick brown fox jumps over the lazy dog.';

  it('finds exact match at hint position', () => {
    const anchor = createMdAnchor(doc, 10, 19);
    const match = fuzzyMatchAnchor(doc, anchor);
    expect(match.confidence).toBe('exact');
    expect(match.from).toBe(10);
    expect(match.to).toBe(19);
  });

  it('finds exact match when text moved', () => {
    const anchor = createMdAnchor(doc, 10, 19);
    const newDoc = 'PREPENDED ' + doc;
    const match = fuzzyMatchAnchor(newDoc, anchor);
    expect(match.confidence).toBe('exact');
    expect(newDoc.slice(match.from, match.to)).toBe('brown fox');
  });

  it('finds fuzzy match via prefix', () => {
    const anchor = createMdAnchor(doc, 10, 19);
    const newDoc = 'The quick BROWN FOX jumps over the lazy dog.';
    const match = fuzzyMatchAnchor(newDoc, anchor);
    expect(match.confidence).toBe('fuzzy');
    expect(match.from).toBe(10);
  });

  it('returns orphaned when text is completely gone', () => {
    const anchor = createMdAnchor(doc, 10, 19);
    const newDoc = 'Completely different document with nothing in common.';
    const match = fuzzyMatchAnchor(newDoc, anchor);
    expect(match.confidence).toBe('orphaned');
    expect(match.from).toBe(-1);
  });

  it('handles multiple comments independently', () => {
    const a1 = createMdAnchor(doc, 4, 9);
    const a2 = createMdAnchor(doc, 20, 25);
    const m1 = fuzzyMatchAnchor(doc, a1);
    const m2 = fuzzyMatchAnchor(doc, a2);
    expect(doc.slice(m1.from, m1.to)).toBe('quick');
    expect(doc.slice(m2.from, m2.to)).toBe('jumps');
  });

  // X12 #1 — verify the candidate slice before trusting it. The prefix still
  // exists, but the text following it is unrelated; the old unverified path
  // would have persisted a bogus fuzzy relocation. It must orphan instead.
  it('downgrades an unverified prefix guess to orphaned', () => {
    const anchor = createMdAnchor(doc, 10, 19); // 'brown fox', prefix 'The quick '
    const newDoc = 'The quick zzzzzzzzz and then something else entirely.';
    const match = fuzzyMatchAnchor(newDoc, anchor);
    expect(match.confidence).toBe('orphaned');
    expect(match.from).toBe(-1);
  });

  // X12 #1b — the suffix leg re-anchors only after verifying its slice. The
  // quoted text was lightly edited ('fox'→'foz') so the exact paths miss, but
  // the suffix is intact and the slice in front of it is similar enough to trust.
  it('re-anchors via a verified suffix match', () => {
    const anchor = createMdAnchor(doc, 10, 19); // 'brown fox', suffix ' jumps over the lazy dog.'
    const newDoc = 'A lazy brown foz jumps over the lazy dog.';
    const match = fuzzyMatchAnchor(newDoc, anchor);
    expect(match.confidence).toBe('fuzzy');
    expect(newDoc.slice(match.from, match.to)).toBe('brown foz');
  });

  // X12 #2 — repeated text disambiguates to the occurrence nearest the hint,
  // not blindly to the first occurrence.
  it('disambiguates repeated text to the occurrence nearest the hint', () => {
    const repeated = 'aaaa TARGET bbbb cccc dddd TARGET eeee';
    const first = repeated.indexOf('TARGET');
    const second = repeated.lastIndexOf('TARGET');
    expect(second).toBeGreaterThan(first);
    const anchor: TextQuoteAnchor = {
      kind: 'text-quote',
      char_start: second - 1, // hint near the SECOND occurrence; off-by-one so step 1 misses
      char_end: second + 5,
      prefix: '',
      suffix: '',
      quoted_text: 'TARGET',
    };
    const match = fuzzyMatchAnchor(repeated, anchor);
    expect(match.confidence).toBe('exact');
    expect(match.from).toBe(second);
    expect(match.from).not.toBe(first);
  });
});

describe('relocateAnchor', () => {
  const doc = 'The quick brown fox jumps over the lazy dog.';

  // X12 #3 — relocations land in `relocated`; the captured originals are
  // write-once and the input object is never mutated.
  it('records relocations in `relocated` and keeps originals immutable', () => {
    const anchor = createMdAnchor(doc, 10, 19); // 'brown fox'
    const newDoc = 'PREPENDED PREFIX ' + doc;
    const { anchor: out, match } = relocateAnchor(newDoc, anchor);

    expect(match.confidence).toBe('exact');
    // originals verbatim
    expect(out.quoted_text).toBe('brown fox');
    expect(out.char_start).toBe(10);
    expect(out.char_end).toBe(19);
    expect(out.prefix).toBe(anchor.prefix);
    expect(out.suffix).toBe(anchor.suffix);
    // relocation recorded, pointing at the live text
    expect(out.relocated).toEqual({ char_start: match.from, char_end: match.to });
    expect(newDoc.slice(out.relocated!.char_start, out.relocated!.char_end)).toBe('brown fox');
    // input untouched (fresh anchors carry no relocated field)
    expect(anchor.relocated).toBeUndefined();
  });

  it('clears `relocated` to null when the anchor is orphaned', () => {
    const anchor = createMdAnchor(doc, 10, 19);
    const gone = 'Completely different document with nothing in common.';
    const { anchor: out, match } = relocateAnchor(gone, anchor);
    expect(match.confidence).toBe('orphaned');
    expect(out.relocated).toBeNull();
    expect(out.quoted_text).toBe('brown fox'); // provenance preserved through orphaning
  });
});

// X12 #4 — CONTEXT_CHARS is exported (shared by the HTML/DOCX capture legs) and
// governs the captured context window.
describe('CONTEXT_CHARS', () => {
  it('is exported and bounds the captured context window', () => {
    expect(CONTEXT_CHARS).toBe(40);
    const long = 'x'.repeat(200);
    const doc = long + 'PICK' + long;
    const anchor = createMdAnchor(doc, long.length, long.length + 4);
    expect(anchor.quoted_text).toBe('PICK');
    expect(anchor.prefix.length).toBe(CONTEXT_CHARS);
    expect(anchor.suffix.length).toBe(CONTEXT_CHARS);
  });
});
