# Ground-Truth Map — review-pdf-to-latex (verified 2026-06-12)

Step-0 artifact for the planned evidence-based architectural review (methodology:
`2026-06-10-arch-review-methodology-template.md` + `2026-06-12-hard-gate-strategy.md`).
All numbers command-verified 2026-06-12 from main @ c1a52fb (+ d231677 beads init).
Trust but spot-check.

## What this project is

Two-artifact tool, single repo, solo developer (AJBcoding), ~27 days old, 40 commits.
1. **Python engine** (`src/review_pdf_to_latex/`, ~6.5K LOC): `review-pdf` CLI — extracts PDF
   annotations (pdfannots + pdfplumber), fuzzy-maps them to LaTeX line ranges (rapidfuzz),
   applies edits, rebuilds via pdflatex/xelatex, commits via git. Includes a stdlib
   http.server viewer (Jinja2 + vanilla JS + xterm.js over hand-rolled RFC 6455 WebSocket).
   LaTeX-only by design (spec §3.2 explicitly cut DOCX/HTML/MD).
2. **Electron desktop app** (`desktop/`, ~18.9K LOC excl. node_modules/release/out):
   Electron 42 + TypeScript 5.6 (strict) + React 19 (agent pane only; rest vanilla TS).
   Multi-format viewer/commenter: PDF (pdf.js v5.7), Markdown (CodeMirror 6, **editable**),
   HTML + DOCX (read-only iframe previews). Comments → drafts sidecar JSON → submit flow
   bundles a PDF with pdf-lib Highlight annotations and slings to a Gas Town rig via
   `gt mail`. Claude pty pane + newer React agent pane (feature-flagged, both routes live).

The Electron app **supersedes** the engine's HTTP viewer as primary UI (design spec §10),
but the HTTP viewer still ships in the engine — two parallel viewer stacks exist today.

## Per-layer inventory (wc -l, 2026-06-12)

### Python engine — src/review_pdf_to_latex/ (6,486 LOC, 14 files)
| File | LOC | Purpose |
|---|---|---|
| server.py | 1222 | HTTP viewer + WebSocket terminal bridge; only writer of state-events.jsonl |
| extract.py | 972 | pdfannots extraction, pdfplumber bbox fallback, fuzzy map, pdftoppm render |
| apply.py | 838 | edit/revert primitives, status transitions, line-shift recompute |
| cli.py | 832 | argparse, 16 subcommands |
| state.py | 662 | dataclass schemas, atomic writes, status-transition table (schema_version 1) |
| terminal.py | 456 | hand-rolled RFC 6455 framing + pty bridge (no websockets dep) |
| build.py | 399 | pdflatex/xelatex detect+run, per-page MD5 pagination diff |
| commit.py | 354 | git preconditions, structured commit messages, phase advance |
| pdf_health.py | 262 | text-layer readability heuristics |
| preview.py | 251 | snapshot/restore speculative rebuild |
| status.py | 126 | report formatter |
| migrate.py | 90 | schema migration stub (none implemented) |

### Desktop — desktop/ (18,863 LOC excl. node_modules/release/out)
| File | LOC | Purpose |
|---|---|---|
| renderer/index.ts | 2971 | **god-file orchestrator**: viewer dispatch (if/else), comment cards, docState, drafts debounce, submit, toolbar, claude-pane boot |
| renderer/styles.css | 1891 | |
| renderer/claude-pane.ts | 1115 | legacy xterm claude pane |
| shared/types.ts | 1008 | CommentPayload, DraftsFile, EngineResult, IPC types (hand-wired, 40+ channels) |
| main/index.ts | 826 | IPC handler registry (fs/dialog/drafts/appState/results/bundle/submit/pty/agent) |
| renderer/submit.ts | 721 | submit state machine (idle→pending_send→sent_unconfirmed→…) |
| main/claude-pty.ts | 693 | conversational + worker pty lifecycle |
| renderer/pdf-viewer.ts | 506 | pdf.js v5 render + TextLayerBuilder selection (read-only) |
| renderer/toolbar.ts | 479 | Create Context / Sling / Fresh Start |
| renderer/md-viewer.ts | 460 | CodeMirror 6 live-preview **editor** (full CRUD, 500ms save) |
| renderer/tree.ts | 446 | file tree drawer |
| main/submit.ts | 334 | promoteDraft / slingViaGtMail / abandonRound |
| main/results-watcher.ts | 318 | watches .review-state/results-*.json, matches by submit_id |
| main/bundle.ts | 302 | **pdf-lib Highlight annotation writer** (PDF + JSON sidecar) |
| renderer/html-viewer.ts | 209 | sandboxed iframe preview (read-only, CSS-selector anchors) |
| renderer/docx-viewer.ts | 200 | mammoth.convertToHtml → iframe (read-only) |
| + agent-pane/ (React 19 + zustand), preload bridge, engine.ts resolution chain | | |

### Tests
- Python: 20 files, 8,648 LOC; covers 13/14 engine modules (only `__main__.py` untested).
- Desktop: 7 vitest files, clustered on agent-pane/adapter/anchors/IPC/sidecar-migration.
  Viewers, submit flow, bundle writer, comment rendering: **untested**.

## Architecture facts an outsider needs

