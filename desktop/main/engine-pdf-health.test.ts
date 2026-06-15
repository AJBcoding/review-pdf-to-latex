// Unit test for the pdf-health report shape guard (rev-x10).
//
// `pdfHealth()` used to cast `JSON.parse(stdout) as PdfHealthReport` with no
// validation. We now run `isPdfHealthReport()` first so a drifted/unknown
// report shape is treated as an engine failure rather than blindly trusted.

import { describe, expect, it } from 'vitest';

import { isPdfHealthReport } from './engine.js';

const valid = {
  schema_version: 1,
  pdf_path: '/abs/x.pdf',
  total_pages: 3,
  readable_pages: [1, 2],
  unreadable_pages: [3],
  ligature_loss_detected: false,
  encrypted: false,
  producer: 'pdfTeX',
  creator: null,
  page_errors: [{ page: 3, error: 'no glyphs' }],
  error: null,
};

describe('isPdfHealthReport (rev-x10)', () => {
  it('accepts a well-formed v1 report', () => {
    expect(isPdfHealthReport(valid)).toBe(true);
  });

  it('accepts the encrypted partial report (still schema_version 1)', () => {
    expect(
      isPdfHealthReport({ ...valid, encrypted: true, total_pages: null, error: 'encrypted: ...' }),
    ).toBe(true);
  });

  it('rejects a wrong/absent schema_version', () => {
    expect(isPdfHealthReport({ ...valid, schema_version: 2 })).toBe(false);
    const { schema_version, ...withoutVersion } = valid;
    void schema_version;
    expect(isPdfHealthReport(withoutVersion)).toBe(false);
  });

  it('rejects non-object inputs', () => {
    expect(isPdfHealthReport(null)).toBe(false);
    expect(isPdfHealthReport('not json')).toBe(false);
    expect(isPdfHealthReport(42)).toBe(false);
    expect(isPdfHealthReport([])).toBe(false);
  });

  it('rejects reports with the wrong field shapes', () => {
    expect(isPdfHealthReport({ ...valid, readable_pages: 'nope' })).toBe(false);
    expect(isPdfHealthReport({ ...valid, page_errors: {} })).toBe(false);
    expect(isPdfHealthReport({ ...valid, encrypted: 'true' })).toBe(false);
    expect(isPdfHealthReport({ ...valid, ligature_loss_detected: 1 })).toBe(false);
  });
});
