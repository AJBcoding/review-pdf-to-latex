// Safety net for the §5.3 / L5 DOCX comments adapter. The load-bearing
// invariant (C14) is that CREATE/DELETE touch only marker elements — the body
// **text** bytes are never rewritten — and that an app-written comment reads
// back with the exact span it was anchored over (write → read round-trip). Run
// splitting is the subtle part: a mid-run anchor must reproduce the run's text
// across the split halves with zero net change to the concatenated body text.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import {
  readCommentsFromXml,
  insertCommentIntoXml,
  editCommentInXml,
  deleteCommentFromXml,
  nativeCommentToPayload,
  createDocxComment,
  readDocxComments,
  editDocxComment,
  deleteDocxComment,
  type InsertResult,
} from './docx-comments.js';
import { createMdAnchor } from '@shared/md/anchors.js';

// ─── OOXML fixture helpers ────────────────────────────────────────────────

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function run(text: string, rPr = ''): string {
  return `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}
function para(...runs: string[]): string {
  return `<w:p>${runs.join('')}</w:p>`;
}
function docXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`
  );
}
const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;
const DOC_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

/** Concatenated, decoded `<w:t>` text — the body-text invariant we assert is
 *  unchanged by marker insertion (C14). */
function bodyText(documentXml: string): string {
  let out = '';
  const re = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(documentXml)) !== null) out += m[1];
  return out;
}

function expectOk(r: InsertResult): Extract<InsertResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
}

/** Narrow a unified anchor to its text-quote quoted text. */
function quoteOf(anchor: { kind: string }): string {
  if (anchor.kind !== 'text-quote') throw new Error(`expected text-quote, got ${anchor.kind}`);
  return (anchor as unknown as { quoted_text: string }).quoted_text;
}

// ─── READ ─────────────────────────────────────────────────────────────────

describe('readCommentsFromXml', () => {
  it('returns [] when there is no comments part', () => {
    const doc = docXml(para(run('Hello world')));
    expect(readCommentsFromXml(doc, null)).toEqual([]);
  });

  it('reads a native comment with range markers into a text-quote anchor', () => {
    // "Hello " <start> "world" <end><ref>
    const doc = docXml(
      para(
        run('Hello '),
        '<w:commentRangeStart w:id="0"/>',
        run('world'),
        '<w:commentRangeEnd w:id="0"/>',
        '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>',
      ),
    );
    const comments =
      `<w:comments xmlns:w="${W}">` +
      `<w:comment w:id="0" w:author="Reviewer" w:date="2026-06-15T00:00:00Z" w:initials="R">` +
      `<w:p><w:r><w:t>nice word</w:t></w:r></w:p></w:comment></w:comments>`;

    const [c] = readCommentsFromXml(doc, comments);
    expect(c.wid).toBe('0');
    expect(c.author).toBe('Reviewer');
    expect(c.date).toBe('2026-06-15T00:00:00Z');
    expect(c.text).toBe('nice word');
    expect(c.resolved).toBe(true);
    expect(c.anchor.kind).toBe('text-quote');
    expect(c.anchor.quoted_text).toBe('world');
  });

  it('maps a native comment into a unified CommentPayload', () => {
    const doc = docXml(
      para(
        '<w:commentRangeStart w:id="3"/>',
        run('flagged'),
        '<w:commentRangeEnd w:id="3"/>',
      ),
    );
    const comments =
      `<w:comments xmlns:w="${W}">` +
      `<w:comment w:id="3" w:author="AJB" w:date="2026-01-02T03:04:05Z">` +
      `<w:p><w:r><w:t>fix this</w:t></w:r></w:p></w:comment></w:comments>`;
    const [native] = readCommentsFromXml(doc, comments);
    const payload = nativeCommentToPayload(native, { docId: 'doc1', docVersion: 'sha1' });

    expect(payload.id).toBe('native-docx-3');
    expect(payload.origin).toBe('native-docx');
    expect(payload.native?.comment_id).toBe('3');
    expect(payload.doc_id).toBe('doc1');
    expect(payload.comment).toBe('fix this');
    expect(payload.highlighted_text).toBe('flagged');
    expect(payload.anchor.kind).toBe('text-quote');
  });
});

