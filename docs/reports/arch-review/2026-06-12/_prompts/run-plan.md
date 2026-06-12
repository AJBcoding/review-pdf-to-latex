# Run Plan — pass ladder & lane partitions (MECE)

6 passes, ~22 agents in Phase A. Serial passes; parallel lanes within a pass; exactly one
synthesizer closes each fan-out pass. Phase B (proposals/roadmap) is behind GATE 1;
Phase C (implementation) behind GATE 2.

## REVIEW.md skeleton (Pass 1 creates these EXACT `##` headings)

    ## Executive Summary
    ## Engine — Core Pipeline (extract / apply / state / commit)
    ## Engine — Server, Build & Terminal
    ## Engine — CLI, Tests & Cross-Cutting
    ## Desktop Main — Process, IPC & Engine Bridge
    ## Desktop Main — Claude/Agent Subsystem
    ## Desktop Main — Persistence & Submit Pipeline
    ## Renderer — Orchestration & Chrome
    ## Renderer — Viewers & Anchoring
    ## Renderer — Comments, Submit UX & Panes
    ## Capability — Multi-Format Comment Round-Trip (special question)
    ## Roadmap

Each body starts as a one-line "_filled by Pass N_" placeholder (`## Roadmap` reads
"_Phase B — requires GATE 1 open_" and Pass 6 leaves it untouched).

## PASS 1 — Inventory & plan (single agent)

Spot-check 5–6 ground-truth-map numbers with real commands. Create REVIEW.md with the
skeleton above. Produce a ranked hotspot list (15–20 items). Validate the lane partitions
below as MECE against the real tree (adjust globs if reality disagrees, record final
assignment rules as literal lane ids + path lists in the PROGRESS block). NO deep findings.

## PASS 2 — Python engine (3 lanes + synthesizer)

- 2A core pipeline: src/review_pdf_to_latex/{extract,apply,state,commit,migrate,status}.py
  → fills "Engine — Core Pipeline"
- 2B serve/build surface: src/review_pdf_to_latex/{server,terminal,build,preview,pdf_health}.py
  + src/review_pdf_to_latex/templates/ → fills "Engine — Server, Build & Terminal"
- 2C cli + cross-cutting: cli.py, __main__.py, pyproject.toml, tests/ (coverage map, not
  test-by-test), error-handling consistency, deps, dead code across the engine
  → fills "Engine — CLI, Tests & Cross-Cutting"

Hunt list for all domain lanes (every pass): god-file decomposition, duplicated logic,
inconsistent access styles, per-operation cost (subprocess/IO churn), error & transaction
consistency. Plus: which pieces are reusable for the multi-format capability direction.

## PASS 3 — Desktop main + shared (3 lanes + synthesizer)

- 3A process/IPC backbone: desktop/main/index.ts, main/engine.ts, preload/,
  shared/types.ts (IPC surface + type org) → fills "Desktop Main — Process, IPC & Engine Bridge"
- 3B claude/agent subsystem: main/claude-pty.ts, main/claude-backend.ts,
  main/agent-pane-ipc.ts, main/session-store.ts, shared/agent-pane/
  → fills "Desktop Main — Claude/Agent Subsystem"
- 3C persistence & submit pipeline: main/{submit,bundle,results-watcher,sidecar-migration}.ts
  + the drafts/appState handler bodies in main/index.ts
  → fills "Desktop Main — Persistence & Submit Pipeline"
  Overlap rule: 3A owns IPC registration/shape in main/index.ts; 3C owns the persistence
  handlers' business logic.

## PASS 4 — Desktop renderer (3 lanes + synthesizer)

- 4A orchestration & chrome: renderer/index.ts (structure, dispatch, state), tree.ts,
  toolbar.ts, palette.ts, splitter.ts, styles.css (organization only)
  → fills "Renderer — Orchestration & Chrome"
