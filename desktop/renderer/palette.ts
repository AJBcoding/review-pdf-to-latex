// §3.5 quick-open palette.
//
// Cmd+P opens a modal over the layout. The user types; we fuzzy-match against
// the eagerly-built PDF index for the current root; arrow keys + Enter pick
// one and hand its absolute path back to the host. Esc or click-outside
// dismisses.
//
// Fuzzy match is in-process — for v1's expected dataset (hundreds, maybe low
// thousands of files), a linear scan over the index per keystroke is well
// under a frame. If this ever shows in a profile, swap to a precomputed
// trigram index or a worker.

import type { IndexedPdf } from '@shared/files';

export interface PaletteOptions {
  root: HTMLElement;          // #palette
  input: HTMLInputElement;    // #paletteInput
  list: HTMLElement;          // #paletteList
  empty: HTMLElement;         // #paletteEmpty
  onPick: (absPath: string) => void;
}

interface Scored {
  pdf: IndexedPdf;
  score: number;
  highlight: number[];        // char positions in relPath that matched
}

const MAX_RESULTS = 100;

export class QuickOpenPalette {
  private opts: PaletteOptions;
  private index: IndexedPdf[] = [];
  private results: Scored[] = [];
  private selectedIdx = 0;

  constructor(opts: PaletteOptions) {
    this.opts = opts;
    this.opts.input.addEventListener('input', () => this.recompute());
    this.opts.input.addEventListener('keydown', (e) => this.onKeydown(e));
    // Click-outside dismisses. The .palette-card stopPropagation so clicks
    // inside the modal frame don't bubble back up here and close it.
    this.opts.root.addEventListener('click', (e) => {
      if (e.target === this.opts.root) this.close();
    });
    const card = this.opts.root.querySelector<HTMLElement>('.palette-card');
    card?.addEventListener('click', (e) => e.stopPropagation());
    // Per-row click handled in render() — needs the row's pdf payload.
  }

  /** Swap in a fresh PDF index (e.g. after the root changed). Clears any
   *  open results so we don't show stale matches under a new root. */
  setIndex(pdfs: IndexedPdf[]): void {
    this.index = pdfs;
    if (this.isOpen()) this.recompute();
  }

  isOpen(): boolean {
    return !this.opts.root.hidden;
  }

  open(): void {
    if (this.isOpen()) {
      this.opts.input.focus();
      this.opts.input.select();
      return;
    }
    this.opts.root.hidden = false;
    this.opts.input.value = '';
    this.opts.input.focus();
    this.recompute();
  }

  close(): void {
    if (!this.isOpen()) return;
    this.opts.root.hidden = true;
    this.opts.list.replaceChildren();
    this.results = [];
    this.selectedIdx = 0;
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.selectedIdx = Math.min(this.results.length - 1, this.selectedIdx + 1);
      this.renderSelection();
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.selectedIdx = Math.max(0, this.selectedIdx - 1);
      this.renderSelection();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = this.results[this.selectedIdx];
      if (!pick) return;
      this.opts.onPick(pick.pdf.path);
      this.close();
      return;
    }
  }

  private recompute(): void {
    const q = this.opts.input.value.trim();
    this.results = q ? rankIndex(this.index, q) : initialResults(this.index);
    this.selectedIdx = 0;
    this.renderResults();
  }

  private renderResults(): void {
    const { list, empty } = this.opts;
    list.replaceChildren();
    if (this.results.length === 0) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    const limited = this.results.slice(0, MAX_RESULTS);
    for (let i = 0; i < limited.length; i++) {
      const r = limited[i];
      const li = document.createElement('li');
      li.className = 'palette-row';
      li.setAttribute('role', 'option');
      li.dataset.idx = String(i);
      const name = document.createElement('span');
      name.className = 'palette-row-name';
      const path = document.createElement('span');
      path.className = 'palette-row-path';
      // Highlight the matched characters across the full relPath display.
      paintHighlighted(path, r.pdf.relPath, r.highlight);
      // Repeat the basename in bold on the left so "look-for-the-file-name"
      // is the dominant visual cue.
      const baseStart = r.pdf.relPath.lastIndexOf('/') + 1;
      const baseHighlight = r.highlight
        .filter((p) => p >= baseStart)
        .map((p) => p - baseStart);
      paintHighlighted(name, r.pdf.name, baseHighlight);
      li.append(name, path);
      li.addEventListener('click', () => {
        this.opts.onPick(r.pdf.path);
        this.close();
      });
      li.addEventListener('mousemove', () => {
        if (this.selectedIdx !== i) {
          this.selectedIdx = i;
          this.renderSelection();
        }
      });
      list.append(li);
    }
    this.renderSelection();
  }

  private renderSelection(): void {
    const rows = this.opts.list.querySelectorAll<HTMLElement>('.palette-row');
    rows.forEach((row, i) => row.classList.toggle('is-selected', i === this.selectedIdx));
    const sel = rows[this.selectedIdx];
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  }
}