- Engine is the **sole writer** of `.review-state/` (annotations.json immutable;
  state.json atomic temp+rename; state-events.jsonl append-only via O_APPEND+flock).
- Desktop app has a **separate, parallel comment model**: drafts sidecar at
  `.review-state/drafts/<basename>.json` (path-keyed, fingerprint rename-recovery),
  NOT the engine's state.json. The two annotation models are not unified.
- Anchor polymorphism: `anchor_kind ∈ {pdf-glyph-rect, md-fuzzy-snippet}`; HTML/DOCX
  reuse `md-fuzzy-snippet` with CSS-selector anchors (shared/types.ts:168-170).
- Engine invocation from desktop: 4-step resolution chain (env → PATH → .venv → ~/.venvs)
  in main/engine.ts; discriminated EngineResult union.
- Viewer dispatch is if/else on `classifyPath()` in renderer/index.ts:769-779 — no registry.
- IPC: ~40 hand-wired channels through one preload contextBridge; compile-time typed,
  no runtime validation.

## Format capability matrix (the feature-gap core, verified)

| Capability | PDF | MD | DOCX | HTML |
|---|---|---|---|---|
| View | ✓ pdf.js v5 | ✓ CM6 live-preview | ✓ mammoth→iframe | ✓ iframe |
| Edit content | ✗ | **✓** (only editable format) | ✗ | ✗ |
| Select→comment in-app | ✓ | ✓ | wired, no comment UI | wired, no comment UI |
| Read external comments (Acrobat/Word) | engine only (pdfannots → state.json; **desktop viewer does NOT display PDF annots**) | n/a (sidecar only) | ✗ (comments.xml never read) | ✗ |
| Write comments to native format | ✓ Highlight only (pdf-lib, bundle.ts; StrikeOut/Text deferred) | ✗ (sidecar JSON only) | ✗ | n/a (no native format) |
| Round-trip with Acrobat/Word | partial: out=Highlight+/Contents; in=engine-extract only, no reply chains | n/a | **none** | n/a |

Prior art on file:
- `docs/research/2026-05-21-pdf-lib-annotation-spike/` — verified pdf-lib can write
  Highlight/StrikeOut/Text; read-back path documented.
- `docs/research/2026-05-16-superdoc-fit-analysis.md` — **SuperDoc rejected** for DOCX.
- `docs/handoffs/2026-05-23-md-epic-shaping-handoff.md` — md→html→docx priority order;
  open beads epics rev-2h6 (.html) and rev-6k6 (.docx) exist.

## Engineering hygiene that ALREADY exists (assess, don't "discover")

- 8.6K LOC pytest suite (markers for slow); vitest + `npm run typecheck` (tsc strict ×3 configs).
- TypeScript strict mode incl. noUnusedLocals/noUnusedParameters.
- Atomic-write discipline everywhere (temp+rename); flush handshake on quit; rename recovery.
- beads (bd) issue tracking with epics; 27 handoff docs; dated specs and research docs.
- **Absent** (known, not findings-per-se): no CI workflows, no ruff/eslint/mypy, no
  pre-commit hooks, loose dep pinning (>= / ^), no lockfile referenced for Python
  (uv.lock exists at root), zero coverage on desktop viewers/submit/bundle.

## Domain traps (agents must not get these wrong)

1. `state.json` at REPO ROOT is Gas Town rig metadata — NOT the engine's
   `.review-state/state.json`. Do not conflate.
2. Two viewer stacks is by design-history (HTTP viewer superseded but retained for
   headless use) — assess whether to keep, don't "discover" it as accidental duplication.
3. `desktop/node_modules`, `desktop/release`, `desktop/out` must be excluded from any
   sweep — release/ contains a full packaged .app with vendored sources.
4. The engine is LaTeX-only **by spec decision** (§3.2), not by accident.
5. Comments in desktop live in drafts sidecars keyed by PATH (md) or basename —
   sha256→path migration already happened (sidecar-migration.ts); don't propose re-adding
   sha256 keying without reading that history.
6. agent-pane (React) vs claude-pane (xterm) are BOTH live behind a localStorage flag —
   neither is dead code.
7. `_reviewer_rig_guard()` in cli.py checks $GT_RIG (Gas Town integration) — looks dead
   in isolation but is rig plumbing.
8. pdfannots quad points can be misaligned on RESTORED PDFs — extract.py has a deliberate
   pdfplumber bbox-crop fallback (extract.py:113-156); it's a feature, not duplication.

## Known suspicions worth steering lanes toward

- renderer/index.ts (2971) decomposition: viewer dispatch / comment cards / submit
  integration / results handling are separable.
- Exception-class duplication: apply.py:39 vs preview.py:158 define separate
  AnnotationNotFoundError; JSON-read pattern triplicated (apply/server/state).
- server.py `_serve_frame()` (111 LOC) mixes Jinja context build with navigation logic.
- extract.py `fuzzy_map()` (~140 LOC, triple-nested loop) — perf + decomposition candidate.
- Desktop viewer Options interfaces and selection payloads vary per viewer — a unification
  opportunity ahead of DOCX/HTML comment work.
- No runtime IPC validation; channel-name drift only caught by grep discipline.
- Unused richness: engine can extract sticky notes + replies context that desktop never
  displays; pdf-lib spike proved StrikeOut/Text writable but unshipped.
