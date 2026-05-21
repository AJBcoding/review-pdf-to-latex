// Integration smoke: bundle main/bundle.ts via esbuild and invoke writeBundle.
// Verifies the real implementation (not a duplicated shim) end-to-end.

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, basename } from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopDir = '/Users/anthonybyrnes/gt/review_pdf_to_latex/polecats/rust/review_pdf_to_latex/desktop';
const sharedDir = join(desktopDir, 'shared');

// Bundle main/bundle.ts into a temp esm file, resolving @shared/* aliases.
const out = join(tmpdir(), `bundle-${randomBytes(4).toString('hex')}.mjs`);
await build({
  entryPoints: [join(desktopDir, 'main/bundle.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  alias: { '@shared': sharedDir },
  external: ['electron', 'fs', 'path', 'crypto', 'fs/promises'],
});
const mod = await import(out);

const fixtures = '/Users/anthonybyrnes/gt/review_pdf_to_latex/polecats/rust/review_pdf_to_latex/tests/fixtures';
const tmp = mkdtempSync(join(tmpdir(), 'rev1md1-int-'));
const src = join(tmp, 'report-1.0.pdf');
copyFileSync(join(fixtures, 'sample-annotated.pdf'), src);

const sha = createHash('sha256').update(readFileSync(src)).digest('hex');
const req = {
  sourcePath: src,
  sourceSha256: sha,
  pageCount: 1,
  appVersion: '0.0.1',
  author: 'AJB',
  comments: [
    {
      id: 'c1', doc_id: src, doc_version: sha,
      anchor: { page: 1, region: { x: 72, y: 698, w: 377, h: 16 } },
      highlighted_text: 'fixture text',
      comment: 'tighten this', redraft: null, redraft_suggestion: null,
      engagement_level: 'comment', author: 'AJB', kind: 'comment',
      status: 'open', created_at: new Date().toISOString(),
    },
    {
      id: 'c2', doc_id: src, doc_version: sha,
      anchor: { page: 1, region: { x: 72, y: 626, w: 208, h: 16 } },
      highlighted_text: 'fixture text 2',
      comment: '', redraft: 'replacement', redraft_suggestion: null,
      engagement_level: 'redraft', author: 'AJB', kind: 'comment',
      status: 'open', created_at: new Date().toISOString(),
    },
    {
      // Out-of-range page — should be skipped without failing the write.
      id: 'c3', doc_id: src, doc_version: sha,
      anchor: { page: 99, region: { x: 0, y: 0, w: 10, h: 10 } },
      highlighted_text: 'oob', comment: 'invisible', redraft: null,
      redraft_suggestion: null, engagement_level: 'surface', author: 'AJB',
      kind: 'comment', status: 'open', created_at: new Date().toISOString(),
    },
  ],
};
const res = await mod.writeBundle(req);
if (!res.ok) throw new Error(`writeBundle failed: ${res.reason} ${res.error}`);

console.log('[int] result keys:', Object.keys(res));
console.log('[int] bundlePdfPath:', res.bundlePdfPath);
console.log('[int] bundleJsonPath:', res.bundleJsonPath);
console.log('[int] bundleId:', res.bundleId);
console.log('[int] bundlePdfSha256:', res.bundlePdfSha256.slice(0, 16) + '…');
console.log('[int] annotationIds:', res.annotationIds);

// Verify on disk.
const json = JSON.parse(readFileSync(res.bundleJsonPath, 'utf8'));
if (json.schema_version !== 1) throw new Error('expected schema_version=1');
if (json.source.sha256 !== sha) throw new Error('source sha256 mismatch');
if (json.source.source_file_version !== '1.0') throw new Error(`expected source_file_version=1.0, got ${json.source.source_file_version}`);
if (json.rendered_pdf.sha256 !== res.bundlePdfSha256) throw new Error('rendered_pdf sha256 mismatch');
if (json.comments.length !== 3) throw new Error(`expected 3 comments in JSON, got ${json.comments.length}`);
if (json.comments[0].pdf_annotation_id !== 'annot-1') throw new Error(`c1 annot id wrong: ${json.comments[0].pdf_annotation_id}`);
if (json.comments[1].pdf_annotation_id !== 'annot-2') throw new Error(`c2 annot id wrong: ${json.comments[1].pdf_annotation_id}`);
if (json.comments[2].pdf_annotation_id !== null) throw new Error(`c3 (out-of-range) annot id should be null, got ${json.comments[2].pdf_annotation_id}`);

// Filename format check — must start with today's local-date prefix.
const today = new Date();
const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const pdfBase = basename(res.bundlePdfPath);
if (!pdfBase.startsWith(`${ymd} report-1.0 (AJB edits)`)) {
  throw new Error(`bad bundle filename: ${pdfBase}`);
}

console.log(`[int] all assertions passed ✓ (date prefix=${ymd})`);
console.log(`\nFiles in ${tmp}:`);
for (const f of readdirSync(tmp)) console.log(`  ${f}`);
