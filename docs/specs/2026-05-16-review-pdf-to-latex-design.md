# review-pdf-to-latex — Design Specification

| Field | Value |
|---|---|
| Title | review-pdf-to-latex — Sidecar tool for walking PDF annotations into LaTeX source edits |
| Date | 2026-05-16 |
| Status | Final Draft — Ready for User Review (2026-05-16) |
| Author | Claude (Opus 4.7, 1M context) on behalf of Anthony Byrnes |
| Repo | `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/` |
| Related — brief | [`../handoffs/2026-05-16-brainstorm-complete-handoff.md`](../handoffs/2026-05-16-brainstorm-complete-handoff.md) |
| Related — narrative | [`../sessions/2026-05-16-initial-brainstorm-session.md`](../sessions/2026-05-16-initial-brainstorm-session.md) |
| Related — closed research | [`../research/2026-05-16-superdoc-fit-analysis.md`](../research/2026-05-16-superdoc-fit-analysis.md) |
| Supersedes | — |
| Implementation plan | Pending; to be written via `superpowers:writing-plans` after this spec is approved |

---

## 1. Summary

`review-pdf-to-latex` is a single-user, local-only tool that walks the **author** (the LaTeX project owner) through every annotation on a **commenter**-marked PDF, one annotation at a time, and applies the corresponding edit to the LaTeX source that produced that PDF. The tool ships as two artifacts: a portable Python package (the *engine*) exposing a `review-pdf` CLI plus a thin local HTTP viewer, and a Claude Code skill (the *playbook*) that teaches Claude how to drive the engine through a four-phase workflow (phases 0/1/2/3, with phase 2 split into sub-phases 2a Ratify and 2b Surface). The engine knows nothing about Claude; the skill knows nothing about `pdfannots` or `pdflatex`. They meet at three JSON files on disk and the CLI contract defined in this spec. All mutations of `state.json` flow through engine CLI subcommands; the skill never writes `state.json` directly. The first concrete use case is the COTA Impact Report v2.0 review cycle (80 annotations across ~24 pages of LaTeX-generated PDF), but the engine is designed to accept any LaTeX project root plus any annotated PDF.

## 2. Problem statement

Anthony (the **author**) writes LaTeX reports (templates plus a build file producing a multi-page PDF) and circulates each draft to external **commenters** who mark it up using PDF annotations. A single round produces dozens to hundreds of comments. The current options for processing these comments both fail:

- **Batch-apply then re-read.** Apply every suggested edit in one pass, then re-read 10+ pages cold to verify nothing was lost or distorted. Loses fine-grained oversight; lets errors slip through; the author cannot recall whether a passage *was* changed.
- **Chat-by-chat in a Claude session.** Walk annotations interactively in the terminal, but state lives only in the conversation. Context compaction loses ground covered. Re-launching the session loses the running tally of what is approved, what is deferred, and which mechanical proposals have already been pre-drafted.

Most annotations are *mechanical*: the commenter's note is a clear directive (tighten, clarify, fix a number) and the LaTeX edit follows directly. A subset — currently estimated at ~10 of 80 for the COTA report — are flagged for *surface* discussion (the trigger phrase `Claude surface this`, see §19 Glossary): they require a focused conversation about structure, framing, or substance before any edit is drafted.

Pagination matters. A change that lengthens or shortens a paragraph can shift page breaks downstream. The author must see how each edit reflows the rendered document before approving.

This workflow recurs every revision cycle and is not specific to COTA. See handoff §1 for the originating description.

## 3. Goals and non-goals

### 3.1 Goals

- Walk PDF annotations one-by-one (author-driven) with the corresponding LaTeX source visible alongside the annotated PDF page.
- Provide a live rebuilt-PDF preview that updates after every approval, rejection, or redraft.
- Surface pagination drift explicitly (page-count deltas; per-page checksum diff; location of the first shifted page break).
- Persist state on disk so a review session can pause, resume across context compactions, and survive a terminal restart.
- Produce a clean git audit trail of the review.
- Generalize: the engine accepts any LaTeX project root and any annotated PDF as inputs; nothing about the COTA report is hard-coded.

### 3.2 Non-goals (explicit cuts)

| Cut | Justification |
|---|---|
| Multi-user / collaboration | Single-user local tool. Removing collaboration removes auth, DB, hosting, and most of the original build estimate. |
| In-browser LaTeX editor | Claude does *all* LaTeX editing via the Edit tool. The browser is a read-only display surface with buttons. Avoids a 10k-LOC editor dependency. |
| DOCX / HTML / Markdown source | LaTeX-only for v1. SuperDoc was investigated for DOCX and rejected; see [research note](../research/2026-05-16-superdoc-fit-analysis.md). |
| Anthropic SDK inside the tool | Claude Code IS the AI integration. The engine has no API key handling, no model selection, no prompt templates. A collaborator without Claude Code can still script the CLI manually. |
| Auth, DB, hosted deployment | Files on disk; no daemon beyond the local HTTP viewer process started by `review-pdf serve`. |
| Perfect annotation→LaTeX mapping | Fuzzy text match is good enough for ~85% of cases. A `needs_review` bucket plus a human-override UI handles tables, figure captions, and other low-confidence mappings. |
| UX accommodations for non-Anthony users | Engine is MIT-licensed and CLI-scriptable for portability; no documentation, onboarding, or UI polish is committed to in v1 beyond what Anthony needs. |

## 4. First concrete use case

The tool is designed against the COTA Impact Report v2.0 review cycle. All paths are inputs to the engine, not embedded constants. See handoff §3 for the originating table.

| Item | Path |
|---|---|
| Annotated PDF (input) | `/Users/anthonybyrnes/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf` (205 KB) |
| LaTeX project root | `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/` |
| LaTeX templates | `<root>/templates/*.tex` — 11 files: preamble, front_matter, headline_numbers, enrollment_growth, equity_findings, student_success, what_needs_work, advising_investment, strategic_priorities, closing, appendix |
| Main build file | `<root>/build/full_report.tex` |
| Helper fragment | `<root>/build/fragments/cotastat-defs.tex` |
| Pre-comment PDF (reference only) | `/Users/anthonybyrnes/gt/python419/crew/anthony/2026-05-15 - impact report distribution/2026-05-15-COTA-Impact-Report-v1.9.pdf` |
| Tool repo | `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/` (this repo) |
| Skill home | `/Users/anthonybyrnes/.claude/skills/review-pdf-to-latex/SKILL.md` |

**Annotation volume.** 80 total. The author's estimate is ~70 mechanical, ~10 SURFACE. The first implementation step is to run `pdfannots` on the source PDF and confirm this distribution.

**Note on environment.** The LaTeX project lives in a Gas Town *polecat* — a working-copy git worktree of a larger academic monorepo (Python419). The polecat path must not be hard-coded; it is supplied to the engine via CLI arguments or per-project config. See §19 Glossary for *polecat*.

## 5. Architecture overview

The tool follows a *sidecar* pattern: a thin local viewer plus stateless CLI commands, driven from outside by Claude Code in the main terminal. The viewer never calls Claude; Claude never embeds a viewer. They communicate through three JSON state files.

```
              ┌────────────────────────────────────────────┐
              │  Anthony (in Claude Code terminal)         │
              │  + browser tab open to localhost:PORT      │
              └─────────────┬──────────────────────┬───────┘
                            │ chat                 │ clicks
                            ▼                      ▼
              ┌─────────────────────────┐   ┌─────────────────────┐
              │  Claude Code            │   │  Local HTTP viewer  │
              │  (main terminal)        │   │  (vanilla HTML+JS)  │
              │                         │   │                     │
              │  Driven by SKILL.md     │   │  Serves frame.html  │
              │  - reads state.json     │   │  + annotation.html  │
              │  - calls review-pdf CLI │   │  + pages/*.png      │
              │    subcommands for ALL  │   │  Writes click       │
              │    state mutations      │   │  events to          │
              │  - drafts text, runs    │   │  state-events.jsonl │
              │    Edit tool indirectly │   │  Polls state.json   │
              │    (via apply/redraft)  │   │  every 500ms        │
              └─────────┬───────────────┘   └─────────┬───────────┘
                        │  CLI                        │  reads/writes
                        ▼                             ▼
              ┌───────────────────────────────────────────────────┐
              │  review-pdf engine (Python package, this repo)    │
              │  ┌─────────────┬──────────────┬────────────────┐  │
              │  │ extract     │ apply        │ build          │  │
              │  │ override-   │ revert       │ paginate-diff  │  │
              │  │  mapping    │ preview      │                │  │
              │  │ wait-event  │ set-status   │ commit-phase   │  │
              │  │ status      │ append-chat  │  (git commit)  │  │
              │  │             │ record-      │                │  │
              │  │             │  proposal    │                │  │
              │  └─────────────┴──────────────┴────────────────┘  │
              │  Sole writer of state.json / mapping.json /        │
              │  build artifacts; sole executor of git commit.     │
              └─────────────────────┬─────────────────────────────┘
                                    ▼
                         ┌────────────────────────────────┐
                         │  .review-state/ (project-local)│
                         │  annotations.json (immutable)  │
                         │  mapping.json     (editable)   │
                         │  state.json       (mutable)    │
                         │  state-events.jsonl            │
                         │  pages/page-N.png              │
                         │  builds/build-NNN.pdf          │
                         └────────────────────────────────┘
```

