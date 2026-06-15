// Unit tests for the shared, pure priming module (X8 Stage 2).
//
// Pure module (no electron / node-pty), so every builder and the readiness
// detector is exercised directly with no host. These tests pin the priming
// language that BOTH Claude routes now consume — a drift here is a behavioral
// divergence (C11), so the assertions are deliberately specific.
import { describe, expect, it } from 'vitest';

import {
  PRIMING_SLASH_COMMAND,
  PRIMING_CONV_FALLBACK_MS,
  PRIMING_WORKER_FALLBACK_MS,
  CLAUDE_READY_MARKERS,
  detectClaudeReady,
  buildFreshStartPriming,
  buildDocPrimingLine,
  bundleToPrimingText,
  buildCreateContextPriming,
  buildSlingPriming,
} from './priming.js';
import type { ToolbarContextBundle, WorkerStartParams } from './pty.js';

// ─── fixtures ──────────────────────────────────────────────────────────────

function makeBundle(over: Partial<ToolbarContextBundle> = {}): ToolbarContextBundle {
  return {
    docPath: '/docs/paper.pdf',
    currentPage: 3,
    pageCount: 10,
    selection: null,
    sectionHeading: null,
    nearbyComments: [],
    userPrompt: '',
    ...over,
  };
}

function makeWorkerParams(over: Partial<WorkerStartParams> = {}): WorkerStartParams {
  return {
    kind: 'create-context',
    docSourceDir: '/docs',
    bundle: makeBundle(),
    ...over,
  };
}

// ─── constants ───────────────────────────────────────────────────────────

describe('priming constants', () => {
  it('exposes the skill-activation slash-command', () => {
    expect(PRIMING_SLASH_COMMAND).toBe('/review-pdf-to-latex');
  });

  it('keeps the conv fallback longer than the worker fallback', () => {
    expect(PRIMING_CONV_FALLBACK_MS).toBe(1500);
    expect(PRIMING_WORKER_FALLBACK_MS).toBe(500);
    expect(PRIMING_CONV_FALLBACK_MS).toBeGreaterThan(PRIMING_WORKER_FALLBACK_MS);
  });
});

// ─── detectClaudeReady ─────────────────────────────────────────────────────

describe('detectClaudeReady', () => {
  it('is false for empty / startup-banner output (no marker yet)', () => {
    expect(detectClaudeReady('')).toBe(false);
    expect(detectClaudeReady('Welcome to Claude Code\nLoading…')).toBe(false);
  });

  it('fires on the "? for shortcuts" footer hint', () => {
    expect(detectClaudeReady('… some render …\n? for shortcuts')).toBe(true);
  });

  it('does NOT fire on the rounded welcome-box border alone (rev-gkl regression guard)', () => {
    // Claude's startup "Welcome" box uses the same `╰` corner before the prompt
    // is ready — keying on it would race the screen-clear and lose the
    // slash-command from scrollback.
    expect(detectClaudeReady('╭───╮\n│ Welcome to Claude Code │\n╰───╯')).toBe(false);
  });

  it('matches the footer that arrives mid-stream after a screen clear', () => {
    const stream = 'banner\x1b[2J\x1b[H╭──╮\n│ > │\n╰──╯\n? for shortcuts';
    expect(detectClaudeReady(stream)).toBe(true);
  });

  it('every advertised marker actually triggers detection', () => {
    expect(CLAUDE_READY_MARKERS.length).toBeGreaterThan(0);
    for (const marker of CLAUDE_READY_MARKERS) {
      expect(detectClaudeReady(`prefix ${marker} suffix`)).toBe(true);
    }
  });
});

// ─── buildFreshStartPriming ─────────────────────────────────────────────────

describe('buildFreshStartPriming', () => {
  it('returns the clean-session line for empty / whitespace handoff', () => {
    expect(buildFreshStartPriming('')).toBe('[Fresh start — clean session.]');
    expect(buildFreshStartPriming('   \n\t ')).toBe('[Fresh start — clean session.]');
  });

  it('wraps a handoff in the bracketed system line', () => {
    expect(buildFreshStartPriming('pick up from here')).toBe(
      '[Fresh start — handoff from prior session: pick up from here]',
    );
  });

  it('collapses multi-line / repeated whitespace into a single line', () => {
    const out = buildFreshStartPriming('line one\n\n  line   two\tline three');
    expect(out).toBe(
      '[Fresh start — handoff from prior session: line one line two line three]',
    );
    expect(out).not.toContain('\n');
  });
});

// ─── buildDocPrimingLine ────────────────────────────────────────────────────

describe('buildDocPrimingLine', () => {
  it('reviews a PDF with a page count', () => {
    expect(buildDocPrimingLine({ path: '/x/paper.pdf', pages: 3, comments: 2 })).toBe(
      '[Now reviewing: paper.pdf — /x/paper.pdf (3 pages, 2 comments)]',
    );
  });

  it('edits a single-file markdown doc (file, not pages)', () => {
    expect(buildDocPrimingLine({ path: '/x/notes.md', pages: 1, comments: 0 })).toBe(
      '[Now editing: notes.md — /x/notes.md (file, 0 comments)]',
    );
  });

  it('uses pages for multi-page markdown', () => {
    expect(buildDocPrimingLine({ path: '/x/notes.markdown', pages: 4, comments: 1 })).toBe(
      '[Now editing: notes.markdown — /x/notes.markdown (4 pages, 1 comments)]',
    );
  });

  it('handles a basename-only path and a windows separator', () => {
    expect(buildDocPrimingLine({ path: 'bare.pdf', pages: 1, comments: 0 })).toContain(
      'reviewing: bare.pdf',
    );
    expect(buildDocPrimingLine({ path: 'C:\\docs\\a.pdf', pages: 1, comments: 0 })).toContain(
      'reviewing: a.pdf',
    );
  });
});

