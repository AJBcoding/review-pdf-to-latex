import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { DraftsFile, DocFingerprint } from '@shared/types';

// Canonical doc-identity surface (rev-l15). The one-shot sha256→path sidecar
// migration that once lived here is retired — it had completed in the field,
// yet ran as permanent blocking startup machinery. What survives is the
// rename-recovery path: a single fingerprint builder plus the matcher the
// `drafts:read` ENOENT flow uses to relink a sidecar after its doc is renamed.

/** Build the content fingerprint stored in a sidecar for rename-recovery.
 *  THE single canonical doc-identity function — both the fingerprint write
 *  (relink in main/index.ts) and the match scan below derive from this, so
 *  the hashed slice and the fields stay in lockstep. Reads the doc off disk;
 *  an unreadable file yields an empty-content fingerprint rather than throwing
 *  so callers on cold paths can treat it as non-fatal. */
export async function buildFingerprint(docPath: string): Promise<DocFingerprint> {
  let content: Buffer;
  try {
    content = await readFile(docPath);
  } catch {
    return {
      title_from_frontmatter: null,
      first_500_chars_sha256: createHash('sha256').update('').digest('hex'),
      anchor_count: 0,
      last_known_path: docPath,
    };
  }

  const text = content.toString('utf8');
  const first500 = text.slice(0, 500);
  const first500Hash = createHash('sha256').update(first500).digest('hex');

  let title: string | null = null;
  const frontmatterMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const titleMatch = frontmatterMatch[1].match(/^title:\s*(.+)$/m);
    if (titleMatch) title = titleMatch[1].trim().replace(/^["']|["']$/g, '');
  }

  const anchorCount = (text.match(/^#{1,6}\s/gm) ?? []).length;

  return {
    title_from_frontmatter: title,
    first_500_chars_sha256: first500Hash,
    anchor_count: anchorCount,
    last_known_path: docPath,
  };
}

/** Scan a drafts directory for a sidecar matching a given fingerprint.
 *  Used by the rename-recovery flow at doc open time. */
export async function findSidecarByFingerprint(
  draftsDir: string,
  fingerprint: DocFingerprint,
): Promise<{ sidecarPath: string; drafts: DraftsFile } | null> {
  let entries: string[];
  try {
    entries = await readdir(draftsDir);
  } catch {
    return null;
  }

  for (const name of entries) {
    if (!name.endsWith('.json') || name.endsWith('.migrated')) continue;
    const fullPath = join(draftsDir, name);
    try {
      const raw = await readFile(fullPath, 'utf8');
      const drafts: DraftsFile = JSON.parse(raw);
      if (
        drafts.doc_fingerprint &&
        drafts.doc_fingerprint.first_500_chars_sha256 === fingerprint.first_500_chars_sha256
      ) {
        return { sidecarPath: fullPath, drafts };
      }
    } catch {
      continue;
    }
  }

  return null;
}
