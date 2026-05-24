export interface MdAnchor {
  char_start: number;
  char_end: number;
  prefix: string;
  suffix: string;
  quoted_text: string;
}

const CONTEXT_CHARS = 40;

export function createMdAnchor(
  doc: string,
  from: number,
  to: number,
): MdAnchor {
  const quoted = doc.slice(from, to);
  const prefixStart = Math.max(0, from - CONTEXT_CHARS);
  const suffixEnd = Math.min(doc.length, to + CONTEXT_CHARS);
  return {
    char_start: from,
    char_end: to,
    prefix: doc.slice(prefixStart, from),
    suffix: doc.slice(to, suffixEnd),
    quoted_text: quoted,
  };
}

export interface AnchorMatch {
  from: number;
  to: number;
  confidence: 'exact' | 'fuzzy' | 'orphaned';
}

export function fuzzyMatchAnchor(doc: string, anchor: MdAnchor): AnchorMatch {
  // 1. Try exact match at the hint position
  if (anchor.char_start >= 0 && anchor.char_end <= doc.length) {
    const candidate = doc.slice(anchor.char_start, anchor.char_end);
    if (candidate === anchor.quoted_text) {
      return { from: anchor.char_start, to: anchor.char_end, confidence: 'exact' };
    }
  }

  // 2. Try exact text match anywhere
  const exactIdx = doc.indexOf(anchor.quoted_text);
  if (exactIdx !== -1) {
    return {
      from: exactIdx,
      to: exactIdx + anchor.quoted_text.length,
      confidence: 'exact',
    };
  }

  // 3. Try prefix+suffix context match
  if (anchor.prefix.length > 5) {
    const prefixIdx = doc.indexOf(anchor.prefix);
    if (prefixIdx !== -1) {
      const expectedStart = prefixIdx + anchor.prefix.length;
      const expectedEnd = expectedStart + anchor.quoted_text.length;
      if (expectedEnd <= doc.length) {
        return { from: expectedStart, to: expectedEnd, confidence: 'fuzzy' };
      }
    }
  }

  if (anchor.suffix.length > 5) {
    const suffixIdx = doc.indexOf(anchor.suffix);
    if (suffixIdx !== -1) {
      const expectedEnd = suffixIdx;
      const expectedStart = expectedEnd - anchor.quoted_text.length;
      if (expectedStart >= 0) {
        return { from: expectedStart, to: expectedEnd, confidence: 'fuzzy' };
      }
    }
  }

  // 4. Try partial quoted text match (first 20 chars)
  if (anchor.quoted_text.length > 20) {
    const partial = anchor.quoted_text.slice(0, 20);
    const partialIdx = doc.indexOf(partial);
    if (partialIdx !== -1) {
      return {
        from: partialIdx,
        to: Math.min(doc.length, partialIdx + anchor.quoted_text.length),
        confidence: 'fuzzy',
      };
    }
  }

  // 5. Orphaned — text is gone
  return { from: -1, to: -1, confidence: 'orphaned' };
}