### 5.1 Layer responsibilities

| Layer | Owns | Does NOT own |
|---|---|---|
| **Engine** (`src/review_pdf_to_latex/`) | PDF annotation extraction; fuzzy mapping; page rendering; `.tex` file mutation with line-shift tracking; `pdflatex` orchestration; pagination diff; **all** writes of `annotations.json` / `mapping.json` / `state.json` / build artifacts; reads of `state-events.jsonl` (via `wait-event`); git commits via `commit-phase` | Anything about Claude; prompt construction; conversation state; deciding *whether* an edit is right |
| **Viewer** (`src/review_pdf_to_latex/templates/` + `server.py`) | Layout (3 panes); rendering the current annotation; appending click events to `state-events.jsonl` (the only file the viewer writes); serving page PNGs and rebuilt-PDF page PNGs; polling `state.json` for read-only display refresh | Editing LaTeX; calling pdflatex; talking to Claude; mutating `state.json` or `mapping.json` |
| **Skill** (`~/.claude/skills/review-pdf-to-latex/SKILL.md`) | Phase sequencing; deciding which annotations are mechanical vs. SURFACE; drafting proposed text (in-conversation); invoking `review-pdf` CLI subcommands to record outcomes; relaying user instructions to the engine | PDF parsing; LaTeX file I/O beyond proposing text into temp files for `apply`; HTTP serving; **direct writes to any JSON state file** (mediated exclusively through CLI subcommands) |
| **Claude Code (the runtime)** | Bash invocations of CLI subcommands; conversation history; reading SKILL.md; the Read tool against state.json (read-only) | Anything engine-specific; the Edit/Write tools against any `.review-state/*.json` file (forbidden) |

**The state mutation rule.** Exactly one process — the `review-pdf` CLI — writes to `state.json`. The skill never invokes the Edit or Write tool on `.review-state/state.json`; if a mutation is needed for which no CLI subcommand exists, the spec adds one (see §8). All CLI writes are *atomic*: the engine writes to `state.json.tmp`, `fsync`s it, then `os.rename`s to `state.json`. Readers must tolerate a transient `FileNotFoundError` during the rename window and retry once.

`mapping.json` is similarly engine-owned in the steady state, but `override-mapping` is the single mutation surface and behaves the same way (atomic write).

`annotations.json` is written once by `extract` and never modified.

`state-events.jsonl` is append-only and written *only* by the viewer (one line per click via `O_APPEND` + a single `write()` syscall, which is atomic up to PIPE_BUF on POSIX for line-sized payloads).

The split exists so a collaborator without Claude Code can still run the engine manually — Phase 1 becomes "I open each `.tex` file and edit it by hand", but Phases 0, 2a, 2b, and 3 work unchanged.

## 6. Repository layout

Target layout (the repo currently contains only `docs/`, `README.md`, and `.gitignore`; the rest is to be created during implementation):

```
PycharmProjects/review-pdf-to-latex/
├── src/review_pdf_to_latex/
│     ├── __init__.py
│     ├── cli.py                  # entry point; routes subcommands
│     ├── extract.py              # PDF annotations + fuzzy mapping + page render
│     ├── server.py               # HTTP server (fork of brainstorm visual-companion)
│     ├── apply.py                # apply/revert .tex edits with line-shift tracking
│     ├── build.py                # pdflatex orchestration + pagination diff
│     ├── state.py                # JSON state read/write with schema validation
│     ├── mapping.py              # fuzzy text matching (rapidfuzz; see §12.1)
│     └── templates/
│           ├── frame.html        # page chrome (CSS, helper JS, polling loop)
│           └── annotation.html   # per-annotation render template (Jinja2)
├── tests/                        # pytest; integration tests against a sample PDF
│     ├── fixtures/sample.pdf
│     ├── fixtures/sample-latex/
│     ├── test_extract.py
│     ├── test_apply.py
│     ├── test_build.py
│     └── test_cli.py
├── pyproject.toml                # deps + [project.scripts] review-pdf = "...:main"
├── README.md
├── LICENSE                       # MIT
└── docs/
    ├── specs/                    # formal design specs (this file)
    ├── handoffs/                 # session-to-session context transfer
    ├── sessions/                 # chronological session records
    └── research/                 # deep-dives, analyses, decisions
```

## 7. Data model

The engine persists state in three JSON files plus an append-only events log. All four live in a project-local `.review-state/` directory at the LaTeX project root. The directory is gitignored. See §13.3 for the rationale on project-local vs. centralized state.

All files carry `schema_version: 1`. **Schema version policy:** the major version is incremented on any breaking change to field semantics or required keys; the engine refuses to read files written with a major version it does not recognize. Backwards-compatible additions do not bump the version. The engine ships a one-shot migration command (`review-pdf migrate-state`) when a breaking change ships.

**Atomic write contract.** All writes to `state.json` and `mapping.json` are performed by the engine using a write-temp-then-rename pattern: write to `<file>.tmp`, `fsync`, then `os.rename` to the final path. Readers (the viewer's poll loop, the skill's `review-pdf status` calls) must tolerate `FileNotFoundError` for one retry attempt during the rename window. The engine is the sole writer of these files; see §5.1.

**On-disk artifacts inventory** (so implementers can find every file the tool touches):
- `.review-state/annotations.json` — immutable; §7.1
- `.review-state/mapping.json` — engine-mutated via `override-mapping` and apply-time line-shift recompute; §7.2
- `.review-state/state.json` — engine-mutated via every status-changing CLI subcommand; §7.3
- `.review-state/state-events.jsonl` — viewer-appended; §7.4
- `.review-state/pages/page-N.png` — source-PDF page renders
- `.review-state/builds/build-NNN.pdf` + `build-NNN.log` + `build-NNN/page-N.png` — per-build artifacts
- `.review-state/serve.lock` — single-instance lock for the viewer
- `.review-state/perf-warning` — sentinel file emitted by the engine when compile median exceeds the §11.3 threshold

### 7.1 `annotations.json` — immutable; written once by `extract`

```json
{
  "schema_version": 1,
  "source_pdf": "/abs/path/to/source.pdf",
  "source_pdf_md5": "ab12cd34…",
  "extracted_at": "2026-05-16T20:30:00Z",
  "extractor": "pdfannots-0.4.1",
  "annotations": [
    {
      "id": "ann-001",
      "page": 4,
      "bbox": [72.0, 510.5, 540.0, 542.5],
      "highlighted_text": "The college experienced a substantial increase…",
      "author": "commenter-name-or-anonymous",
      "comment": "Tighten this — too academic",
      "created": "2026-05-15T14:22:11Z",
      "trigger_match": false
    }
  ]
}
```

Field commentary:

- `id`: monotonic, zero-padded, generated at extract time. Stable across re-extracts iff `source_pdf_md5` is unchanged.
- `bbox`: PDF coordinates of the highlight rectangle, used by the viewer to overlay a CSS box on the page PNG. PDF y-axis is bottom-origin; the viewer flips it.
- `highlighted_text`: the actual selected text the commenter marked. The primary input to fuzzy mapping.
- `comment`: the commenter's note. May contain the SURFACE trigger phrase.
- `trigger_match`: `true` iff `comment` matches the configured SURFACE trigger (default: case-insensitive substring `"claude surface this"`).
- `source_pdf_md5`: lets the engine detect if the source PDF was replaced and refuse to proceed (or prompt for a re-extract).

### 7.2 `mapping.json` — editable; written by `extract`; revisable by human or Claude

```json
{
  "schema_version": 1,
  "mappings": {
    "ann-001": {
      "latex_file": "templates/enrollment_growth.tex",
      "line_range": [47, 52],
      "confidence": 0.92,
      "method": "fuzzy_text",
      "needs_review": false
    },
    "ann-013": {
      "latex_file": null,
      "line_range": null,
      "confidence": 0.0,
      "method": "failed",
      "needs_review": true,
      "candidates": [
        {"file": "templates/equity_findings.tex", "line_range": [22, 28], "score": 0.34},
        {"file": "templates/student_success.tex", "line_range": [88, 91], "score": 0.31}
      ]
    }
  }
}
```

Field commentary:

- `latex_file`: relative to project root.
- `line_range`: inclusive `[start, end]` 1-indexed line numbers in the file *at the time of mapping*. Line numbers are recomputed after each successful Phase 1 apply (see §10.3).
- `confidence`: 0.0–1.0. Threshold `< 0.5` flips `needs_review` to `true` by default.
- `method`: one of `fuzzy_text`, `manual`, `failed`. Manual overrides set this to `manual`.
- `candidates`: only populated when `needs_review: true`; up to 3 best-scoring runner-up locations to seed human review.

When any annotation has `needs_review: true`, the viewer surfaces it in a dedicated "needs human mapping" bucket *before* Phase 1 can begin. Mechanical Phase 1 application is blocked on those mappings being resolved.

### 7.3 `state.json` — mutable; the working session state

