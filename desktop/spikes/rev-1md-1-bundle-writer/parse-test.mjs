import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const desktopDir = '/Users/anthonybyrnes/gt/review_pdf_to_latex/polecats/rust/review_pdf_to_latex/desktop';
const out = join(tmpdir(), `parse-${randomBytes(4).toString('hex')}.mjs`);
await build({
  entryPoints: [join(desktopDir, 'shared/bundle.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20',
  outfile: out,
  alias: { '@shared': join(desktopDir, 'shared') },
});
const { parseSourceName, buildBundleFilename, mintBundleId } = await import(out);

// Spec §10.6 examples
const cases = [
  ['report-1.0.pdf', { base: 'report', source_version: '1.0', ext: 'pdf' }],
  ['notes-2.13.md', { base: 'notes', source_version: '2.13', ext: 'md' }],
  ['cota-impact-3.0.tex', { base: 'cota-impact', source_version: '3.0', ext: 'tex' }],
  // No-match cases
  ['report-v1.pdf', null],
  ['report-final.pdf', null],
  ['report_2026.pdf', null],
  ['report.pdf', null],
];
let ok = true;
for (const [input, expected] of cases) {
  const got = parseSourceName(input);
  const a = JSON.stringify(got);
  const b = JSON.stringify(expected);
  if (a === b) {
    console.log(`✓ ${input} → ${a}`);
  } else {
    console.log(`✗ ${input} → got ${a}, expected ${b}`);
    ok = false;
  }
}

// Filename builder
const date = new Date('2026-05-21T15:30:00Z');
const p = parseSourceName('report-1.0.pdf');
const f1 = buildBundleFilename({ parsed: p, fallbackBase: 'report-1.0.pdf', date, ext: 'pdf' });
const f2 = buildBundleFilename({ parsed: p, fallbackBase: 'report-1.0.pdf', date, ext: 'json' });
const f3 = buildBundleFilename({ parsed: null, fallbackBase: 'no-version.pdf', date, ext: 'pdf' });
console.log(`\nFilename builder:`);
console.log(`  ${f1}`);
console.log(`  ${f2}`);
console.log(`  ${f3} (no-version fallback)`);

// Note: filename uses LOCAL date — when run in UTC, May 21 stays May 21,
// but in PT, this would be May 21 too. The spec says "today's date at the
// moment of writing" which we interpret as local.

// Bundle ID
console.log(`\nBundle ID for 2026-05-21T15:30:00Z: ${mintBundleId(date)}`);
if (mintBundleId(date) !== '20260521-153000') {
  console.log(`✗ expected 20260521-153000`);
  ok = false;
}

process.exit(ok ? 0 : 1);
