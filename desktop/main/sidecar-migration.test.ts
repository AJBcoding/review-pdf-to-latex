import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { runSidecarMigration, findSidecarByFingerprint } from './sidecar-migration.js';
import type { DraftsFile, DocFingerprint } from '@shared/types.js';

let testDir: string;
let userDataDir: string;
let projectRoot: string;
let draftsDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `sidecar-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  userDataDir = join(testDir, 'userData');
  projectRoot = join(testDir, 'project');
  draftsDir = join(projectRoot, '.review-state', 'drafts');
  await mkdir(draftsDir, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function writeDoc(name: string, content: string): Promise<string> {
  const docPath = join(projectRoot, name);
  await writeFile(docPath, content, 'utf8');
  return docPath;
}

async function writeLegacySidecar(hash: string, drafts: DraftsFile): Promise<string> {
  const path = join(draftsDir, `${hash}.json`);
  await writeFile(path, JSON.stringify(drafts, null, 2), 'utf8');
  return path;
}

async function writeAppState(root: string, lastDoc: string | null = null): Promise<void> {
  const state = {
    schema_version: 1,
    root,
    last_opened_doc: lastDoc,
    expanded_dirs: [],
    show_hidden: false,
  };
  await writeFile(join(userDataDir, 'state.json'), JSON.stringify(state), 'utf8');
}

describe('runSidecarMigration', () => {
  it('migrates a sha256-keyed sidecar to path-based', async () => {
    const content = 'Hello world PDF content';
    const docPath = await writeDoc('test.pdf', content);
    const hash = sha256(content);

    const drafts: DraftsFile = {
      schema_version: 1,
      doc_version: hash,
      comments: [],
    };
    await writeLegacySidecar(hash, drafts);
    await writeAppState(projectRoot, docPath);

    await runSidecarMigration(userDataDir);

    const newPath = join(draftsDir, 'test.pdf.json');
    const raw = await readFile(newPath, 'utf8');
    const migrated: DraftsFile = JSON.parse(raw);

    expect(migrated.doc_fingerprint).toBeDefined();
    expect(migrated.doc_fingerprint!.last_known_path).toBe(docPath);

    const entries = await readdir(draftsDir);
    expect(entries).toContain('test.pdf.json');
    expect(entries.some((e) => e.endsWith('.migrated'))).toBe(true);
  });

  it('is idempotent — skips already-migrated sidecars', async () => {
    const content = 'Already migrated content';
    const docPath = await writeDoc('already.pdf', content);
    const hash = sha256(content);

    const drafts: DraftsFile = {
      schema_version: 1,
      doc_version: hash,
      comments: [],
      doc_fingerprint: {
        title_from_frontmatter: null,
        first_500_chars_sha256: sha256(content.slice(0, 500)),
        anchor_count: 0,
        last_known_path: docPath,
      },
    };
    await writeLegacySidecar(hash, drafts);
    await writeAppState(projectRoot, docPath);

    await runSidecarMigration(userDataDir);

    // The original file should still be there, untouched.
    const originalPath = join(draftsDir, `${hash}.json`);
    const raw = await readFile(originalPath, 'utf8');
    const parsed: DraftsFile = JSON.parse(raw);
    expect(parsed.doc_fingerprint).toBeDefined();
  });

  it('handles missing AppState gracefully', async () => {
    // No state.json — should not throw.
    await runSidecarMigration(userDataDir);
  });

  it('handles empty drafts directory', async () => {
    await writeAppState(projectRoot);
    await runSidecarMigration(userDataDir);
    const entries = await readdir(draftsDir);
    expect(entries).toEqual([]);
  });
});

describe('findSidecarByFingerprint', () => {
  it('finds a sidecar matching the fingerprint', async () => {
    const content = '# Test Doc\nSome content here';
    const fp: DocFingerprint = {
      title_from_frontmatter: 'Test Doc',
      first_500_chars_sha256: sha256(content.slice(0, 500)),
      anchor_count: 1,
      last_known_path: '/old/path/test.md',
    };

    const drafts: DraftsFile = {
      schema_version: 1,
      doc_version: 'abc123',
      comments: [],
      doc_fingerprint: fp,
    };
    await writeFile(join(draftsDir, 'test.md.json'), JSON.stringify(drafts), 'utf8');

    const result = await findSidecarByFingerprint(draftsDir, fp);
    expect(result).not.toBeNull();
    expect(result!.sidecarPath).toBe(join(draftsDir, 'test.md.json'));
  });

  it('returns null when no match found', async () => {
    const fp: DocFingerprint = {
      title_from_frontmatter: null,
      first_500_chars_sha256: sha256('no match'),
      anchor_count: 0,
      last_known_path: '/nowhere',
    };

    const result = await findSidecarByFingerprint(draftsDir, fp);
    expect(result).toBeNull();
  });

  it('returns null for empty directory', async () => {
    const fp: DocFingerprint = {
      title_from_frontmatter: null,
      first_500_chars_sha256: sha256('anything'),
      anchor_count: 0,
      last_known_path: '/nowhere',
    };

    const result = await findSidecarByFingerprint(draftsDir, fp);
    expect(result).toBeNull();
  });

  it('skips .migrated files', async () => {
    const content = 'old content';
    const fp: DocFingerprint = {
      title_from_frontmatter: null,
      first_500_chars_sha256: sha256(content.slice(0, 500)),
      anchor_count: 0,
      last_known_path: '/old/path',
    };

    const drafts: DraftsFile = {
      schema_version: 1,
      doc_version: 'abc',
      comments: [],
      doc_fingerprint: fp,
    };
    await writeFile(join(draftsDir, 'old.json.migrated'), JSON.stringify(drafts), 'utf8');

    const result = await findSidecarByFingerprint(draftsDir, fp);
    expect(result).toBeNull();
  });
});
