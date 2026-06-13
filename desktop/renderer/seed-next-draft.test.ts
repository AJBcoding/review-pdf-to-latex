// Rig-free tests for the v1.1 draft seeding + N2 idempotency guard.
//
// The bug (rev-n2): re-opening a doc with a completed round re-emits that
// round, which re-ran seeding and clobbered the next version's sidecar —
// destroying any comments the user had added to v1.1. These tests drive the
// pure seed unit with an in-memory "disk" keyed by path (matching the real
// main-process `draftsPathFor` path-based keying) and assert the guard.

import { beforeEach, describe, expect, it } from 'vitest';
import { seedNextVersionDraft, type SeedDraftIO } from './seed-next-draft';
import type {
  AnchorRegion,
  CommentPayload,
  DraftsFile,
  DraftsReadResult,
  ReadPdfBytesResult,
  ResultEntry,
  ResultsEvent,
  ResultsFile,
  SubmitFile,
} from '@shared/types';

const V11_PATH = '/proj/paper.v1.1.md';
const V11_SHA = 'sha-of-v1.1';

const ANCHOR: AnchorRegion = { page: 1, region: { x: 0, y: 0, w: 10, h: 10 } };

function comment(id: string, overrides: Partial<CommentPayload> = {}): CommentPayload {
  return {
    id,
    doc_id: '/proj/paper.md',
    doc_version: 'sha-of-v1',
    anchor: ANCHOR,
    highlighted_text: `text-${id}`,
    comment: `comment-${id}`,
    redraft: null,
    redraft_suggestion: null,
    engagement_level: 'comment',
    author: 'reviewer',
    kind: 'comment',
    status: 'open',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** In-memory disk keyed by path (the real sidecar keying ignores sha256). */
class FakeDisk {
  files = new Map<string, DraftsFile>();
  uuidCounter = 0;
  bytesFails = false;
  writeFails = false;

  io(): SeedDraftIO {
    return {
      readPdfBytes: async (p): Promise<ReadPdfBytesResult> => {
        if (this.bytesFails) {
          return { ok: false, reason: 'not_found', resolvedPath: p };
        }
        return { ok: true, bytes: new Uint8Array(), resolvedPath: V11_PATH, sha256: V11_SHA };
      },
      readDrafts: async (p): Promise<DraftsReadResult> => {
        const file = this.files.get(p);
        if (!file) return { ok: true, file: null, filePath: p, reason: 'not_found' };
        return { ok: true, file, filePath: p };
      },
      writeDrafts: async (p, _sha, file) => {
        if (this.writeFails) {
          return { ok: false, reason: 'write_failed', filePath: p, error: 'disk full' };
        }
        this.files.set(p, file);
        return { ok: true, filePath: p };
      },
      randomUUID: () => `uuid-${++this.uuidCounter}`,
      nowIso: () => '2026-02-02T00:00:00.000Z',
    };
  }
}

function results(entries: ResultEntry[]): ResultsFile {
  return {
    submit_id: 'submit-1',
    results_id: 'results-1',
    round_status: 'complete',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:05:00.000Z',
    new_source_path: '/proj/paper.v1.1.md',
    version_chosen: '1.1',
    results: entries,
  };
}

function submitFile(comments: CommentPayload[]): SubmitFile {
  return {
    submit_id: 'submit-1',
    doc_id: '/proj/paper.md',
    doc_version: 'sha-of-v1',
    source_file_version: 'sha-of-v1',
    submitted_at: '2026-01-01T00:00:00.000Z',
    origin_rig: null,
    comments,
  };
}

function event(submit: SubmitFile, r: ResultsFile, source: 'initial' | 'change'): ResultsEvent {
  return { filePath: '/proj/.review-state/results-1.json', results: r, submit, matchesDoc: true, source };
}

describe('seedNextVersionDraft', () => {
  let disk: FakeDisk;
  beforeEach(() => {
    disk = new FakeDisk();
  });

  it('seeds deferred + needs-followup comments into a fresh v1.1 sidecar', async () => {
    const submit = submitFile([comment('a'), comment('b'), comment('c')]);
    const r = results([
      { id: 'a', status: 'deferred' },
      { id: 'b', status: 'applied' }, // archived — must NOT carry forward
      { id: 'c', status: 'needs-followup' },
    ]);

    const outcome = await seedNextVersionDraft(event(submit, r, 'change'), disk.io());

    expect(outcome.kind).toBe('seeded');
    const seeded = disk.files.get(V11_PATH);
    expect(seeded).toBeDefined();
    expect(seeded!.comments.map((c) => c.derived_from).sort()).toEqual(['a', 'c']);
    for (const c of seeded!.comments) {
      expect(c.status).toBe('open');
      expect(c.doc_version).toBe(V11_SHA);
    }
  });

  // The core N2 regression: complete round → user adds v1.1 comments →
  // re-open v1 (re-emits the completed round) → sidecar must stay intact.
  it('does not clobber an existing v1.1 sidecar on re-emit', async () => {
    const submit = submitFile([comment('a')]);
    const r = results([{ id: 'a', status: 'deferred' }]);

    // 1. Round completes → initial seed.
    const first = await seedNextVersionDraft(event(submit, r, 'change'), disk.io());
    expect(first.kind).toBe('seeded');
    expect(disk.files.get(V11_PATH)!.comments).toHaveLength(1);

    // 2. User opens v1.1 and adds their own comments to the sidecar.
    const userComment = comment('user-1', { doc_id: V11_PATH, doc_version: V11_SHA });
    const live = disk.files.get(V11_PATH)!;
    disk.files.set(V11_PATH, { ...live, comments: [...live.comments, userComment] });
    expect(disk.files.get(V11_PATH)!.comments).toHaveLength(2);

    // 3. User re-opens v1 → the watcher's initial scan re-emits the same
    //    completed round (no in-memory `seeded` flag in the fresh session).
    const second = await seedNextVersionDraft(event(submit, r, 'initial'), disk.io());

    expect(second.kind).toBe('skipped-existing');
    const after = disk.files.get(V11_PATH)!;
    expect(after.comments).toHaveLength(2);
    expect(after.comments.some((c) => c.id === 'user-1')).toBe(true);
  });

  it('is a no-op when the round has no submit file or no new source path', async () => {
    const submit = submitFile([comment('a')]);
    const noSource = { ...results([{ id: 'a', status: 'deferred' }]), new_source_path: null };

    const a = await seedNextVersionDraft({ ...event(submit, results([]), 'change'), submit: null }, disk.io());
    expect(a).toEqual({ kind: 'noop', reason: 'no_submit' });

    const b = await seedNextVersionDraft(event(submit, noSource, 'change'), disk.io());
    expect(b).toEqual({ kind: 'noop', reason: 'no_new_source' });
    expect(disk.files.size).toBe(0);
  });

  it('reports an error (and writes nothing) when reading the new file fails', async () => {
    disk.bytesFails = true;
    const submit = submitFile([comment('a')]);
    const outcome = await seedNextVersionDraft(
      event(submit, results([{ id: 'a', status: 'deferred' }]), 'change'),
      disk.io(),
    );
    expect(outcome.kind).toBe('error');
    expect(disk.files.size).toBe(0);
  });

  it('reports an error when the sidecar write fails', async () => {
    disk.writeFails = true;
    const submit = submitFile([comment('a')]);
    const outcome = await seedNextVersionDraft(
      event(submit, results([{ id: 'a', status: 'deferred' }]), 'change'),
      disk.io(),
    );
    expect(outcome.kind).toBe('error');
  });
});