- 4B viewers & anchoring: renderer/{pdf,md,html,docx}-viewer.ts, shared/file-viewer.ts,
  shared/md/anchors.ts → fills "Renderer — Viewers & Anchoring"
- 4C comments, submit UX & panes: renderer/submit.ts, the comment-card logic inside
  index.ts, claude-pane.ts, renderer/agent-pane/
  → fills "Renderer — Comments, Submit UX & Panes"
  Overlap rule: 4A owns index.ts structure; 4C owns its comment/submit logic spans.

## PASS 5 — Special question: multi-format comment round-trip (2 lanes + synthesizer)

- 5A options & recommendation: evaluate concrete paths for (i) completing the PDF
  annotation round-trip in the desktop viewer — pdf.js annotation layer vs pdf-lib
  read-back vs reusing engine extraction; (ii) DOCX comments.xml read/write — jszip+OOXML
  by hand vs existing JS/Python docx libraries vs re-litigating the SuperDoc rejection
  (docs/research/2026-05-16-superdoc-fit-analysis.md) against the NEW requirement
  (comments only, body read-only); (iii) the unified comment-model shape. Recommend with
  trade-offs. Evidence = real library APIs (check package docs/node_modules is NOT
  allowed — cite official docs via web or the prior spike docs) + cited current-code seams.
- 5B assets & starter spec draft: inventory what's reusable (engine extraction, bundle.ts
  writer, anchor polymorphism, drafts sidecar, results pipeline); DRAFT a unified
  annotation-model spec sketch + per-format adapter table. This draft is EVIDENCE for
  Phase B, not a proposal — label it "DRAFT — input to Phase B".
  → together fill "Capability — Multi-Format Comment Round-Trip"

## PASS 6 — Synthesis, verification & exec summary (1 synthesizer + ~12 parallel verifiers)

1. De-duplicate and reconcile across all sections.
2. Select top ~12 highest-impact claims — bias toward claims that would drive the Phase-B
   roadmap and toward suspicious-looking citations. Number C1..Cn.
3. One read-only VERIFIER per claim, in parallel: charter + ONE claim verbatim; re-open
   the cited line / re-run the command; RETURN (do not write files):
   `<id> — CONFIRMED | WRONG | UNVERIFIABLE — <1-line what the cited line actually showed>`
4. Synthesizer fixes/deletes WRONG, down-ranks UNVERIFIABLE "(unverified)", marks
   CONFIRMED ✓; writes verification results to evidence/pass6/verification.md itself.
5. Write the 1-page Executive Summary. Leave `## Roadmap` placeholder untouched.
6. Append the GATE 1 Review Packet to REVIEW.md (PRODUCED / UNCERTAIN / CHECK BEFORE
   OPENING / RECOMMENDED DECISION / TO OPEN with the literal GATES.md replacement line).

## PHASE B — proposals & roadmap (requires GATE 1 OPEN; run only when human opens it)

Single pass, small fan-out: turn verified findings + the 5B draft into (a) the phased
`## Roadmap` (Now/Next/Later, S/M/L, each item naming the finding(s) it resolves) and
(b) a real capability spec doc (docs/specs/) for the unified comment model + per-format
round-trip. Ends with the GATE 2 Review Packet.

## PHASE C — implementation (requires GATE 2 OPEN)

File bd epics/issues from the roadmap; implement by milestone. Out of scope for this plan.

## Mechanics

- Drive with a Workflow script: serial await per pass; parallel() for lanes; synthesizer
  after all lanes; one automatic retry per agent; verifiers RETURN lines (no shared file
  writes); synthesizer is the only writer of REVIEW.md/PROGRESS.md.
- Every agent's first action: gate check; second: read charter.md in full (it chains to
  the ground-truth map); third: PROGRESS.md orientation.
- Idempotency: a pass whose sentinel is unset is re-runnable; the missing-lane guard in
  the synthesizer template enforces this. Pass 6's Gate Review Packet doubles as the
  Phase-A completion sentinel.
