import { basename, dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { DraftsFile, DocFingerprint } from '@shared/comments';

/** Run at app startup before any document is opened. Walks known project
 *  roots (from AppState) and migrates sha256-keyed sidecars to path-based
 *  naming. Idempotent — already-migrated sidecars (those with a
 *  `doc_fingerprint`) are skipped. */
export async function runSidecarMigration(userDataPath: string): Promise<void> {
  const appStatePath = join(userDataPath, 'state.json');
  let appState: { root?: string | null; last_opened_doc?: string | null } | null = null;
  try {
    const raw = await readFile(appStatePath, 'utf8');
    appState = JSON.parse(raw);
  } catch {
    return;
  }
  if (!appState) return;

  const roots = new Set<string>();
  if (appState.root) roots.add(appState.root);
  if (appState.last_opened_doc) roots.add(dirname(resolve(appState.last_opened_doc)));

  for (const root of roots) {
    await migrateRoot(root);
  }
}

async function migrateRoot(root: string): Promise<void> {
  const draftsDir = join(root, '.review-state', 'drafts');
  let entries: string[];
  try {
    entries = await readdir(draftsDir);
  } catch {
    return;
  }

  const sha256Pattern = /^[0-9a-f]{64}\.json$/;
  const legacySidecars = entries.filter((e) => sha256Pattern.test(e));
  if (legacySidecars.length === 0) return;

  const docFiles = await findDocFiles(root);

  for (const sidecarName of legacySidecars) {
    const sidecarPath = join(draftsDir, sidecarName);
    try {
      await migrateSingleSidecar(sidecarPath, sidecarName, docFiles, draftsDir);
    } catch (err) {
      console.warn(`[sidecar-migration] failed to migrate ${sidecarPath}:`, err);
    }
  }
}

async function migrateSingleSidecar(
  sidecarPath: string,
  sidecarName: string,
  docFiles: Map<string, string>,
  draftsDir: string,
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(sidecarPath, 'utf8');
  } catch {
    return;
  }

  let drafts: DraftsFile;
  try {
    drafts = JSON.parse(raw);
  } catch {
    return;
  }

  if (drafts.doc_fingerprint) return;

  const sha256 = sidecarName.replace('.json', '');
  const matchingDocPath = docFiles.get(sha256);

  if (!matchingDocPath) {
    console.warn(`[sidecar-migration] no matching doc found for ${sidecarName}, skipping`);
    return;
  }

  const docBasename = basename(matchingDocPath);
  const newSidecarPath = join(draftsDir, `${docBasename}.json`);

  const fingerprint = await buildFingerprint(matchingDocPath);
  drafts.doc_fingerprint = fingerprint;

  await mkdir(dirname(newSidecarPath), { recursive: true });
  await writeFile(newSidecarPath, JSON.stringify(drafts, null, 2), 'utf8');

  if (newSidecarPath !== sidecarPath) {
    try {
      await rename(sidecarPath, `${sidecarPath}.migrated`);
    } catch {
      // Best-effort cleanup — the new file is the source of truth now.
    }
  }

  console.log(`[sidecar-migration] migrated ${sidecarName} → ${docBasename}.json`);
}

async function findDocFiles(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const stack = [root];

  const HIDDEN_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'dist', 'build']);
  const DOC_EXTS = new Set(['.pdf', '.md', '.markdown']);

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || HIDDEN_DIRS.has(entry.name)) {
        if (entry.isDirectory()) continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!HIDDEN_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          stack.push(fullPath);
        }
      } else if (entry.isFile()) {
        const ext = entry.name.toLowerCase().slice(entry.name.lastIndexOf('.'));
        if (DOC_EXTS.has(ext)) {
          try {
            const buf = await readFile(fullPath);
            const hash = createHash('sha256').update(buf).digest('hex');
            result.set(hash, fullPath);
          } catch {
            // Skip unreadable files.
          }
        }
      }
    }
    if (result.size > 10000) break;
  }

  return result;
}

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
