// §3.3 acceptance criterion 1 — a v1 sidecar of each of the FIVE real row
// shapes opens, migrates in memory, and round-trips to a valid v2 file; plus a
// v2 passthrough. Also covers the §4.3 tolerant-parse rule (normalizeAnchor)
// and the §4.4-step-1 v2→v1 down-converter (acceptance criterion 6).

import { describe, expect, it } from 'vitest';
import { migrateDraftsToV2 } from './drafts-migration.js';
import {
  downConvertSubmitFileToV1,
  normalizeAnchor,
  normalizeResultsFile,
  type CommentPayload,
  type SubmitFile,
} from '@shared/comments';

/** Build a v1 comment row (loose shape — the on-disk reality before v2). */
function v1Comment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    doc_id: '/proj/doc',
    doc_version: 'sha-v1',
    anchor: { page: 1, region: { x: 1, y: 2, w: 3, h: 4 } },
    highlighted_text: 'hi',
    comment: 'a note',
    redraft: null,
    redraft_suggestion: null,
    engagement_level: 'comment',
    author: 'AJB',
    kind: 'comment',
    status: 'open',
    created_at: '2026-06-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('migrateDraftsToV2 — five v1 row shapes (§3.3)', () => {
  it('shape 1: anchor_kind pdf-glyph-rect (or absent) → pdf-quad', () => {
    const v1 = { schema_version: 1, doc_version: 'sha-v1', comments: [v1Comment()] };
    const out = migrateDraftsToV2(v1, 'pdf');
    expect(out.schema_version).toBe(2);
    expect(out.format).toBe('pdf');
    const a = out.comments[0].anchor;
    expect(a).toEqual({ kind: 'pdf-quad', page: 1, region: { x: 1, y: 2, w: 3, h: 4 } });
    expect(out.comments[0].origin).toBe('app-draft');
  });

  it('shape 2: anchor_kind md-fuzzy-snippet + clean md_anchor → text-quote (placeholder pdf anchor discarded)', () => {
    const v1 = {
      schema_version: 1,
      doc_version: 'sha-v1',
      anchor_kind: 'md-fuzzy-snippet',
      comments: [
        v1Comment({
          anchor: { page: 1, region: { x: 0, y: 0, w: 0, h: 0 } }, // v1 placeholder
          md_anchor: { char_start: 5, char_end: 9, prefix: 'pre', suffix: 'suf', quoted_text: 'word' },
        }),
      ],
    };
    const out = migrateDraftsToV2(v1, 'md');
    expect(out.format).toBe('md');
    expect(out.comments[0].anchor).toEqual({
      kind: 'text-quote',
      char_start: 5,
      char_end: 9,
      prefix: 'pre',
      suffix: 'suf',
      quoted_text: 'word',
      relocated: null,
    });
  });

  it('shape 3: md_anchor carrying smuggled selector fields → html-selector-hint', () => {
    const v1 = {
      schema_version: 1,
      doc_version: 'sha-v1',
      anchor_kind: 'pdf-glyph-rect', // the v1 lie for html/docx
      comments: [
        v1Comment({
          anchor: { page: 1, region: { x: 0, y: 0, w: 0, h: 0 } },
          md_anchor: {
            char_start: 0,
            char_end: 4,
            prefix: '',
            suffix: '',
            quoted_text: 'body',
            selector: 'div:nth-of-type(2)',
            char_offset: 12,
            char_length: 4,
          },
        }),
      ],
    };
    const out = migrateDraftsToV2(v1, 'html');
    expect(out.comments[0].anchor).toEqual({
      kind: 'html-selector-hint',
      selector: 'div:nth-of-type(2)',
      char_offset: 12,
      char_length: 4,
      quoted_text: 'body',
    });
  });

  it('shape 4: new_anchor present (bare {page,region}) → pdf-quad; null passes through', () => {
    const withNew = migrateDraftsToV2(
      {
        schema_version: 1,
        doc_version: 'sha-v1',
        comments: [v1Comment({ new_anchor: { page: 3, region: { x: 9, y: 9, w: 1, h: 1 } } })],
      },
      'pdf',
    );
    expect(withNew.comments[0].new_anchor).toEqual({
      kind: 'pdf-quad',
      page: 3,
      region: { x: 9, y: 9, w: 1, h: 1 },
    });

    const withoutNew = migrateDraftsToV2(
      { schema_version: 1, doc_version: 'sha-v1', comments: [v1Comment()] },
      'pdf',
    );
    expect(withoutNew.comments[0].new_anchor).toBeNull();
  });

  it('shape 5: pdf_annotation_id present → native.comment_id', () => {
    const out = migrateDraftsToV2(
      {
        schema_version: 1,
        doc_version: 'sha-v1',
        comments: [v1Comment({ pdf_annotation_id: 'annot-7' })],
      },
      'pdf',
    );
    expect(out.comments[0].native).toEqual({ comment_id: 'annot-7' });
    expect(out.comments[0].origin).toBe('app-draft');
  });

  it('passthrough: an already-v2 file is returned normalized, not re-migrated', () => {
    const v2Comment: CommentPayload = {
      id: 'c1',
      doc_id: '/proj/doc',
      doc_version: 'sha-v2',
      anchor: { kind: 'pdf-quad', page: 2, region: { x: 1, y: 1, w: 1, h: 1 } },
      highlighted_text: 'hi',
      comment: 'note',
      redraft: null,
      redraft_suggestion: null,
      engagement_level: 'comment',
      author: 'AJB',
      kind: 'comment',
      status: 'open',
      created_at: '2026-06-14T00:00:00.000Z',
      origin: 'native-pdf',
      native: { comment_id: 'nm-1', subtype: 'Highlight' },
    };
    const v2 = { schema_version: 2, doc_version: 'sha-v2', format: 'pdf', comments: [v2Comment] };
    const out = migrateDraftsToV2(v2);
    expect(out.schema_version).toBe(2);
    expect(out.format).toBe('pdf');
    // Origin is preserved (NOT forced back to app-draft) and the native block survives.
    expect(out.comments[0].origin).toBe('native-pdf');
    expect(out.comments[0].native).toEqual({ comment_id: 'nm-1', subtype: 'Highlight' });
  });

  it('preserves the doc_fingerprint block across migration', () => {
    const fp = {
      title_from_frontmatter: 'T',
      first_500_chars_sha256: 'abc',
      anchor_count: 1,
      last_known_path: '/proj/doc',
    };
    const out = migrateDraftsToV2(
      { schema_version: 1, doc_version: 'sha-v1', comments: [v1Comment()], doc_fingerprint: fp },
      'pdf',
    );
    expect(out.doc_fingerprint).toEqual(fp);
  });
});

