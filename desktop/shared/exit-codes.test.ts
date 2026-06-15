// Contract test for the engine exit-code twin (rev-x10).
//
// The authoritative source of the spec-§8 exit-code contract is the Python
// module `src/review_pdf_to_latex/exit_codes.py`. `exit-codes.ts` mirrors it
// for the desktop app. This test reads the Python source directly and fails if
// the two ever drift — the whole point of single-sourcing is that they cannot
// silently diverge across the engine↔desktop seam.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { EXIT, EXIT_ENCRYPTED, PDF_HEALTH_REPORTING_EXITS } from './exit-codes.js';

const here = dirname(fileURLToPath(import.meta.url));
// desktop/shared -> repo root -> src/review_pdf_to_latex/exit_codes.py
const PY_EXIT_CODES = resolve(here, '..', '..', 'src', 'review_pdf_to_latex', 'exit_codes.py');

/**
 * Parse `EXIT_NAME = <int>` and the single `EXIT_ENCRYPTED = EXIT_SOURCE_PDF_CHANGED`
 * alias out of the Python source. Returns a map of every EXIT_* constant to its
 * resolved integer value. Deliberately a small bespoke parser, not an import —
 * the test must observe the Python file as text so a renumber there is caught
 * here without running Python.
 */
function parsePythonExitCodes(source: string): Map<string, number> {
  const direct = new Map<string, number>();
  const aliases: Array<[string, string]> = [];
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    const intMatch = /^(EXIT_[A-Z_]+)\s*=\s*(\d+)\b/.exec(line);
    if (intMatch) {
      direct.set(intMatch[1], Number(intMatch[2]));
      continue;
    }
    const aliasMatch = /^(EXIT_[A-Z_]+)\s*=\s*(EXIT_[A-Z_]+)\b/.exec(line);
    if (aliasMatch) {
      aliases.push([aliasMatch[1], aliasMatch[2]]);
    }
  }
  for (const [name, target] of aliases) {
    const value = direct.get(target);
    if (value === undefined) {
      throw new Error(`alias ${name} points at unknown ${target}`);
    }
    direct.set(name, value);
  }
  return direct;
}

describe('exit-codes TS twin (rev-x10)', () => {
  const py = parsePythonExitCodes(readFileSync(PY_EXIT_CODES, 'utf8'));

  it('parses a sane set of constants from the Python source', () => {
    // Guard against a path/parse regression silently passing every assertion.
    expect(py.get('EXIT_OK')).toBe(0);
    expect(py.size).toBeGreaterThanOrEqual(24);
  });

  it('every TS EXIT.<NAME> matches Python EXIT_<NAME>', () => {
    for (const [key, value] of Object.entries(EXIT)) {
      const pyName = `EXIT_${key}`;
      expect(py.has(pyName), `Python is missing ${pyName}`).toBe(true);
      expect(value, `${pyName} drifted`).toBe(py.get(pyName));
    }
  });

  it('every Python EXIT_* (except the encrypted alias) has a TS twin', () => {
    for (const [name, value] of py) {
      if (name === 'EXIT_ENCRYPTED') continue; // exported separately below
      const key = name.slice('EXIT_'.length) as keyof typeof EXIT;
      expect(EXIT[key], `TS twin missing ${name}`).toBe(value);
    }
  });

  it('mirrors the deliberate 21 overload (EXIT_ENCRYPTED === SOURCE_PDF_CHANGED)', () => {
    expect(EXIT_ENCRYPTED).toBe(EXIT.SOURCE_PDF_CHANGED);
    expect(EXIT_ENCRYPTED).toBe(py.get('EXIT_ENCRYPTED'));
    expect(EXIT_ENCRYPTED).toBe(21);
  });

  it('pdf-health reporting exits are exactly {OK, MISSING_PDF, ENCRYPTED}', () => {
    expect([...PDF_HEALTH_REPORTING_EXITS].sort((a, b) => a - b)).toEqual([
      EXIT.OK,
      EXIT.MISSING_PDF,
      EXIT_ENCRYPTED,
    ].sort((a, b) => a - b));
  });
});
