// @vitest-environment jsdom
//
// Smoke test for the renderer's "silent-bail" getElementById class (rev-1rk8).
//
// index.ts looks up ~80 elements via `requireEl(id)` and guards each with
// `if (!el) return`. That guard degrades gracefully at runtime but is *silent*:
// if an id drifts between index.html and index.ts (a rename on one side only),
// the feature quietly stops working with no error. This test makes that drift
// loud — it parses the real index.html and asserts that every id the renderer
// requires through `requireEl(...)` actually exists in the markup.
//
// Runtime-created elements (the external-modification modal) intentionally stay
// on `document.getElementById` in index.ts, so they are not `requireEl` ids and
// are correctly excluded from this contract.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Every element id declared in the static index.html. */
function htmlElementIds(): Set<string> {
  const doc = new DOMParser().parseFromString(read('./index.html'), 'text/html');
  const ids = new Set<string>();
  doc.querySelectorAll('[id]').forEach((el) => ids.add(el.id));
  return ids;
}

/** Every id index.ts looks up through `requireEl(...)` / `requireEl<T>(...)` —
 *  i.e. the ids the renderer requires the static HTML to provide. */
function requiredElementIds(): string[] {
  const src = read('./index.ts');
  const re = /requireEl(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g;
  const ids: string[] = [];
  for (let m = re.exec(src); m !== null; m = re.exec(src)) ids.push(m[1]);
  return ids;
}

describe('renderer DOM contract (requireEl silent-bail class)', () => {
  it('scans a non-trivial set of required ids (guards against a broken scan)', () => {
    // If the regex or helper name ever changes, this trips before the
    // contract assertion below can pass vacuously.
    expect(requiredElementIds().length).toBeGreaterThan(50);
  });

  it('every requireEl(...) id exists in index.html', () => {
    const html = htmlElementIds();
    const missing = [...new Set(requiredElementIds())].filter((id) => !html.has(id));
    expect(missing).toEqual([]);
  });
});