// ─── bundleToPrimingText ────────────────────────────────────────────────────

describe('bundleToPrimingText', () => {
  it('renders the minimal bundle (no selection, no comments, no prompt)', () => {
    const out = bundleToPrimingText(makeBundle());
    expect(out).toContain('# Context bundle');
    expect(out).toContain('doc: /docs/paper.pdf');
    expect(out).toContain('page: 3 of 10');
    expect(out).toContain('selection: (none — operating on the whole page)');
    expect(out).not.toContain('# User intent');
  });

  it('omits the page line when currentPage is null', () => {
    const out = bundleToPrimingText(makeBundle({ currentPage: null }));
    expect(out).not.toContain('page:');
  });

  it('drops " of N" when pageCount is null', () => {
    const out = bundleToPrimingText(makeBundle({ pageCount: null }));
    expect(out).toContain('page: 3');
    expect(out).not.toContain('of');
  });

  it('includes the section heading when present', () => {
    const out = bundleToPrimingText(makeBundle({ sectionHeading: 'Methods' }));
    expect(out).toContain('section: Methods');
  });

  it('normalizes selection whitespace and truncates past 280 chars', () => {
    const long = 'a '.repeat(300); // 600 chars with spaces
    const out = bundleToPrimingText(
      makeBundle({
        selection: { page: 2, region: { x: 0, y: 0, w: 1, h: 1 }, highlightedText: `  ${long}  ` },
      }),
    );
    const line = out.split('\n').find((l) => l.startsWith('selection (p.2):'))!;
    expect(line).toMatch(/^selection \(p\.2\): ".*…"$/);
    // 277 kept + ellipsis, inside the quotes
    expect(line).toContain('…');
  });

  it('lists nearby comments with level/status and truncates long bodies', () => {
    const out = bundleToPrimingText(
      makeBundle({
        nearbyComments: [
          { id: 'c1', engagementLevel: 'comment', body: 'short note', page: 1, highlightedText: 'h', status: 'open' },
          { id: 'c2', engagementLevel: 'redraft', body: 'x'.repeat(200), page: 2, highlightedText: 'h2', status: 'applied' },
        ],
      }),
    );
    expect(out).toContain('nearby comments:');
    expect(out).toContain('- [comment/open] p.1: short note');
    const c2 = out.split('\n').find((l) => l.includes('[redraft/applied]'))!;
    expect(c2.endsWith('…')).toBe(true);
  });

  it('falls back to highlightedText when a comment body is empty', () => {
    const out = bundleToPrimingText(
      makeBundle({
        nearbyComments: [
          { id: 'c1', engagementLevel: 'surface', body: '', page: 1, highlightedText: 'the quoted text', status: 'open' },
        ],
      }),
    );
    expect(out).toContain('the quoted text');
  });

  it('appends the user-intent section when a prompt is present', () => {
    const out = bundleToPrimingText(makeBundle({ userPrompt: '  tighten the abstract  ' }));
    expect(out).toContain('# User intent');
    expect(out).toContain('tighten the abstract');
  });
});

// ─── buildCreateContextPriming ──────────────────────────────────────────────

describe('buildCreateContextPriming', () => {
  it('defaults to single-shot mode and references the slash-command', () => {
    const out = buildCreateContextPriming(makeWorkerParams());
    expect(out).toContain(`Use the ${PRIMING_SLASH_COMMAND} skill.`);
    expect(out).toContain('[Single-shot mode');
    expect(out).toContain('# Context bundle');
  });

  it('emits the ralph-loop instruction with the iteration count', () => {
    const out = buildCreateContextPriming(
      makeWorkerParams({ mode: { kind: 'ralph-loop', iterations: 5 } }),
    );
    expect(out).toContain('[Ralph loop mode — iterate this prompt 5 times');
    expect(out).toContain('total=5');
    expect(out).not.toContain('[Single-shot mode');
  });
});

// ─── buildSlingPriming ──────────────────────────────────────────────────────

describe('buildSlingPriming', () => {
  it('defaults destination and subject prefix', () => {
    const out = buildSlingPriming(makeWorkerParams({ kind: 'sling' }));
    expect(out).toContain('Forward this context bundle to reviewer/');
    expect(out).toContain('--subject "review-pdf sling"');
    expect(out).toContain('# Context bundle');
  });

  it('honors explicit destination and subject prefix', () => {
    const out = buildSlingPriming(
      makeWorkerParams({ kind: 'sling', destination: 'report-engine/anthony', subjectPrefix: 'urgent' }),
    );
    expect(out).toContain('Forward this context bundle to report-engine/anthony');
    expect(out).toContain('--subject "urgent"');
  });
});
