// Safety net for the Submit promote/abandon writers (rev-x1). promoteDraft is
// the single writer that flips `open` → `submitted` and freezes the audit copy
// in `.review-state/submit-<id>.json`; abandonRound owns the §10.1 step-6 soft
// tombstone rename. Both touch disk, so we exercise them against a temp dir.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promoteDraft, abandonRound } from './submit.js';
import type { CommentPayload, CommentStatus, SubmitFile } from '@shared/types.js';

let testDir: string;
let projectRoot: string;
let reviewStateDir: string;
let sourcePath: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `submit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectRoot = join(testDir, 'project');
  reviewStateDir = join(projectRoot, '.review-state');
  sourcePath = join(projectRoot, 'report-1.0.pdf');
  await mkdir(projectRoot, { recursive: true });
  await writeFile(sourcePath, '%PDF-1.4 stub', 'utf8');
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

let idCounter = 0;
function makeComment(overrides: Partial<CommentPayload> = {}): CommentPayload {
  idCounter += 1;
  return {
    id: `c${idCounter}`,
    doc_id: sourcePath,
    doc_version: 'sha-abc',
    anchor: { page: 1, region: { x: 1, y: 2, w: 3, h: 4 } },
    highlighted_text: 'text',
    comment: 'a comment',
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

function promoteReq(comments: CommentPayload[]) {
  return {
    sourcePath,
    sourceSha256: 'sha-abc',
    sourceFileVersion: '1.0',
    bundlePdfPath: join(projectRoot, 'bundle.pdf'),
    bundleJsonPath: join(projectRoot, 'bundle.json'),
    originRig: 'review_pdf_to_latex',
    comments,
    author: 'AJB',
  };
}

describe('promoteDraft — status flip semantics', () => {
  it('flips open entries to submitted and stamps submitted_at', async () => {
    const res = await promoteDraft(promoteReq([makeComment({ id: 'open-1' })]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const frozen = res.submitFile.comments[0];
    expect(frozen.status).toBe('submitted');
    expect(frozen.submitted_at).toBe(res.submitFile.submitted_at);
    expect(res.statusUpdates).toEqual([
      { commentId: 'open-1', submittedAt: res.submitFile.submitted_at },
    ]);
  });

  it('treats a missing status as open and promotes it', async () => {
    // status is required by the type but on-disk drafts may omit it; the
    // writer coalesces `c.status ?? 'open'`, so simulate the undefined case.
    const c = makeComment({ id: 'no-status' });
    delete (c as Partial<CommentPayload>).status;

    const res = await promoteDraft(promoteReq([c]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.submitFile.comments[0].status).toBe('submitted');
    expect(res.statusUpdates.map((u) => u.commentId)).toEqual(['no-status']);
  });

  it('preserves already-terminal entries untouched and omits them from statusUpdates', async () => {
    const terminal: CommentStatus[] = [
      'applied',
      'deferred',
      'needs-followup',
      'rejected',
      'build_failed',
      'submitted',
    ];
    const comments = terminal.map((status, i) =>
      makeComment({ id: `term-${i}`, status, submitted_at: '2026-01-01T00:00:00.000Z' }),
    );

    const res = await promoteDraft(promoteReq(comments));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // None flipped — statusUpdates empty, statuses unchanged.
    expect(res.statusUpdates).toEqual([]);
    res.submitFile.comments.forEach((c, i) => {
      expect(c.status).toBe(terminal[i]);
      expect(c.submitted_at).toBe('2026-01-01T00:00:00.000Z');
    });
  });

  it('flips only the open entries in a mixed batch, freezing all of them', async () => {
    const comments = [
      makeComment({ id: 'open-a', status: 'open' }),
      makeComment({ id: 'applied-b', status: 'applied' }),
      makeComment({ id: 'open-c', status: 'open' }),
    ];
    const res = await promoteDraft(promoteReq(comments));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.statusUpdates.map((u) => u.commentId).sort()).toEqual(['open-a', 'open-c']);
    expect(res.submitFile.comments).toHaveLength(3);
    const byId = new Map(res.submitFile.comments.map((c) => [c.id, c.status]));
    expect(byId.get('open-a')).toBe('submitted');
    expect(byId.get('open-c')).toBe('submitted');
    expect(byId.get('applied-b')).toBe('applied');
  });

  it('does not mutate the caller-supplied comment objects', async () => {
    const original = makeComment({ id: 'pure', status: 'open' });
    await promoteDraft(promoteReq([original]));
    expect(original.status).toBe('open');
    expect(original.submitted_at).toBeUndefined();
  });

  it('writes the frozen submit file to .review-state/submit-<id>.json', async () => {
    const res = await promoteDraft(promoteReq([makeComment({ id: 'persist-1' })]));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.submitFilePath).toBe(join(reviewStateDir, `submit-${res.submitId}.json`));
    expect(existsSync(res.submitFilePath)).toBe(true);

    const onDisk: SubmitFile = JSON.parse(await readFile(res.submitFilePath, 'utf8'));
    expect(onDisk.submit_id).toBe(res.submitId);
    expect(onDisk.doc_version).toBe('sha-abc');
    expect(onDisk.doc_id).toBe(sourcePath);
    expect(onDisk.comments[0].status).toBe('submitted');
  });

  it('creates .review-state/ when it does not exist yet', async () => {
    expect(existsSync(reviewStateDir)).toBe(false);
    const res = await promoteDraft(promoteReq([makeComment()]));
    expect(res.ok).toBe(true);
    expect(existsSync(reviewStateDir)).toBe(true);
  });

  it('leaves no .tmp scratch file behind after the atomic write', async () => {
    const res = await promoteDraft(promoteReq([makeComment()]));
    expect(res.ok).toBe(true);
    const entries = await readdir(reviewStateDir);
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });
});

describe('abandonRound — soft tombstone (§10.1 step 6)', () => {
  it('renames results-<ts>.json → results-<ts>.abandoned.json', async () => {
    await mkdir(reviewStateDir, { recursive: true });
    const resultsPath = join(reviewStateDir, 'results-2026.json');
    await writeFile(resultsPath, '{}', 'utf8');

    const res = await abandonRound({ resultsFilePath: resultsPath });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.renamedTo).toBe(join(reviewStateDir, 'results-2026.abandoned.json'));
    expect(existsSync(resultsPath)).toBe(false);
    expect(existsSync(res.renamedTo)).toBe(true);
  });

  it('is idempotent — already-tombstoned files no-op rename to themselves', async () => {
    await mkdir(reviewStateDir, { recursive: true });
    const tombstoned = join(reviewStateDir, 'results-2026.abandoned.json');
    await writeFile(tombstoned, '{}', 'utf8');

    const res = await abandonRound({ resultsFilePath: tombstoned });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.renamedTo).toBe(tombstoned);
    expect(existsSync(tombstoned)).toBe(true);
  });

  it('returns not_found for a missing results file', async () => {
    const res = await abandonRound({
      resultsFilePath: join(reviewStateDir, 'results-missing.json'),
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('not_found');
  });
});
