// Single source of truth for crash-safe writes in the main process.
//
// Before rev-x9 this exact temp-file + rename dance was duplicated 5× (submit,
// bundle, and three inline copies in index.ts) plus three non-atomic writers
// (the drafts:read relink, the sidecar migration, and session-store). The
// helpers had drifted — some cleaned up the orphan temp file on failure, some
// didn't. Consolidating here means every sidecar the X5 migration rewrites is
// protected by one audited implementation.

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Atomically write `data` to `filePath`.
 *
 *  Ensures the parent directory exists, writes to a randomly-suffixed temp
 *  file *in the same directory*, then renames it over the target. rename(2) is
 *  atomic within a filesystem, so a reader (or a crash) never observes a
 *  half-written file. The temp must be a sibling of the target — rename across
 *  filesystems is a copy, not an atomic swap.
 *
 *  On any failure the orphan temp file is removed best-effort and the original
 *  error is rethrown, so callers keep their structured error handling.
 *
 *  Accepts bytes or text: the bundle writer hands it serialized PDF bytes, the
 *  .md save path hands it raw text, JSON callers go through {@link
 *  atomicWriteJson}. */
export async function atomicWrite(filePath: string, data: Uint8Array | string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmpPath, data);
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Atomically write `data` as pretty-printed JSON (2-space indent — the
 *  repo-wide convention for every sidecar/state file). Thin wrapper over
 *  {@link atomicWrite}. */
export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(data, null, 2));
}