```json
{
  "schema_version": 1,
  "phase": "2a-ratify",
  "order": "mechanical-first",
  "current_annotation_id": "ann-014",
  "annotations": {
    "ann-001": {
      "status": "applied",
      "before_text": "The college experienced a substantial increase…",
      "proposed_text": "COTA enrollment grew 12% YoY…",
      "applied_text": "COTA enrollment grew 12% YoY…",
      "applied_at": "2026-05-16T20:45:12Z",
      "last_build_id": "build-007",
      "surface_chat_log": null,
      "failure_log_path": null,
      "failure_edit_text": null
    },
    "ann-013": {
      "status": "surfaced_pending",
      "before_text": null,
      "proposed_text": null,
      "applied_text": null,
      "surface_chat_log": [
        {"role": "user", "text": "…", "ts": "…"},
        {"role": "claude", "text": "…", "ts": "…"}
      ],
      "failure_log_path": null,
      "failure_edit_text": null
    },
    "ann-027": {
      "status": "needs_review",
      "before_text": "Original snippet that broke the build…",
      "proposed_text": "Claude's proposal that failed to compile…",
      "applied_text": null,
      "failure_log_path": ".review-state/builds/build-011.log",
      "failure_edit_text": "Claude's proposal that failed to compile…",
      "surface_chat_log": null
    }
  },
  "builds": [
    {"id": "build-007", "pdf_path": ".review-state/builds/build-007.pdf",
     "page_count": 24, "compiled_at": "…", "log_path": ".review-state/builds/build-007.log",
     "ok": true, "page_md5": ["…", "…", "…"]}
  ]
}
```

Field commentary:

- `before_text`: the pre-Phase-1 contents of `mapping.json.line_range` for this annotation. Captured by `review-pdf apply` *before* mutating the file. Never overwritten after first capture — even across multiple redrafts. `revert` always restores this value, even after intervening redrafts (see §10.3 button table for the exact transitions).
- `proposed_text`: the most recent text Claude (or another driver) proposed via `review-pdf apply`. Overwritten on redraft.
- `applied_text`: the text currently present in the file at this annotation's location. Equals `proposed_text` when status is `applied` or `accepted`. Null when status is `rejected` or pending.
- `failure_log_path`: path to the pdflatex log capturing a build failure for the current proposal; written by `review-pdf set-status --status needs_review --failure-log PATH`. Null otherwise.
- `failure_edit_text`: the proposal text that triggered the build failure, preserved for the user's redraft prompt in Phase 2a.
- `surface_chat_log`: array of `{role, text, ts}` objects appended via `review-pdf append-chat`. Roles are `user` or `claude`. Null until the first chat turn lands.
- `last_build_id`: ID of the most recent `review-pdf build` that contained this annotation in its `applied` state.

Status enum: `pending` | `applied` | `accepted` | `rejected` | `redrafted` | `deferred` | `surfaced_pending` | `surfaced_resolved` | `needs_review`.

Terminal statuses (annotation requires no further action) are: `accepted`, `rejected`, `redrafted`, `deferred`, `surfaced_resolved`. Non-terminal: `pending`, `applied`, `surfaced_pending`, `needs_review`. Phase 3 requires every annotation in a terminal status; a residual `needs_review` blocks Phase 3 (the author must either Redraft into a working edit, Surface for discussion, or Skip → `deferred`).

Phase enum: `0-setup` | `1-batch` | `2a-ratify` | `2b-surface` | `3-final`. Phase transitions are written exclusively by `review-pdf commit-phase` (see §8).

Order enum: `mechanical-first` | `surface-first`.

### 7.4 `state-events.jsonl` — append-only viewer→engine event log

One JSON object per line. Written exclusively by the viewer's click handler. Consumed by the skill via the bash polling idiom in §10.5.

```json
{"ts": "2026-05-16T20:47:11Z", "annotation_id": "ann-001", "action": "approve"}
{"ts": "2026-05-16T20:47:38Z", "annotation_id": "ann-002", "action": "reject"}
{"ts": "2026-05-16T20:48:02Z", "annotation_id": "ann-002", "action": "preview", "speculative_text": "…"}
{"ts": "2026-05-16T20:48:55Z", "annotation_id": "ann-003", "action": "surface"}
```

Action enum (full set): `approve` | `reject` | `redraft` | `preview` | `skip` | `surface` | `override-mapping`. See §10.3 for the button-to-action mapping and the engine-side CLI translation of each action.

The log is an append-only audit record of every user click; `state.json` is the authoritative session state, mutated exclusively by `review-pdf` CLI subcommands triggered by the skill in response to events. The viewer never reads `state-events.jsonl`; the engine reads it for replay diagnostics only (`review-pdf status --replay-events` is reserved for future use).

## 8. CLI surface

Every command is a subcommand of the `review-pdf` entry point. All accept `--project-dir PATH` defaulting to `$PWD`. Stdout is for machine-consumable output (JSON when `--json` is passed); stderr is for human messages. Exit codes are documented per command. The full set below covers every `state.json` mutation the workflow requires; the skill never bypasses these subcommands with direct file writes.