describe('normalizeAnchor — §4.3 tolerant parse', () => {
  it('reads a bare {page,region} as pdf-quad', () => {
    expect(normalizeAnchor({ page: 2, region: { x: 1, y: 2, w: 3, h: 4 } })).toEqual({
      kind: 'pdf-quad',
      page: 2,
      region: { x: 1, y: 2, w: 3, h: 4 },
    });
  });
  it('trusts an already-discriminated anchor', () => {
    const tq = { kind: 'text-quote', char_start: 0, char_end: 1, prefix: '', suffix: '', quoted_text: 'x' };
    expect(normalizeAnchor(tq)).toBe(tq);
  });
  it('returns null for unrecognizable input', () => {
    expect(normalizeAnchor(null)).toBeNull();
    expect(normalizeAnchor({ nope: true })).toBeNull();
  });
});

describe('down-converter — §4.4 step 1 (acceptance criterion 6)', () => {
  it('emits a v1 submit file: pdf-quad → {page,region}, native.comment_id → pdf_annotation_id, quads dropped', () => {
    const v2: SubmitFile = {
      schema_version: 2,
      submit_id: 's1',
      doc_id: '/proj/doc',
      doc_version: 'sha',
      source_file_version: '1.0',
      submitted_at: '2026-06-14T00:00:00.000Z',
      origin_rig: null,
      comments: [
        {
          id: 'c1',
          doc_id: '/proj/doc',
          doc_version: 'sha',
          anchor: {
            kind: 'pdf-quad',
            page: 1,
            region: { x: 1, y: 2, w: 3, h: 4 },
            quads: [{ x1: 0, y1: 0, x2: 1, y2: 0, x3: 0, y3: 1, x4: 1, y4: 1 }],
          },
          highlighted_text: 'hi',
          comment: 'note',
          redraft: null,
          redraft_suggestion: null,
          engagement_level: 'comment',
          author: 'AJB',
          kind: 'comment',
          status: 'submitted',
          created_at: '2026-06-14T00:00:00.000Z',
          origin: 'app-draft',
          native: { comment_id: 'annot-3' },
        },
      ],
    };
    const v1 = downConvertSubmitFileToV1(v2);
    expect(v1.schema_version).toBe(1);
    const c = v1.comments[0];
    expect(c.anchor).toEqual({ page: 1, region: { x: 1, y: 2, w: 3, h: 4 } });
    expect((c.anchor as unknown as { quads?: unknown }).quads).toBeUndefined();
    expect(c.pdf_annotation_id).toBe('annot-3');
    // No union/origin/native fields leak into the v1 shape.
    expect((c as unknown as { origin?: unknown }).origin).toBeUndefined();
    expect((c as unknown as { native?: unknown }).native).toBeUndefined();
  });
});

describe('normalizeResultsFile — v2-results tolerance (§4.4 step 1)', () => {
  it('coerces a bare {page,region} new_anchor to pdf-quad and leaves null entries alone', () => {
    const rf = normalizeResultsFile({
      schema_version: 1,
      submit_id: 's1',
      results_id: 'r1',
      round_status: 'complete',
      started_at: 't0',
      completed_at: 't1',
      new_source_path: null,
      version_chosen: null,
      results: [
        { id: 'c1', status: 'applied', new_anchor: { page: 2, region: { x: 0, y: 0, w: 1, h: 1 } } as never },
        { id: 'c2', status: 'rejected', reason: 'no' },
      ],
    });
    expect(rf.results[0].new_anchor).toEqual({ kind: 'pdf-quad', page: 2, region: { x: 0, y: 0, w: 1, h: 1 } });
    expect(rf.results[1].new_anchor).toBeUndefined();
  });
});
