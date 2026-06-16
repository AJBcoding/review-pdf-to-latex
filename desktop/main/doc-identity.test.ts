import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { buildFingerprint, findSidecarByFingerprint } from './doc-identity.js';
import type { DraftsFileV1, DocFingerprint } from '@shared/types.js';

let testDir: string;
let projectRoot: string;
let draftsDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `doc-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  projectRoot = join(testDir, 'project');
  draftsDir = join(projectRoot, '.review-state', 'drafts');
  await mkdir(draftsDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('buildFingerprint', () => {
  it('hashes the first 500 chars and extracts frontmatter title + anchor count', async () => {
    const docPath = join(projectRoot, 'doc.md');
    const body = '---\ntitle: "My Doc"\n---\n# Heading one\n## Heading two\nbody text';
    await writeFile(docPath, body, 'utf8');

    const fp = await buildFingerprint(docPath);

    expect(fp.first_500_chars_sha256).toBe(sha256(body.slice(0, 500)));
    expect(fp.title_from_frontmatter).toBe('My Doc');
    expect(fp.anchor_count).toBe(2);
    expect(fp.last_known_path).toBe(docPath);
  });

  it('returns an empty-content fingerprint for an unreadable file (non-fatal)', async () => {
    const missing = join(projectRoot, 'nope.md');
    const fp = await buildFingerprint(missing);

    expect(fp.first_500_chars_sha256).toBe(sha256(''));
    expect(fp.title_from_frontmatter).toBeNull();
    expect(fp.anchor_count).toBe(0);
    expect(fp.last_known_path).toBe(missing);
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

    const drafts: DraftsFileV1 = {
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

    const drafts: DraftsFileV1 = {
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
