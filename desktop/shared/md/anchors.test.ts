import { describe, expect, it } from 'vitest';
import { createMdAnchor, fuzzyMatchAnchor } from './anchors.js';

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
});