| Command | Args | Behavior | Side effects | Exit codes |
|---|---|---|---|---|
| `review-pdf extract` | `--pdf PATH` (required); `--project-dir PATH`; `--surface-trigger STR` (default `"claude surface this"`); `--force` (overwrite existing) | Runs `pdfannots` on `--pdf`. Renders each PDF page to `.review-state/pages/page-N.png` via `pdftoppm`. Builds initial mapping by fuzzy-matching `highlighted_text` against every `.tex` file under the project root (see §12.1 for the algorithm). Writes `annotations.json`, `mapping.json`, and an initial `state.json` with `phase: "0-setup"`, `current_annotation_id: null`, and one entry per annotation with `status: "pending"` (or `"needs_review"` if its mapping is below threshold). Adds `.review-state/` to `.gitignore` if absent. | Creates `.review-state/`. Writes annotations.json, mapping.json, state.json, pages/. | 0 ok; 2 missing pdf; 3 existing state w/o --force; 4 pdfannots failed |
| `review-pdf serve` | `--project-dir PATH`; `--port N` (default: pick free port); `--order {mechanical-first,surface-first}` (default: mechanical-first); `--mapping-mode` (open viewer in needs_review resolution UI only) | Starts local HTTP viewer. Prints URL to stderr. Reads `state.json` to determine which annotation to display. Appends click events to `state-events.jsonl`. Foreground process; Ctrl-C stops. With `--mapping-mode`, surfaces only §10.6 (manual mapping UI) — used between Phase 0 and Phase 1 to clear the needs_review bucket. | Opens TCP port; appends to state-events.jsonl; takes `.review-state/serve.lock`. | 0 clean shutdown; 5 port unavailable; 6 state missing |
| `review-pdf apply` | `--annotation-id ID` (required); `--new-text-file PATH` (required, path to a file containing the replacement text); `--project-dir PATH`; `[--dry-run]` | Locates the annotation's `latex_file` + `line_range`. If `before_text` is null on the state entry, captures the current line-range contents to `state.json.annotations[id].before_text` (one-time capture; never overwritten). Replaces those lines with the contents of `--new-text-file`. Recomputes line numbers for all subsequent mappings in the same file. Updates `state.json` with `status: applied`, `applied_text`, `proposed_text`, `applied_at`. With `--dry-run`: prints the proposed unified diff to stdout, exits 0, performs no file mutation and no state.json update. | Mutates one `.tex` file; updates mapping.json line offsets; updates state.json. (No-op on `--dry-run`.) | 0 ok; 7 annotation not found; 8 mapping unresolved; 9 file mutation failed; 16 overlapping line range (see §12.4) |
| `review-pdf revert` | `--annotation-id ID`; `--project-dir PATH`; `--status {rejected,needs_review}` (default `rejected`); `[--failure-log PATH]` (only valid with `--status needs_review`) | Restores `before_text` to the file at the previously-applied location, recomputes line numbers, updates `state.json.annotations[id].status` to the supplied value. `--status needs_review` is used by Phase-1 failure recovery (see §9.2); `--status rejected` is used by the Reject button (see §10.3). When `--failure-log` is supplied, also records `failure_log_path` and copies the current `proposed_text` into `failure_edit_text` in one atomic write. | Inverse of apply. | 0 ok; 7 annotation not found; 10 no prior apply to revert |
| `review-pdf preview` | `--annotation-id ID` (required); `--new-text-file PATH` (required); `--project-dir PATH` | Speculative compile: (1) snapshots the current contents of the annotation's `latex_file` to memory; (2) writes the new text into the line range in place; (3) runs `review-pdf build` internally; (4) restores the snapshot from memory; (5) prints the resulting build ID (e.g., `build-012`) to stdout. Does *not* mutate `state.json` for this annotation (other than the implicit `builds[]` append from the internal build). The build PDF persists under `.review-state/builds/` for the viewer to display. | Transient `.tex` mutation reverted before exit; appends to `state.json.builds[]`. | 0 ok; 7 annotation not found; 8 mapping unresolved; 11 speculative build failed; 17 in-place restore failed (engine prints recovery instructions) |
| `review-pdf build` | `--project-dir PATH`; `--main-file PATH` (default: auto-discovered, see §15-Q5 / §14-risk-7); `--engine {pdflatex,xelatex,auto}` (default: auto-detect from `\documentclass`); `--quiet` | Runs the LaTeX engine twice (for cross-references), captures log, copies output PDF to `.review-state/builds/build-NNN.pdf`. Renders new PDF pages to `.review-state/builds/build-NNN/page-N.png`. Computes per-page MD5. Appends an entry to `state.json.builds[]`. Emits pagination diff vs. previous successful build to stdout. Build IDs are zero-padded 3-digit decimal counters (`build-001` through `build-999`); engine widens to 4 digits and emits a warning if a project exceeds 999. | Creates a build directory; updates state.json. | 0 build ok; 11 build failed (writes log path to stderr); 12 main file not found |
| `review-pdf status` | `--project-dir PATH`; `--json` | Reads `state.json` and reports counts per status, current phase, current annotation, most recent build outcome, and any unresolved `needs_review` mappings. | None. | 0 ok; 6 state missing |
| `review-pdf override-mapping` | `--annotation-id ID`; `--file PATH`; `--lines START:END`; `--project-dir PATH` | Manual mapping override for `needs_review` cases. Sets `method: manual`, `confidence: 1.0`, `needs_review: false`. | Mutates mapping.json. | 0 ok; 7 annotation not found; 13 invalid line range |
| `review-pdf set-status` | `--annotation-id ID`; `--status STATUS` (one of the status enum values, §7.3); `--project-dir PATH`; `[--reason TEXT]` | Single subcommand the skill uses to transition an annotation's status in response to viewer button events that do not themselves mutate the `.tex` file (Approve, Skip, Surface, marking `surfaced_resolved`, marking `redrafted` after a successful redraft build). Validates the transition against §10.3's allowed transitions; rejects illegal moves. Writes optional `reason` to the annotation entry. Failure metadata for Phase-1 failures is written by `revert --failure-log` instead. | Updates state.json. | 0 ok; 7 annotation not found; 18 illegal status transition |
| `review-pdf append-chat` | `--annotation-id ID`; `--role {user,claude}`; `--text-file PATH`; `--project-dir PATH` | Appends one entry to `state.json.annotations[id].surface_chat_log`. Used by the skill during Phase 2b to record each turn. | Updates state.json. | 0 ok; 7 annotation not found |
| `review-pdf record-proposal` | `--annotation-id ID`; `--text-file PATH`; `--project-dir PATH` | Records a `proposed_text` value without mutating the `.tex` file. Used by the skill to stage a draft for later `apply` (or for replay). | Updates state.json. | 0 ok; 7 annotation not found |
| `review-pdf commit-phase` | `--phase {1,2a,2b,3}`; `--project-dir PATH`; `[--message-suffix STR]`; `[--granularity {phase,session,batch:N}]` (default `phase`) | Reads state.json, renders the §13.2 commit-message template, runs `git add` on touched files and `git commit`, then advances `state.json.phase` to the next value (`1-batch` → `2a-ratify`, `2a-ratify` → `2b-surface`, `2b-surface` → `3-final`, `3-final` → unchanged). Prints the commit SHA to stdout. The only command that mutates `state.json.phase`. | git commit; updates state.json. | 0 ok; 15 dirty git state (only meaningful for first invocation); 19 commit failed (hook or staging error) |
| `review-pdf wait-event` | `--project-dir PATH`; `--since TIMESTAMP` (ISO8601, optional — if omitted, defaults to the timestamp of the last event already in `state-events.jsonl`, or session start if the file is empty); `--timeout SECS` (default 60) | Blocks until a new line is appended to `state-events.jsonl` with `ts > --since`, or `--timeout` elapses. Prints the new event(s) as JSON to stdout, one per line, then exits. The skill calls this in a foreground bash loop to consume viewer events without polling state.json from Claude's side (see §10.5). Implementation: `inotify`/`kqueue` where available, fall back to 250ms `stat()` poll on file size. | None (reads state-events.jsonl). | 0 event received; 20 timeout; 6 state missing |
| `review-pdf migrate-state` | `--project-dir PATH`; `--from N`; `--to N` | Upgrades state files between schema versions. Reserved for future breaking changes. | Mutates state files. | 0 ok; 14 unsupported migration |

The CLI is a *contract*. The skill depends on these flags and exit codes; tests must enforce them. Output formats may add fields without bumping schema version, but cannot remove or rename fields without a major migration.

## 9. Workflow phases

There are four phases: 0 (Setup), 1 (Batch pre-apply), 2 (Review — split into sub-phases 2a Ratify and 2b Surface, interleaved), 3 (Final commit). Sub-phase order within Phase 2 is controlled by the `--order` flag. See handoff §7 for the originating description.

### 9.1 Phase 0 — Setup

| Aspect | Value |
|---|---|
| Trigger | User runs `review-pdf extract --pdf … --project-dir …` |
| Inputs | Annotated PDF; LaTeX project root |
| Outputs | `.review-state/annotations.json`, `.review-state/mapping.json`, `.review-state/state.json` (initialized with `phase: "0-setup"`, all annotation entries `pending` or `needs_review`), `.review-state/pages/page-N.png` for all pages |
| Driver | CLI (engine); fully automated |
| Success criteria | All annotations extracted; all page PNGs rendered; mapping confidences computed; state.json present with correct initial values |
| Failure modes | `pdfannots` parse error → exit 4; PDF unreadable → exit 2; project dir has no `.tex` files → warning, mapping all `needs_review` |

**Resolving `needs_review` mappings before Phase 1.** If `extract` produced any `needs_review` mappings, the author runs `review-pdf serve --mapping-mode` to launch the viewer's manual-mapping UI (§10.6). The author either confirms one of the candidate locations or types a file/line-range manually; the viewer POSTs to `/override-mapping` and the server invokes `review-pdf override-mapping`. Phase 1 cannot start while any annotation has `needs_review: true` in `mapping.json` (the skill at Phase 1 entry runs `review-pdf status` and aborts if the needs_review bucket is non-empty).

### 9.2 Phase 1 — Batch pre-apply

| Aspect | Value |
|---|---|
| Trigger | Claude, prompted by the skill, after Phase 0 completes and all `needs_review` mappings are resolved |
| Inputs | `annotations.json`, `mapping.json`, project source tree |
| Outputs | All mechanical edits applied to `.tex` files; `state.json.annotations[*].status` set to `applied` or `needs_review`; one successful build at the end |
| Driver | Claude (in the terminal), executing the skill's playbook |
| Success criteria | All mechanical annotations either `applied` or `needs_review`; final build succeeds |
| Failure modes | Per-edit compile failure → revert that edit, mark `needs_review`, continue; whole-batch final build failure → halt, surface log to user |

The skill walks annotations in *reverse line order within each file* so that earlier line numbers stay valid as later lines are edited. For each annotation:

1. Read the LaTeX snippet via `mapping.json` line range.
2. Draft a proposed edit consistent with the commenter's note (Claude in-conversation).
3. Write the proposed edit to a temp file (e.g., `/tmp/review-pdf-proposal-<id>.tex`).
4. Run `review-pdf apply --annotation-id … --new-text-file …` (engine captures `before_text`, mutates the `.tex` file, writes `state.json` with `status: applied`, `proposed_text`, `applied_text`, `applied_at`).
5. Run `review-pdf build`. If exit code 11 → `review-pdf revert --annotation-id … --status needs_review --failure-log <log_path>` (atomically reverts the file, sets status, and records `failure_log_path` plus `failure_edit_text`); continue with the next annotation.
6. On success, the engine has already recorded `applied_text` and `last_build_id`; no further state writes are needed from the skill.

After the loop, the skill runs `review-pdf commit-phase --phase 1` to land the Phase-1 commit and advance `state.json.phase` to `2a-ratify` (or `2b-surface` if `--order surface-first`).

SURFACE-flagged annotations are skipped in Phase 1; they retain `status: pending` until Phase 2b.

**Phase 1 invocation surface.** Resolved: Phase 1 runs inside the Claude Code session (driven by SKILL.md), not as a standalone CLI command. The engine exposes the primitives (`apply`, `build`, `revert`, `set-status`, `commit-phase`) but does not orchestrate the loop. Rationale: the per-edit drafting requires Claude's judgment; running it as `review-pdf pre-apply` would require embedding model calls in the engine, which violates §3.2. A `--dry-run` mode is supported per-edit via `review-pdf apply --dry-run` printing the proposed diff without writing. See §15, Q1.

### 9.3 Phase 2a — Ratify

| Aspect | Value |
|---|---|
| Trigger | User opens the viewer; Phase 1 has completed |
| Inputs | `state.json` with all mechanical edits in `applied` status; rebuilt PDF |
| Outputs | Each mechanical annotation transitioned to `accepted`, `rejected`, `redrafted`, or `deferred` |
| Driver | User clicks buttons in the viewer; the skill reacts to events |
| Success criteria | Every mechanical annotation in a terminal status (not `applied`) |
| Failure modes | Compile fails after a Reject/Redraft → error shown inline; user iterates until green |

