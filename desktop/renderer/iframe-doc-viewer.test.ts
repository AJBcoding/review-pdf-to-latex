import { describe, expect, it } from 'vitest';
import type { Anchor, CommentPayload } from '@shared/types';
import { htmlAnchorsFromComments } from './iframe-doc-viewer';

// Build a CommentPayload carrying a given anchor. Only `anchor` is read by the
// projection, so the rest is filler typed through `as`.
function comment(anchor: Anchor): CommentPayload {
  return {
    id: 'c1',
    doc_id: 'd1',
    doc_version: 'v1',
    anchor,
    highlighted_text: '',
    comment: '',
    redraft: null,
    redraft_suggestion: null,
    engagement_level: 'comment',
    author: 'tester',
    kind: 'comment',
    status: 'open',
    created_at: '2026-06-15T00:00:00Z',
    origin: 'app-draft',
  } as unknown as CommentPayload;
}

describe('htmlAnchorsFromComments', () => {
  it('keeps only html-selector-hint anchors', () => {
    const comments = [
      comment({
        kind: 'html-selector-hint',
        selector: 'p:nth-of-type(2)',
        char_offset: 5,
        char_length: 4,
        quoted_text: 'word',
      }),
      comment({
        kind: 'text-quote',
        char_start: 0,
        char_end: 3,
        prefix: '',
        suffix: '',
        quoted_text: 'abc',
      }),
      comment({
        kind: 'pdf-quad',
        page: 1,
        region: { x: 0, y: 0, w: 1, h: 1 },
      }),
    ];

    const anchors = htmlAnchorsFromComments(comments);

    expect(anchors).toEqual([
      { selector: 'p:nth-of-type(2)', text_content: 'word', char_offset: 5, char_length: 4 },
    ]);
  });

  it('falls back to quoted_text length when char_length is absent/zero', () => {
    const anchors = htmlAnchorsFromComments([
      comment({
        kind: 'html-selector-hint',
        selector: 'body',
        char_offset: 0,
        char_length: 0,
        quoted_text: 'hello',
      }),
    ]);

    expect(anchors).toEqual([
      { selector: 'body', text_content: 'hello', char_offset: 0, char_length: 5 },
    ]);
  });

  it('returns an empty array when no anchors are selector hints', () => {
    expect(htmlAnchorsFromComments([])).toEqual([]);
  });
});