// ─── WRITE: run splitting + round-trip ────────────────────────────────────

describe('insertCommentIntoXml', () => {
  it('splits a single run mid-text and round-trips the span', () => {
    const doc = docXml(para(run('Hello world')));
    const runText = 'Hello world';
    const anchor = createMdAnchor(runText, 3, 8); // "lo wo"
    const r = expectOk(
      insertCommentIntoXml({
        documentXml: doc,
        commentsXml: null,
        contentTypesXml: CONTENT_TYPES,
        relsXml: DOC_RELS,
        anchor,
        commentText: 'span comment',
        author: 'Anthony Byrnes',
        dateIso: '2026-06-15T00:00:00Z',
      }),
    );

    // Body text is byte-for-byte unchanged.
    expect(bodyText(r.documentXml)).toBe('Hello world');
    // Markers present.
    expect(r.documentXml).toContain('<w:commentRangeStart w:id="0"/>');
    expect(r.documentXml).toContain('<w:commentRangeEnd w:id="0"/>');
    expect(r.documentXml).toContain('<w:commentReference w:id="0"/>');

    // Round-trip: read it back, the anchor covers exactly "lo wo".
    const [c] = readCommentsFromXml(r.documentXml, r.commentsXml);
    expect(c.anchor.quoted_text).toBe('lo wo');
    expect(c.resolved).toBe(true);
    expect(c.text).toBe('span comment');
  });

  it('anchors a span across multiple runs without rewriting body text', () => {
    const doc = docXml(para(run('Hello '), run('brave '), run('world')));
    const runText = 'Hello brave world';
    const anchor = createMdAnchor(runText, 6, 17); // "brave world"
    const r = expectOk(
      insertCommentIntoXml({
        documentXml: doc,
        commentsXml: null,
        contentTypesXml: CONTENT_TYPES,
        relsXml: DOC_RELS,
        anchor,
        commentText: 'multi-run',
        author: 'AJB',
        dateIso: '2026-06-15T00:00:00Z',
      }),
    );
    expect(bodyText(r.documentXml)).toBe('Hello brave world');
    const [c] = readCommentsFromXml(r.documentXml, r.commentsXml);
    expect(c.anchor.quoted_text).toBe('brave world');
  });

  it('anchors across a paragraph boundary', () => {
    const doc = docXml(para(run('Hello')) + para(run('world')));
    const runText = 'Hello\nworld';
    const anchor = createMdAnchor(runText, 0, 11); // whole "Hello\nworld"
    const r = expectOk(
      insertCommentIntoXml({
        documentXml: doc,
        commentsXml: null,
        contentTypesXml: CONTENT_TYPES,
        relsXml: DOC_RELS,
        anchor,
        commentText: 'cross-para',
        author: 'AJB',
        dateIso: '2026-06-15T00:00:00Z',
      }),
    );
    expect(bodyText(r.documentXml)).toBe('Helloworld'); // <w:t> text unchanged
    const [c] = readCommentsFromXml(r.documentXml, r.commentsXml);
    expect(c.anchor.quoted_text).toBe('Hello\nworld');
  });

  it('scaffolds comments part, content-type override and rel when absent', () => {
    const doc = docXml(para(run('one two three')));
    const anchor = createMdAnchor('one two three', 4, 7); // "two"
    const r = expectOk(
      insertCommentIntoXml({
        documentXml: doc,
        commentsXml: null,
        contentTypesXml: CONTENT_TYPES,
        relsXml: DOC_RELS,
        anchor,
        commentText: 'c',
        author: 'AJB',
        dateIso: '2026-06-15T00:00:00Z',
      }),
    );
    expect(r.commentsXml).toContain('<w:comments');
    expect(r.commentsXml).toContain('w:id="0"');
    expect(r.contentTypesXml).toContain('PartName="/word/comments.xml"');
    expect(r.contentTypesXml).toContain(
      'wordprocessingml.comments+xml',
    );
    expect(r.relsXml).toContain('relationships/comments');
    expect(r.relsXml).toContain('Target="comments.xml"');
  });

  it('mints w:id past existing comments', () => {
    const doc = docXml(
      para(
        '<w:commentRangeStart w:id="5"/>',
        run('flagged'),
        '<w:commentRangeEnd w:id="5"/>',
        run(' tail'),
      ),
    );
    const existing =
      `<w:comments xmlns:w="${W}"><w:comment w:id="5" w:author="X">` +
      `<w:p><w:r><w:t>old</w:t></w:r></w:p></w:comment></w:comments>`;
    const anchor = createMdAnchor('flagged tail', 8, 12); // "tail"
    const r = expectOk(
      insertCommentIntoXml({
        documentXml: doc,
        commentsXml: existing,
        contentTypesXml: CONTENT_TYPES,
        relsXml: DOC_RELS,
        anchor,
        commentText: 'new',
        author: 'AJB',
        dateIso: '2026-06-15T00:00:00Z',
      }),
    );
    expect(r.mintedId).toBe(6);
  });

  it('snaps to run boundaries on a non-simple run (tab) without rewriting it', () => {
    // Run carries a tab → not splittable; an interior anchor must snap, leaving
    // the run's bytes intact.
    const nonSimple = `<w:r><w:tab/><w:t xml:space="preserve">data</w:t></w:r>`;
    const doc = docXml(para(run('lead '), nonSimple, run(' trail')));
    // runText = "lead data trail"; anchor "data" sits inside the non-simple run.
    const anchor = createMdAnchor('lead data trail', 5, 9);
    const r = expectOk(
      insertCommentIntoXml({
        documentXml: doc,
        commentsXml: null,
        contentTypesXml: CONTENT_TYPES,
        relsXml: DOC_RELS,
        anchor,
        commentText: 'c',
        author: 'AJB',
        dateIso: '2026-06-15T00:00:00Z',
      }),
    );
    // The non-simple run is preserved verbatim (tab + text intact).
    expect(r.documentXml).toContain(nonSimple);
    expect(bodyText(r.documentXml)).toBe('lead data trail');
  });

  it('returns anchor_unresolved when the quote is not in the document', () => {
    const doc = docXml(para(run('Hello world')));
    const anchor = createMdAnchor('totally different text here', 0, 10);
    const r = insertCommentIntoXml({
      documentXml: doc,
      commentsXml: null,
      contentTypesXml: CONTENT_TYPES,
      relsXml: DOC_RELS,
      anchor,
      commentText: 'c',
      author: 'AJB',
      dateIso: '2026-06-15T00:00:00Z',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('anchor_unresolved');
  });

  it('preserves run formatting (rPr) across a split', () => {
    const rPr = '<w:rPr><w:b/></w:rPr>';
    const doc = docXml(para(run('bold text', rPr)));
    const anchor = createMdAnchor('bold text', 0, 4); // "bold"
    const r = expectOk(
      insertCommentIntoXml({
        documentXml: doc,
        commentsXml: null,
        contentTypesXml: CONTENT_TYPES,
        relsXml: DOC_RELS,
        anchor,
        commentText: 'c',
        author: 'AJB',
        dateIso: '2026-06-15T00:00:00Z',
      }),
    );
    // Both halves keep the bold rPr.
    const boldRuns = r.documentXml.match(/<w:rPr><w:b\/><\/w:rPr>/g) ?? [];
    expect(boldRuns.length).toBe(2);
    expect(bodyText(r.documentXml)).toBe('bold text');
  });
});

// ─── EDIT / DELETE ────────────────────────────────────────────────────────

describe('editCommentInXml', () => {
  it('swaps comment body text only', () => {
    const comments =
      `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="X">` +
      `<w:p><w:r><w:t>old text</w:t></w:r></w:p></w:comment></w:comments>`;
    const next = editCommentInXml(comments, '0', 'new text');
    expect(next).toContain('new text');
    expect(next).not.toContain('old text');
    expect(next).toContain('w:author="X"');
  });
});

describe('deleteCommentFromXml', () => {
  it('removes the comment and all three markers, leaving body text intact', () => {
    const doc = docXml(
      para(
        run('Hello '),
        '<w:commentRangeStart w:id="0"/>',
        run('world'),
        '<w:commentRangeEnd w:id="0"/>',
        '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="0"/></w:r>',
      ),
    );
    const comments =
      `<w:comments xmlns:w="${W}"><w:comment w:id="0" w:author="X">` +
      `<w:p><w:r><w:t>c</w:t></w:r></w:p></w:comment></w:comments>`;

    const next = deleteCommentFromXml(doc, comments, '0');
    expect(next.documentXml).not.toContain('commentRangeStart');
    expect(next.documentXml).not.toContain('commentRangeEnd');
    expect(next.documentXml).not.toContain('commentReference');
    expect(bodyText(next.documentXml)).toBe('Hello world');
    expect(next.commentsXml).not.toContain('<w:comment ');
  });
});

// ─── jszip I/O round-trip ─────────────────────────────────────────────────

describe('docx zip I/O', () => {
  let dir: string;
  let docxPath: string;

  /** A minimal but valid .docx with one paragraph and no comments. */
  async function writeFixtureDocx(body: string): Promise<void> {
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`,
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    );
    zip.file('word/document.xml', docXml(body));
    zip.file('word/_rels/document.xml.rels', DOC_RELS);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(docxPath, buf);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'docx-comments-'));
    docxPath = join(dir, 'sample.docx');
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('creates a comment on disk and reads it back', async () => {
    await writeFixtureDocx(para(run('The quick brown fox')));
    const anchor = createMdAnchor('The quick brown fox', 4, 9); // "quick"
    const created = await createDocxComment(docxPath, {
      anchor,
      commentText: 'speedy',
      author: 'Anthony Byrnes',
      dateIso: '2026-06-15T00:00:00Z',
    });
    expect(created.ok).toBe(true);

    const comments = await readDocxComments(docxPath, { docId: 'd', docVersion: 'v' });
    expect(comments).toHaveLength(1);
    expect(comments[0].comment).toBe('speedy');
    expect(quoteOf(comments[0].anchor)).toBe('quick');
    expect(comments[0].origin).toBe('native-docx');
  });

  it('edits then deletes a comment on disk', async () => {
    await writeFixtureDocx(para(run('alpha beta gamma')));
    const anchor = createMdAnchor('alpha beta gamma', 6, 10); // "beta"
    const created = await createDocxComment(docxPath, {
      anchor,
      commentText: 'first',
      author: 'AJB',
      dateIso: '2026-06-15T00:00:00Z',
    });
    expect(created.ok).toBe(true);
    const id = created.ok ? String(created.commentId) : '';

    await editDocxComment(docxPath, id, 'edited');
    let comments = await readDocxComments(docxPath, { docId: 'd', docVersion: 'v' });
    expect(comments[0].comment).toBe('edited');

    await deleteDocxComment(docxPath, id);
    comments = await readDocxComments(docxPath, { docId: 'd', docVersion: 'v' });
    expect(comments).toHaveLength(0);
  });

  it('keeps the zip valid and other parts intact after a write', async () => {
    await writeFixtureDocx(para(run('keep me safe')));
    const anchor = createMdAnchor('keep me safe', 0, 4); // "keep"
    await createDocxComment(docxPath, {
      anchor,
      commentText: 'c',
      author: 'AJB',
      dateIso: '2026-06-15T00:00:00Z',
    });
    const { readFile } = await import('node:fs/promises');
    const reread = await JSZip.loadAsync(await readFile(docxPath));
    expect(reread.file('word/document.xml')).toBeTruthy();
    expect(reread.file('word/comments.xml')).toBeTruthy();
    expect(reread.file('_rels/.rels')).toBeTruthy();
    const ct = await reread.file('[Content_Types].xml')!.async('string');
    expect(ct).toContain('PartName="/word/comments.xml"');
  });
});