Per-annotation event flow (each row maps the viewer's event → the skill's CLI call → the engine's state mutation):

- **Approve** → skill calls `review-pdf set-status --annotation-id ID --status accepted`. No rebuild needed (edit already in place).
- **Reject** → skill calls `review-pdf revert --annotation-id ID --status rejected` (engine reverts the file and sets status); then `review-pdf build` (async) for the new preview.
- **Redraft** → Claude (in the terminal) drafts new text into a temp file, then the skill calls `review-pdf revert --annotation-id ID --status rejected` followed by `review-pdf apply --annotation-id ID --new-text-file …`; engine sets status to `applied`. Once the build succeeds the skill calls `review-pdf set-status --annotation-id ID --status redrafted` to mark the redraft outcome. Async `build`.
- **Preview** → skill calls `review-pdf preview --annotation-id ID --new-text-file …`. Engine does the in-place-apply / build / restore cycle (see §11.1) and prints the speculative build ID; the viewer fetches the resulting PDF. No state change for the annotation.
- **Skip** → skill calls `review-pdf set-status --annotation-id ID --status deferred`. Advance to next annotation.
- **Surface** → skill calls `review-pdf set-status --annotation-id ID --status surfaced_pending`. Terminal context switches to Phase 2b for this annotation.

### 9.4 Phase 2b — Surface

| Aspect | Value |
|---|---|
| Trigger | A `surface` event arrives for an annotation, *or* the order is `surface-first` and Phase 2a has not yet begun |
| Inputs | The annotation's PDF page, highlight, comment, and current LaTeX snippet |
| Outputs | A SURFACE conversation logged to `state.json.annotations[id].surface_chat_log`; an edit applied or the annotation declined |
| Driver | User + Claude in conversation in the Claude Code terminal; viewer is read-only context for this annotation |
| Success criteria | Annotation reaches `surfaced_resolved` (with or without an edit) |
| Failure modes | User decides to defer → status → `deferred`; mid-conversation compile failure → iterate |

The viewer shows the annotation in a "surface mode" panel (visually distinct chrome). All actual back-and-forth happens in the terminal chat. The skill writes each turn to a temp file and calls `review-pdf append-chat --annotation-id ID --role {user,claude} --text-file …`; the engine appends to `state.json.annotations[id].surface_chat_log`. When the SURFACE conversation resolves with an edit, the skill follows the same `apply` / `build` flow as redraft, then calls `review-pdf set-status --annotation-id ID --status surfaced_resolved`. When it resolves with no edit, the skill calls `set-status` directly.

### 9.5 Phase 2 order toggle

Default: `mechanical-first` (2a then 2b). Knock out the easy ratifications first; substantive conversations happen with all mechanical text already in place, giving Claude full context.

Alternative: `surface-first` (2b then 2a). Resolve risky/structural items first so that mechanical edits can be drafted against the post-SURFACE state, avoiding cascade-rework when a SURFACE outcome rewrites a paragraph that also had mechanical comments.

User selects at `serve` start time via `--order` or toggles in the viewer header.

### 9.6 Phase 3 — Final commit

| Aspect | Value |
|---|---|
| Trigger | Every annotation in a terminal status; author invokes "finalize" in viewer or via CLI |
| Inputs | Final project state; full `state.json` |
| Outputs | Final `pdflatex` run via `review-pdf build`; git commit via `review-pdf commit-phase --phase 3` (see §13.2); optional diff PDF |
| Driver | Skill issues the CLI calls in response to the author's terminal confirmation; engine executes the build and the commit |
| Success criteria | Clean build; clean git status post-commit; all approved edits in history; `state.json.phase == "3-final"` |
| Failure modes | Final build failure → halt, surface log; git pre-commit hook failure → halt, surface |

## 10. Viewer UI

### 10.1 Layout

```
┌─ Annotation N of M · Page P · @author: "comment text" ─────────────┐
├──────────┬─────────────────────┬───────────────────────────────────┤
│ Source   │ Source LaTeX        │ Live PDF preview                  │
│ PDF page │ (highlighted lines, │ (current rebuilt state,           │
│ with     │  read-only <pre>)   │  auto-scrolls to page P)          │
│ highlight│                     │                                   │
│ overlay  │ ─────────────       │ ─────────────                     │
│ <img>    │ Proposed edit       │ Pagination check:                 │
│  + CSS   │ (read-only <pre>;   │  "24 → 24 pages, no shift"        │
│  bbox    │  optional diff2html)│  or                               │
│          │                     │  "24 → 25 pages, shift at p.12"   │
│          │ ─────────────       │                                   │
│          │ [Preview] [Approve] │                                   │
│          │ [Reject]  [Redraft] │                                   │
│          │ [Skip]    [Surface] │                                   │
└──────────┴─────────────────────┴───────────────────────────────────┘
```

The viewer is a fork of the brainstorming visual-companion server pattern (handoff §8). HTML files are rendered server-side (Jinja2) and served as static-ish responses; clicks fire a `fetch('/event', {method: 'POST', body: …})` that appends to `state-events.jsonl`.

### 10.2 Interaction model

- The author does not type in the viewer (except in the manual-mapping UI, §10.6). Every interaction is a button click.
- The viewer polls `state.json` every 500ms for status changes. The engine — invoked by the skill via CLI subcommands — is the sole writer; reads tolerate the atomic-rename window per §7.
- The author types in the **Claude Code terminal** for everything else: SURFACE conversations, free-form redraft direction, anything not captured by a button.

### 10.3 Button semantics (precise)

Each row maps the button to: the CLI subcommand(s) the skill invokes, the resulting `state.json` mutation, the effect on the underlying `.tex` file, whether a rebuild is triggered, and the allowed source statuses for the transition.

| Button | CLI invocation(s) | Effect on state.json | Effect on .tex file | Triggers rebuild? | Allowed source → target statuses |
|---|---|---|---|---|---|
| **Approve** | `set-status --status accepted` | status → `accepted` | none (edit already applied in Phase 1) | no | `applied`, `redrafted` → `accepted` |
| **Reject** | `revert --status rejected` then `build` (async) | status → `rejected`; `applied_text` → null; `before_text` preserved | engine restores `before_text` | yes, async | `applied`, `redrafted` → `rejected` |
| **Redraft** | `revert --status rejected` then `apply --new-text-file <draft>` then `build` (async) then `set-status --status redrafted` on build success | `proposed_text` → new draft; `applied_text` → new draft; `before_text` preserved (one-time-capture rule, §7.3); status → `redrafted` | engine reverts to before_text, then writes the new draft | yes, async | `applied`, `rejected`, `redrafted` → `redrafted` |
| **Preview** | `preview --annotation-id ID --new-text-file <draft>` | none (engine appends a build entry to `builds[]` but does not touch the annotation entry) | in-place mutation then immediate restore (engine snapshots the file in memory, writes the draft, runs `build`, restores the snapshot before returning) | yes, synchronous | any → same (no transition) |
| **Skip** | `set-status --status deferred` | status → `deferred` | none | no | `pending`, `applied`, `redrafted`, `rejected`, `needs_review`, `surfaced_pending` → `deferred` |
| **Surface** | `set-status --status surfaced_pending` | status → `surfaced_pending` | none | no | `pending`, `applied`, `deferred`, `needs_review` → `surfaced_pending` |

Note on Preview implementation: in-place-mutate-then-restore is preferred over scratch-copy because it requires no project-tree copy (which would compound polecat path complexity) and gives the viewer the same `.review-state/builds/build-NNN.pdf` artifact stream it already consumes. The engine guarantees restoration via a Python `try/finally`: if the snapshot restore fails (exit code 17), the engine prints recovery instructions naming the snapshot bytes and the affected file.

### 10.4 Dependencies (front-end)

- Vanilla HTML5 + ES6, no framework.
- Optional CDN-loaded `diff2html` for the proposed-edit diff display. Falls back to side-by-side `<pre>` blocks if the CDN is unavailable.
- PDF pages displayed as `<img src="pages/page-N.png">`. Highlight overlay is a CSS-positioned `<div>` computed from `bbox`.
- No build step; HTML is served directly.

### 10.5 Click→engine path

```
1. Author clicks [Approve] in browser.
2. JS handler: fetch('/event', {method:'POST',
                 body: {annotation_id, action:'approve'}}).
3. server.py: appends one JSONL line to .review-state/state-events.jsonl
   via O_APPEND + single write() (POSIX-atomic for line-sized payloads).
4. The skill, running inside the Claude Code session, has a foreground
   bash loop active that calls
   `review-pdf wait-event --since <last_ts> --timeout 60`.
   The CLI blocks until a new event lands, then prints it and exits 0
   (or exits 20 on timeout, in which case the skill loops).
5. The skill parses the event and invokes the CLI subcommand(s) in §10.3
   for that action (e.g., `review-pdf set-status --status accepted`).
6. The engine atomically rewrites state.json (write tmp → fsync → rename).
7. The viewer's 500ms poll picks up the state change and advances the UI.
```

**Event-polling cadence.** The skill calls `review-pdf wait-event` with a 60-second timeout. On timeout, the skill re-issues the call. Total round-trip from click to state mutation: < 1 second on average (one viewer write + one engine read + one engine write). The viewer's 500ms read poll bounds UI refresh latency.

**Blocking-call lifecycle.** The 60-second timeout is chosen to fit comfortably inside Claude Code's default 2-minute bash subprocess timeout. Specific scenarios:

- *Idle wait.* If no click arrives within 60s, the CLI exits with code 20 (timeout); the skill loops and re-issues the call. The skill carries `--since <last_observed_ts>` forward so no event is missed across loop iterations.
- *Browser closed mid-wait.* The viewer is a separate process; closing the browser tab does not kill `review-pdf serve` or the in-flight `wait-event`. The wait simply continues until the timeout fires. The author re-opens the browser and clicks resume normally. If the server itself dies, `wait-event` continues until timeout because it tails a file, not a socket.
- *Context compaction mid-wait.* If Claude Code compacts the conversation while a `wait-event` bash call is in flight, the subprocess continues independently of the model context. On post-compaction resumption, the skill re-reads `state.json` and reissues `wait-event --since <last_observed_ts>` (read from the most recent in-state event), seamlessly picking up any events the compacted subprocess captured.
- *User abort.* The author can Ctrl-C the bash process via the Claude Code terminal; the skill catches the non-zero exit and pauses event polling until the author resumes the session.

This indirection is intentional: the viewer never knows it is talking to Claude. A scripted CLI driver could substitute for the skill at step 4 — any program that polls `state-events.jsonl` and dispatches the corresponding CLI subcommands works.

### 10.6 Manual mapping UI (`--mapping-mode`)

When `review-pdf serve --mapping-mode` is invoked (between Phase 0 and Phase 1, or any time the author wants to revisit a mapping), the viewer renders a different layout: a list of every annotation with `needs_review: true` in the left pane, the selected annotation's `highlighted_text` + `comment` in the center pane, and a candidate-picker in the right pane.

```
┌─ Mapping mode · 7 annotations need mapping ───────────────────────┐
├──────────────────────┬──────────────────┬──────────────────────────┤
│ ann-013 (p.7)   [▶]  │ Highlighted text │ Candidate 1              │
│ ann-027 (p.11)       │ "The college     │  templates/equity.tex    │
│ ann-031 (p.12)       │  experienced…"   │  lines 22-28  (score .34)│
│ ann-044 (p.14)       │                  │  [preview tex] [Confirm] │
│ ann-058 (p.17)       │ Comment          │                          │
│ ann-066 (p.19)       │ "Tighten this"   │ Candidate 2              │
│ ann-072 (p.21)       │                  │  templates/success.tex   │
│                      │                  │  lines 88-91  (score .31)│
│                      │                  │  [preview tex] [Confirm] │
│                      │                  │                          │
│                      │                  │ Or enter manually:       │
│                      │                  │  File: _________________ │
│                      │                  │  Lines: ____ : ____      │
│                      │                  │  [Confirm] [Skip] [Reject]│
└──────────────────────┴──────────────────┴──────────────────────────┘
```

Click→engine path for mapping mode:

```
1. Author clicks [Confirm] on a candidate (or types a manual file/range
   and clicks [Confirm]).
2. JS handler: fetch('/override-mapping',
                 {method:'POST',
                  body: {annotation_id, file, line_start, line_end}}).
3. server.py invokes `review-pdf override-mapping --annotation-id ID
                       --file PATH --lines START:END` as a subprocess.
4. Engine atomically rewrites mapping.json (and clears the matching
   `needs_review: true` flag).
5. Viewer's 500ms poll picks up the change; the annotation falls off
   the list. When the list is empty, the viewer shows "All mappings
   resolved. You may now run Phase 1."
```

[Skip] in mapping mode leaves the mapping `needs_review: true` (no engine call). [Reject mapping] is a v2 affordance and is omitted from v1: a rejected mapping is just a skipped one until the author returns.

## 11. Compile and pagination strategy

### 11.1 Strategy

Strategy B + per-item Preview button (handoff §9).

- The preview pane shows the **current** compiled state — the last successful build, which reflects every edit currently in `applied` or `accepted` status.
- After every Approve / Reject / Redraft event, the skill triggers `review-pdf build` asynchronously and updates the preview when complete.
- The Preview button does a **speculative** rebuild via `review-pdf preview` (see §8): the engine writes the proposed-but-not-committed text into the target `.tex` file in place, runs `build`, then restores the prior contents from an in-memory snapshot in a `try/finally`. The resulting PDF persists in `.review-state/builds/` for the viewer to display. Used to "look before you leap" for Reject and Redraft.

### 11.2 Pagination detection algorithm

After each successful build, the engine:

1. Counts PDF pages in the new build (`pdfinfo` or equivalent).
2. Computes MD5 of each rendered page PNG.
3. Compares to the previous successful build:
   - **No drift:** same page count and identical page MD5s → indicator "no shift".
   - **Shift, same count:** same page count but one or more page MD5s differ → indicator "content changed on pp. X, Y".
   - **Page count delta:** different page count → indicator "24 → 25 pages, shift starts at p.12" — locate the shift by walking forward through page MD5s until the first mismatch.

The indicator appears under the preview pane (see §10.1).

### 11.3 Compile-time benchmark

The first `review-pdf build` after Phase 0 emits a wall-clock timing to stderr. Expected: 1–3 seconds for the COTA report (small, text-heavy PDF).

**Degradation threshold: 5 seconds.** If the median compile time exceeds 5s across the first 5 builds, the engine writes a warning to `.review-state/perf-warning` and the viewer switches to manual-rebuild mode: instead of auto-rebuilding after each click, a "Rebuild now" button appears in the header and the user triggers builds explicitly. This avoids stacked builds outrunning the user.

## 12. Error handling

### 12.1 Fuzzy mapping

**Algorithm.** For each annotation, the engine:
1. Normalizes `highlighted_text`: collapses runs of whitespace to single spaces, strips leading/trailing whitespace, and removes characters not present in source (typical pdftotext-introduced ligature artifacts: `ﬁ` → `fi`, `ﬂ` → `fl`).
2. For each `.tex` file under the project root, generates a sliding window of consecutive lines whose total character count is at most 2× the length of normalized `highlighted_text`. The window slides by one line at a time. For each window, the engine applies a similar normalization pass that also strips LaTeX command tokens via the regex `\\[a-zA-Z@]+(\{[^}]*\})*` (unicode-aware).
3. Scores each window with `rapidfuzz.fuzz.partial_ratio` against the normalized highlighted_text. Score is divided by 100 to land in `[0.0, 1.0]`.
4. The best-scoring window across all files determines the mapping.

**Thresholds.**

| Best score | Mapping outcome |
|---|---|
| `>= 0.5` | `method: fuzzy_text`, `needs_review: false`, `latex_file` + `line_range` set |
| `0.2 <= score < 0.5` | `method: fuzzy_text`, `needs_review: true`, top 3 windows recorded in `candidates[]` |
| `< 0.2` | `method: failed`, `needs_review: true`, `latex_file: null`, `line_range: null`, `candidates: []` |

Recovery: the viewer surfaces all `needs_review` annotations in the manual-mapping UI (§10.6). The author resolves each via the candidate picker (which calls `review-pdf override-mapping`) or types a file/line-range manually. Phase 1 is blocked until the bucket is empty (the skill runs `review-pdf status` at Phase 1 entry and aborts on any remaining `needs_review` mappings).

Common cause: LaTeX tables, figure captions, and content inside macros that render very differently from source. Manual override is the expected fallback, not a corner case.

### 12.2 Compile failures in Phase 1

Detection: `review-pdf build` exit code 11 after a `review-pdf apply`.

Recovery (skill-driven, all via CLI):
1. `review-pdf revert --annotation-id ID --status needs_review --failure-log <log_path>` (engine atomically reverts the file, sets status, records `failure_log_path`, and copies the prior `proposed_text` into `failure_edit_text`).
2. Continue with the next annotation.

Author-visible behavior in Phase 2a: the annotation appears with a banner "Claude tried this edit and the LaTeX build failed. See log: <path>. Please redraft or skip." The author can Redraft (Claude tries again with hint from the log) or Surface.

### 12.3 Compile failures in Phase 2a/2b (user-induced)

Detection: a `build` triggered by a Reject or Redraft fails.

Recovery: the engine has already mutated state per §10.3 (Reject sets status to `rejected`; Redraft sets status to `redrafted`) and the failing build is recorded in `state.json.builds[]` with `ok: false`. The viewer displays the pdflatex error inline (pane below the preview, showing the log path from the failed build entry). The author resolves by:

- **Reject failure** (the revert itself broke the build, indicating the pre-Phase-1 source was already broken or another concurrent edit conflicts): re-Redraft this annotation with a corrected proposal, or Surface it for conversation.
- **Redraft failure** (the new proposal broke the build): Redraft again with a different proposal, or Reject to fall back to `before_text`.

In both cases, recovery happens through the existing per-annotation button surface — no batch-level rollback is provided in v1. A "Restore last good build" affordance that walks the whole project back to a specific `build-NNN` is out of scope for v1; the per-annotation Revert/Redraft loop is sufficient for the COTA volume.

### 12.4 Edit conflicts (overlapping line ranges)

Detection: at `apply` time the engine scans every other annotation entry in the same `latex_file` whose status is `pending` or `applied` and checks whether its current `line_range` overlaps the target annotation's `line_range`. Overlap is defined as `[a_start, a_end] ∩ [b_start, b_end] ≠ ∅`. The check is intra-file only; cross-file annotations cannot conflict.

Recovery: **flag-and-require-sequential.** The engine refuses to `apply` with exit code 16 ("overlapping line range") and emits the conflicting annotation IDs to stderr. The skill must walk those annotations sequentially in reverse line order; after each successful `apply`, the engine's line-shift tracker updates the subsequent mapping's `line_range` so the next iteration's overlap check passes. The skill can also call `review-pdf override-mapping` to repoint a conflicting annotation to a non-overlapping range. See §15, Q4. Rationale: automatic re-mapping is plausible but risks silently moving an annotation onto wrong text after the prior edit reshapes the paragraph; sequential review with explicit re-mapping keeps the human in the loop.

## 13. Git / audit trail

### 13.1 Clean-state precondition

**The engine refuses to enter Phase 1 if `git status --porcelain` reports any uncommitted changes in the LaTeX project root.** Phase 1 mutates tracked files, and without a clean baseline the audit trail is meaningless. The engine aborts with exit code 15 ("dirty git state") and prints the offending file list to stderr. The user must commit, stash, or `git restore` before resuming.

### 13.2 Commit granularity

**Recommended default: one commit per phase transition with a structured commit message.** Phase 1 ends with a single commit containing all successfully-applied mechanical edits. Phase 2a ends with a single commit reflecting all ratification outcomes (rejections roll back into this commit as reverts, redrafts as fresh changes). Phase 2b ends with a single commit per SURFACE annotation (because each is substantive). Phase 3 emits a final wrap-up commit only if there are residual changes.

Commit message format:

```
review-pdf-to-latex: phase 2a — ratify COTA Impact Report v2.0

Approved: 62
Rejected: 5
Redrafted: 3
Deferred: 0

State snapshot: .review-state/state.json @ <sha>
```

Alternatives considered:
- **One commit per approval batch (every 10 approvals).** Rejected: log noise; the per-batch boundary is arbitrary; per-phase aligns with the workflow's actual checkpoints.
- **One commit per annotation.** Rejected: 80 commits per review cycle is unreadable in `git log`; the individual annotations are already audit-trailed in `state.json`.
- **One commit per session.** Rejected: a session can span Phase 1 + 2a + 2b + 3 and the commit then loses the phase-level granularity that helps the author (or a future reader) skim history.

See §15, Q2. The per-phase default can be overridden via `--commit-granularity {phase, session, batch:N}` on any `review-pdf commit-phase` invocation, but per-phase is the documented default. The commit-rendering template lives in the engine; the skill never invokes `git` directly (preserving the rule that `state.json` and git history are both engine-owned).

### 13.3 State directory location

**Recommended default: project-local `.review-state/` at the LaTeX project root, gitignored.** Discoverability beats portability for the v1 user.

Rationale:
- The author opening the LaTeX project sees the state directory immediately.
- `state.json` paths are project-relative and need no canonicalization.
- Polecat moves (the LaTeX project getting checked out in a different worktree) are rare; a centralized `~/.review-pdf-to-latex/sessions/` solves a problem we do not have.

Alternative considered: centralized `~/.review-pdf-to-latex/sessions/<project-hash>/`. Surviving polecat moves is its main draw, but the project-local approach handles re-extraction trivially (re-run `extract`), and `state.json` is meant to be ephemeral within a single review cycle anyway. See §15, Q6.

The engine adds `.review-state/` to `.gitignore` on first extract if not already present.

## 14. Risks

Expanded from handoff §11.

| # | Risk | Severity | Detection | Mitigation |
|---|---|---|---|---|
| 1 | Fuzzy mapping fails on tables / figure captions | Medium | Confidence < 0.5 during `extract` | `needs_review` bucket; manual-override UI in viewer; CLI command `override-mapping`; Phase 1 blocked until bucket empty |
| 2 | Pre-applied edit breaks LaTeX build | Medium | `build` exit code 11 after `apply` in Phase 1 | Per-edit validation; failing edits reverted; status `needs_review`; pdflatex log preserved; user redrafts in Phase 2a |
| 3 | Edit conflicts (overlapping line ranges in same file) | Low | Mapping-time overlap detection during `apply` | Flag-and-require-sequential walking in reverse line order; engine refuses overlapping concurrent apply |
| 4 | Context compaction during long Claude Code session | Low | Session message count; explicit user warning | All ground-truth state in `state.json`; skill re-reads from disk on every turn; no in-context dependency |
| 5 | Token cost across 80 walking iterations | Medium | Conversation cost metering | Pre-cache mechanical proposals in `state.json` during Phase 1; Phase 2a operates on cached `proposed_text` (cheap reads, no live drafting); SURFACE annotations are the only Phase 2 drafting cost |
| 6 | `pdflatex` compile time exceeds expectations | Low | Median compile time across first 5 builds | Benchmark on first compile; degrade to manual-rebuild mode if > 5s (§11.3) |
| 7 | LaTeX project layout differs from COTA template | Medium | Discovery failure of main file at `build` time | Engine accepts arbitrary `--main-file`; auto-discovery looks for `\documentclass` + `\begin{document}` co-occurrence; falls back to user-supplied flag |
| 8 | Phase 1 modifying tracked files outside a git checkpoint | High | `git status --porcelain` before Phase 1 | Hard precondition: clean git state required; engine aborts with exit 15 (§13.1) |
| 9 | PDF replaced mid-review (annotation IDs become stale) | Medium | `source_pdf_md5` check on every CLI invocation | Engine refuses operations if source PDF MD5 differs from `annotations.json.source_pdf_md5`; user must re-extract |
| 10 | LaTeX engine mismatch (xelatex needed for COTA, pdflatex run instead) | Low | Build output errors | Auto-detect engine from `\documentclass`; `--engine` flag overrides; warning if mismatch detected |
| 11 | Multiple `serve` instances on same project | Low | Lock file at `.review-state/serve.lock` | Engine refuses second `serve` if lock exists; `--force-unlock` for orphaned lock recovery |

## 15. Open questions

The handoff §12 raised six questions. Resolutions and remaining open items:

| # | Question | Disposition | Reasoning |
|---|---|---|---|
| Q1 | Phase 1 invocation surface (Claude session vs. standalone CLI) | **Resolved: inside Claude session.** | Phase 1 requires drafting; drafting requires Claude; the engine has no model integration. CLI primitives (`apply`, `build`, `revert`, `set-status`, `commit-phase`) are exposed for scripting but the loop runs in the session. `--dry-run` on `apply` covers the "see what would happen" case. See §9.2. |
| Q2 | Git commit granularity | **Resolved: one commit per phase transition (default).** Overridable. | Aligns commits with the workflow's natural checkpoints; per-annotation commits are noise; per-session commits lose phase boundaries. See §13.2. |
| Q3 | SURFACE trigger phrase shape (regex vs. substring vs. DSL) | **Resolved: case-insensitive exact substring `"claude surface this"`.** Configurable per project via `--surface-trigger`. | Substring is the simplest behavior that handles the brainstorm's example. A DSL is over-design for v1 with ~10 SURFACE annotations. Regex is over-flexible and invites footguns. |
| Q4 | Re-mapping policy on edit conflicts | **Resolved: flag-and-require-sequential.** | Auto-recomputing risks moving an annotation silently to wrong text after a prior edit reshapes the paragraph. The conservative default keeps the human in the loop; the engine's line-shift tracker handles non-overlapping edits cleanly. See §12.4. |
| Q5 | Build dir layout (single template across projects?) | **Resolved for v1: auto-discover main file via `\documentclass` + `\begin{document}` co-occurrence; `--main-file` overrides.** Reopen if a second LaTeX project breaks the heuristic. | The COTA report uses `build/full_report.tex` → `\input{templates/*.tex}` and the auto-discovery rule finds it cleanly. The engine cannot assume this layout in general; the heuristic is the v1 contract. The CLI `--main-file` flag exists for explicit override. Whether to formalize a convention across projects awaits a real second project. Decision deadline to revisit: when the tool is run on a second project, or 2026-12-31, whichever comes first. |
| Q6 | State directory location (project-local vs. centralized) | **Resolved: project-local `.review-state/`.** | Discoverability for the v1 user; centralized would solve a problem (polecat moves) we do not have. See §13.3. Reopenable if cross-polecat resume becomes a need. |

New open questions surfaced during spec drafting:

| # | Question | Reason for leaving open | Decision deadline |
|---|---|---|---|
| Q7 | Should the viewer poll interval (500ms) be configurable? | No evidence yet that 500ms is wrong; premature flexibility. | Reopen if a user complains about responsiveness vs. CPU. |
| Q8 | Should `state-events.jsonl` rotate? | At 80 events per review cycle, no rotation needed. Long-running multi-cycle reviews would benefit from rotation. | Reopen when a single project accumulates > 10,000 events. |
| Q9 | Should the engine cache `pdftoppm` page renders or always regenerate on `build`? | Spec assumes lazy cache (regenerate if missing or older than PDF); not benchmarked. | Verify during implementation; adjust if cache invalidation logic is non-trivial. |

## 16. Dependencies

Per handoff §14, expanded with Python version target.

### 16.1 Python target

Python 3.13 (current TeX Live and Homebrew environments support it). `pyproject.toml` declares `requires-python = ">=3.11"` for collaborator portability.

### 16.2 Inventory

| Dependency | Status | Notes |
|---|---|---|
| Annotated PDF (COTA v2.0) | Verified | `~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf` (205 KB) |
| `pdftoppm` (Poppler) | Verified | Poppler 26.02 at `/opt/homebrew/bin/pdftoppm` |
| `pdfinfo` (Poppler) | Assumed available | Ships with Poppler; used for page counts |
| `pdflatex` | Verified | TeX Live 2025 at `/Library/TeX/texbin/pdflatex` |
| `xelatex` | Verified | TeX Live 2025; used if `\documentclass` requires it |
| `pdfannots` (PyPI) | To install | `pip install pdfannots` — primary annotation extractor |
| `PyMuPDF` | Not chosen | Alternative to pdfannots; pdfannots wins on simplicity for MVP |
| `latexmk` | Optional | Not required; engine calls `pdflatex` directly |
| `jinja2` (PyPI) | To install | HTML template rendering |
| `rapidfuzz` (PyPI) | To install | Fuzzy text matching (preferred over stdlib `difflib` for performance on 80×N comparisons) |
| `pytest` (dev) | To install | Test runner |

`pyproject.toml` dependency block (preview):

```toml
[build-system]
requires = ["hatchling>=1.21"]
build-backend = "hatchling.build"

[project]
name = "review-pdf-to-latex"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
    "pdfannots>=0.4",
    "jinja2>=3.1",
    "rapidfuzz>=3.0",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[project.scripts]
review-pdf = "review_pdf_to_latex.cli:main"
```

Build backend choice (`hatchling`) is provisional and may be revisited in the implementation plan; `setuptools` is an equally valid fallback.

## 17. Out of scope (v1) — hard boundary

Implementers must reject scope creep into:

- DOCX, HTML, Markdown source formats — LaTeX only.
- In-browser editing of any kind — viewer is read-only display + buttons.
- Multi-user, authentication, real-time collaboration — single-user local files.
- Hosted deployment, daemon-mode, system service — runs as foreground CLI.
- Anthropic SDK or any model API call from the engine — Claude Code is the only AI surface.
- Database — three JSON files plus an events log are the entire persistence layer.
- Automatic re-mapping after edit conflicts — flag-and-require-sequential (see §12.4).
- Batch-level "restore last good build" rollback — recovery is per-annotation only (see §12.3).
- Plugin / extension system — single-purpose tool.
- Web fonts, build steps, framework bundling for the viewer — vanilla HTML/JS/CSS.
- Annotation extraction from non-PDF sources (Word comments, Google Docs suggestions) — PDF only.
- Cross-project state management — each LaTeX project has its own `.review-state/`.

## 18. Acceptance criteria

v1 is considered "done" when all of the following hold against the COTA Impact Report v2.0 review cycle:

### 18.1 Phase 0

- [ ] `review-pdf extract` runs against the COTA PDF in under 10 seconds.
- [ ] All 80 annotations are extracted into `annotations.json` with non-null `highlighted_text` and `comment` fields.
- [ ] Page PNGs render for all pages of the source PDF.
- [ ] `mapping.json` contains a mapping for every annotation; high-confidence mappings (≥ 0.5) outnumber `needs_review` mappings by at least 3:1.

### 18.2 Phase 1

- [ ] After resolving all `needs_review` mappings, Claude (driven by the skill) walks every mechanical annotation.
- [ ] At least 80% of mechanical annotations reach `applied` status without compile failure.
- [ ] Failed edits are individually reverted; the final build at end of Phase 1 succeeds.
- [ ] Final Phase 1 git status is clean except for tracked `.tex` modifications staged for the Phase 1 commit.

### 18.3 Phase 2a

- [ ] The viewer renders the 3-pane layout for each `applied` annotation.
- [ ] Every button (Approve, Reject, Redraft, Preview, Skip, Surface) functions per §10.3.
- [ ] Async rebuild completes and the preview updates within 5s of an Approve/Reject/Redraft event.
- [ ] Pagination indicator correctly identifies "no shift" vs. "shift at p.N" using the algorithm in §11.2.

### 18.4 Phase 2b

- [ ] SURFACE-flagged annotations transition to `surfaced_pending` via the Surface button (verified by `review-pdf status --json` after the click).
- [ ] Chat turns are appended to `surface_chat_log` for each surfaced annotation (verified by reading `state.json.annotations[id].surface_chat_log` length growing on each `review-pdf append-chat` call).
- [ ] At least one SURFACE annotation reaches `surfaced_resolved` with an applied edit during the COTA review — OR, if Phase 0 finds zero SURFACE annotations in the COTA source (no comment matches the trigger phrase), this criterion passes vacuously.

### 18.5 Phase 3

- [ ] Final `review-pdf build` exits 0.
- [ ] Per-phase commits land in the COTA polecat via `review-pdf commit-phase`, with the message format in §13.2 (verified by `git log --oneline -n 4` showing four commits matching the template).
- [ ] `review-pdf status --json` reports zero non-terminal annotation statuses (every annotation in one of `accepted`, `rejected`, `redrafted`, `deferred`, `surfaced_resolved`).
- [ ] `state.json.phase == "3-final"`.

### 18.6 General

- [ ] State persists across a `serve` process restart (kill the server, restart, viewer resumes at the same annotation).
- [ ] State persists across a Claude Code context compaction (skill re-reads `state.json` and continues).
- [ ] All exit codes documented in §8 are reachable by valid inputs in the test suite.
- [ ] Engine refuses to run Phase 1 on a dirty git working tree (§13.1).

## 19. Glossary

Terms are grouped by topic, then ordered alphabetically within each group.

**Roles and people**

- **Author.** The owner of the LaTeX project (Anthony, for the COTA case) who runs `review-pdf` in their terminal and authors the underlying document. The author drives Phase 2 button clicks in the viewer and Phase 1 / 2b conversations in the Claude Code session.
- **Commenter.** An external reviewer of the author's PDF draft who marks it up with annotations. The commenter's notes (highlight + comment) drive the workflow but the commenter is not a tool user.

**Architecture**

- **Engine.** The Python package in this repo. Knows nothing about Claude. Exposed via the `review-pdf` CLI. Sole writer of `state.json`, `mapping.json`, `annotations.json`, and build artifacts; sole executor of `git commit`.
- **Sidecar.** Architectural pattern in which a thin local viewer accompanies a larger driver (Claude Code) rather than embedding the driver inside itself. See handoff §4.
- **Skill.** The Claude Code SKILL.md at `~/.claude/skills/review-pdf-to-latex/SKILL.md`. The playbook that teaches Claude how to drive the engine through the four phases by invoking CLI subcommands.

**Workflow and data**

- **Annotation.** A commenter's mark on a PDF, consisting of a highlight rectangle (`bbox`), the highlighted text, an author (the commenter's name), and a comment.
- **Build ID.** A zero-padded 3-digit monotonic identifier (`build-001` through `build-999`) assigned to every successful `review-pdf build` invocation. Indexes the corresponding PDF and log in `.review-state/builds/`. Widens to 4 digits past 999 with a warning.
- **Mapping.** The association between an annotation and a specific LaTeX file + line range. Stored in `mapping.json`. Initially fuzzy-matched; revisable via `override-mapping`.
- **Mechanical edit.** An annotation whose comment is a clear directive translatable to a LaTeX edit without further conversation (e.g., "tighten this", "fix typo", "use 12% not approximately 12%").
- **`needs_review` bucket.** The set of annotations whose mapping confidence is below threshold (default 0.5) and that must be manually mapped before Phase 1 begins.
- **Pagination drift.** A change in the rendered PDF's page count or in the location of a page break between two successful builds.
- **Ratify.** Phase 2a verb: walking each pre-applied mechanical edit and producing a terminal outcome (accept, reject, redraft, defer, surface).
- **State events.** Append-only JSON-lines log (`state-events.jsonl`) of every user click in the viewer. The skill consumes this stream via `review-pdf wait-event` and dispatches CLI subcommands per §10.3.
- **SURFACE annotation.** An annotation whose comment contains the trigger phrase (default `"claude surface this"`, case-insensitive). Requires a Phase 2b conversation before any edit is drafted.
- **Trigger phrase.** The configurable string (default `"claude surface this"`) that flags an annotation as SURFACE. Matched as case-insensitive substring against the comment text.

**Environment**

- **Polecat.** A working-copy git worktree of a larger repository, used in Anthony's Gas Town workflow. The COTA project lives in a polecat. The engine treats it as just another project root and never assumes worktree-ness.
