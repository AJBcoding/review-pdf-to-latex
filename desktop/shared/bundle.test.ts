// Safety net for the shared bundle utilities (rev-x1). These are read by both
// main (PDF annotation /C + filename) and the renderer (card CSS + Cmd+S
// title-bar pip), so a regression here silently diverges the two surfaces.
// §10.4 filename grammar, §10.6 source-version parsing, rev-pya palette.

import { describe, expect, it } from 'vitest';
import {
  ENGAGEMENT_PALETTE,
  buildBundleFilename,
  mintBundleId,
  parseSourceName,
} from './bundle.js';
import type { EngagementLevel } from './types.js';

describe('parseSourceName (§10.6)', () => {
  it('parses `<base>-<major>.<minor>.<ext>`', () => {
    expect(parseSourceName('report-1.0.pdf')).toEqual({
      base: 'report',
      source_version: '1.0',
      ext: 'pdf',
    });
    expect(parseSourceName('thesis-2.13.tex')).toEqual({
      base: 'thesis',
      source_version: '2.13',
      ext: 'tex',
    });
    expect(parseSourceName('notes-10.4.md')).toEqual({
      base: 'notes',
      source_version: '10.4',
      ext: 'md',
    });
  });

  it('keeps hyphens in the base (non-greedy first group)', () => {
    expect(parseSourceName('my-long-doc-1.0.pdf')).toEqual({
      base: 'my-long-doc',
      source_version: '1.0',
      ext: 'pdf',
    });
  });

  it('returns null for filenames without a version', () => {
    expect(parseSourceName('report.pdf')).toBeNull();
    expect(parseSourceName('report-final.pdf')).toBeNull();
    expect(parseSourceName('report-1.pdf')).toBeNull(); // no minor
  });

  it('returns null for unsupported extensions', () => {
    expect(parseSourceName('report-1.0.docx')).toBeNull();
    expect(parseSourceName('report-1.0.txt')).toBeNull();
  });
});

describe('buildBundleFilename (§10.4)', () => {
  // Local-day date string — pick a fixed local date so the test is stable
  // regardless of the runner's timezone.
  const date = new Date(2026, 5, 14); // 2026-06-14 local

  it('uses the parsed base + version when available', () => {
    const parsed = parseSourceName('report-1.0.pdf');
    expect(
      buildBundleFilename({ parsed, fallbackBase: 'report-1.0.pdf', date, ext: 'pdf' }),
    ).toBe('2026-06-14 report-1.0 (AJB edits).pdf');
    expect(
      buildBundleFilename({ parsed, fallbackBase: 'report-1.0.pdf', date, ext: 'json' }),
    ).toBe('2026-06-14 report-1.0 (AJB edits).json');
  });

  it('falls back to the bare basename (ext stripped) when unparsed', () => {
    expect(
      buildBundleFilename({ parsed: null, fallbackBase: 'report.pdf', date, ext: 'pdf' }),
    ).toBe('2026-06-14 report (AJB edits).pdf');
    expect(
      buildBundleFilename({ parsed: null, fallbackBase: 'report-final.pdf', date, ext: 'json' }),
    ).toBe('2026-06-14 report-final (AJB edits).json');
  });

  it('zero-pads single-digit month and day', () => {
    const jan3 = new Date(2026, 0, 3); // 2026-01-03 local
    expect(
      buildBundleFilename({ parsed: null, fallbackBase: 'x.pdf', date: jan3, ext: 'pdf' }),
    ).toBe('2026-01-03 x (AJB edits).pdf');
  });
});

describe('mintBundleId', () => {
  it('formats `YYYYMMDD-HHmmss` in UTC, zero-padded', () => {
    const d = new Date(Date.UTC(2026, 5, 14, 9, 5, 3));
    expect(mintBundleId(d)).toBe('20260614-090503');
  });

  it('is sortable lexicographically by time', () => {
    const earlier = mintBundleId(new Date(Date.UTC(2026, 5, 14, 8, 0, 0)));
    const later = mintBundleId(new Date(Date.UTC(2026, 5, 14, 9, 0, 0)));
    expect(earlier < later).toBe(true);
  });
});

describe('ENGAGEMENT_PALETTE (rev-pya)', () => {
  const levels: EngagementLevel[] = ['comment', 'redraft', 'surface'];

  it('has exactly one entry per engagement level', () => {
    expect(Object.keys(ENGAGEMENT_PALETTE).sort()).toEqual([...levels].sort());
  });

  it('each entry self-identifies with its keyed level', () => {
    for (const level of levels) {
      expect(ENGAGEMENT_PALETTE[level].level).toBe(level);
    }
  });

  it('pdfC is three floats in [0,1]', () => {
    for (const level of levels) {
      const { pdfC } = ENGAGEMENT_PALETTE[level];
      expect(pdfC).toHaveLength(3);
      for (const channel of pdfC) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    }
  });

  it('pdfCA opacity is 0.5 across all levels', () => {
    for (const level of levels) {
      expect(ENGAGEMENT_PALETTE[level].pdfCA).toBe(0.5);
    }
  });

  it('cssHex is a 6-digit hex string', () => {
    for (const level of levels) {
      expect(ENGAGEMENT_PALETTE[level].cssHex).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('every level has a visually distinct color', () => {
    const hexes = levels.map((l) => ENGAGEMENT_PALETTE[l].cssHex);
    expect(new Set(hexes).size).toBe(levels.length);
  });
});