function paintHighlighted(target: HTMLElement, text: string, positions: number[]): void {
  if (positions.length === 0) {
    target.textContent = text;
    return;
  }
  const set = new Set(positions);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (set.has(i)) {
      const span = document.createElement('span');
      span.className = 'palette-hl';
      span.textContent = ch;
      target.append(span);
    } else {
      target.append(document.createTextNode(ch));
    }
  }
}

/** Cheap initial results when the input is empty — alphabetical, no scoring. */
function initialResults(index: IndexedPdf[]): Scored[] {
  return index.slice(0, MAX_RESULTS).map((pdf) => ({ pdf, score: 0, highlight: [] }));
}

/**
 * Subsequence fuzzy match. For each entry, find the cheapest left-to-right
 * subsequence of `query` characters in `relPath`. Score rewards:
 *  - matching in the basename (post-last-slash) over matching in the prefix
 *  - consecutive runs (no gaps between matched chars)
 *  - case-matching the query char
 *  - matches at word boundaries (after `/`, `-`, `_`, `.`, ` `)
 *  - a shorter overall span (start..end of matched chars)
 *
 * Returns top entries sorted by descending score; non-matching entries are
 * dropped.
 */
function rankIndex(index: IndexedPdf[], query: string): Scored[] {
  const q = query.toLowerCase();
  const scored: Scored[] = [];
  for (const pdf of index) {
    const hit = scoreOne(pdf.relPath, q);
    if (hit) scored.push({ pdf, score: hit.score, highlight: hit.positions });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function scoreOne(haystack: string, qLower: string): { score: number; positions: number[] } | null {
  const hLower = haystack.toLowerCase();
  const positions: number[] = [];
  let hIdx = 0;
  for (let qIdx = 0; qIdx < qLower.length; qIdx++) {
    const ch = qLower[qIdx];
    const found = hLower.indexOf(ch, hIdx);
    if (found === -1) return null;
    positions.push(found);
    hIdx = found + 1;
  }
  // Score the subsequence we found.
  const baseStart = haystack.lastIndexOf('/') + 1;
  let score = 0;
  let prev = -2;
  for (const p of positions) {
    if (p >= baseStart) score += 2;            // basename match worth more
    if (p === prev + 1) score += 3;            // run bonus
    const prevCh = p === 0 ? '/' : haystack[p - 1];
    if (/[\/\-_. ]/.test(prevCh)) score += 2;  // word-boundary bonus
    if (haystack[p] === qLower[positions.indexOf(p)]) {
      // (cheap case-match bonus; positions.indexOf is O(n) but n is tiny)
      score += 1;
    }
    prev = p;
  }
  // Penalty for a long matching span — same letters spread across the path
  // shouldn't beat a tight prefix match in the basename.
  const span = positions[positions.length - 1] - positions[0];
  score -= Math.floor(span / 4);
  // Penalty for matches deep in the path so a top-level hit wins ties.
  score -= Math.floor(positions[0] / 8);
  return { score, positions };
}
