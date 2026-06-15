// §10.1 step 6 — seed the v1.1 draft for a just-completed round so the new
// versioned source file opens with re-raised comments already in place.
//
// Extracted from index.ts as a pure, dependency-injected unit so the
// read-before-write idempotency guard (N2) can be tested rig-free: the live
// renderer only injects `window.electronAPI` + crypto + the clock here.

import type {
  CommentPayload,
  DocFormat,
  DraftsFile,
  DraftsReadResult,
  DraftsWriteResult,
  ReadPdfBytesResult,
  ResultsEvent,
} from '@shared/types';

/** Path-derived format for the seeded v2 DraftsFile (§3.3). v1.1 seeding is a
 *  PDF-round notion today; the next write corrects `format` from the doc path
 *  if it ever differs. */
function formatForPath(p: string): DocFormat {
  const lower = p.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'md';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (lower.endsWith('.docx')) return 'docx';
  return 'pdf';
}

/** I/O + entropy the seed needs, injected so tests can supply in-memory fakes.
 *  Method shapes match the corresponding `window.electronAPI` methods. */
export interface SeedDraftIO {
  readPdfBytes(pdfPath: string): Promise<ReadPdfBytesResult>;
  readDrafts(pdfPath: string, sha256: string): Promise<DraftsReadResult>;
  writeDrafts(pdfPath: string, sha256: string, file: DraftsFile): Promise<DraftsWriteResult>;
  randomUUID(): string;
  nowIso(): string;
}

/** What the seed did. The renderer wrapper maps this onto its side effects:
 *  `seeded` / `skipped-existing` both mark the round seeded; `error` flashes
 *  the message; `noop` is silent. */
export type SeedOutcome =
  | { kind: 'seeded'; docId: string; sha256: string; commentCount: number }
  | { kind: 'skipped-existing'; docId: string; sha256: string }
  | { kind: 'noop'; reason: 'no_submit' | 'no_new_source' }
  | { kind: 'error'; message: string };

/** Re-raise policy (§8.5):
 *    - `applied` / `rejected` / `build_failed` → archived only (don't appear
 *      in the new draft).
 *    - `deferred` / `needs-followup` → fresh `open` comments with
 *      `derived_from` pointing at the original id, anchored at `new_anchor`
 *      if set (the redraft may have shifted text) else at the original
 *      `anchor`.
 *
 *  Idempotency (N2): the new source is content-addressed, so the re-raise set
 *  is fully determined by (submit, results) — re-seeding only ever reproduces
 *  identical content. But once a sidecar exists at the new doc's path it is
 *  authoritative: it's either a prior identical seed, or the user has since
 *  opened the new version and added comments. A re-emit of this completed
 *  round (e.g. the initial-scan re-read after re-opening v1 in a fresh
 *  session, where the in-memory `round.seeded` flag is gone) must not
 *  overwrite their work. So: read before write, and skip if a sidecar already
 *  exists. Disk sidecars are keyed by path, so the read at `newDocId` sees
 *  exactly the file a subsequent write would replace. */
export async function seedNextVersionDraft(
  event: ResultsEvent,
  io: SeedDraftIO,
): Promise<SeedOutcome> {
  const { results, submit } = event;
  if (!submit) return { kind: 'noop', reason: 'no_submit' };
  if (!results.new_source_path) return { kind: 'noop', reason: 'no_new_source' };

  // Read the new file's bytes to compute its sha256 = new doc_version.
  const bytes = await io.readPdfBytes(results.new_source_path);
  if (!bytes.ok) {
    return {
      kind: 'error',
      message: `Couldn’t seed next-version draft: ${bytes.reason} ${results.new_source_path}`,
    };
  }
  const newSha = bytes.sha256;
  const newDocId = bytes.resolvedPath;

  // Read-before-write guard (N2): never clobber an existing v1.1 sidecar.
  const existing = await io.readDrafts(newDocId, newSha);
  if (existing.ok && existing.file !== null) {
    return { kind: 'skipped-existing', docId: newDocId, sha256: newSha };
  }

  // Build the re-raise list: only deferred + needs-followup carry forward.
  const submitById = new Map(submit.comments.map((c) => [c.id, c]));
  const reraised: CommentPayload[] = [];
  for (const r of results.results) {
    if (r.status !== 'deferred' && r.status !== 'needs-followup') continue;
    const original = submitById.get(r.id);
    if (!original) continue; // results entry without a submit-side twin; skip.
    const anchor = r.new_anchor ?? original.anchor;
    reraised.push({
      id: io.randomUUID(),
      doc_id: newDocId,
      doc_version: newSha,
      anchor,
      highlighted_text: original.highlighted_text,
      comment: original.comment,
      redraft: original.redraft,
      redraft_suggestion: null,
      engagement_level: original.engagement_level,
      author: original.author,
      kind: 'comment',
      status: 'open',
      created_at: io.nowIso(),
      derived_from: original.id,
      agent_note: r.agent_note ?? null,
      origin: 'app-draft',
    });
  }

  const file: DraftsFile = {
    schema_version: 2,
    doc_version: newSha,
    format: formatForPath(newDocId),
    comments: reraised,
  };
  const res = await io.writeDrafts(newDocId, newSha, file);
  if (!res.ok) {
    return {
      kind: 'error',
      message: `Couldn’t write next-version draft (${res.reason}): ${res.error}`,
    };
  }
  return { kind: 'seeded', docId: newDocId, sha256: newSha, commentCount: reraised.length };
}
