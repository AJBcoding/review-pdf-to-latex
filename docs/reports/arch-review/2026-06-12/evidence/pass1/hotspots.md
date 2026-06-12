# Pass 1 — Ranked Hotspot List (18 items)

Ranking weighs: size × centrality × known suspicion (ground-truth map) × relevance to the
owner's decided capability direction (unified cross-format comment model). LOC figures
verified by `wc -l` this session (see spot-checks.md and pass-1 command log); structural
claims trace to docs/research/2026-06-12-ground-truth-map.md unless re-verified.

1. desktop/renderer/index.ts (2971 LOC, wc-verified) — god-file orchestrator: viewer dispatch (if/else on classifyPath, verified at :769-779), comment cards, docState, drafts debounce, submit wiring, claude-pane boot; primary decomposition target and the seam every later pass touches.
2. desktop/shared/types.ts (1008 LOC, wc-verified) — ~40 hand-wired IPC channel types, zero runtime validation; the place a unified comment model must land; AnchorKind discriminator verified at :168-170.
3. src/review_pdf_to_latex/server.py (1222 LOC, wc-verified) — superseded-but-shipping HTTP viewer stack; sole writer of state-events.jsonl; `_serve_frame()` mixes Jinja context build with navigation logic (map suspicion); keep-vs-kill is a top review question.
4. src/review_pdf_to_latex/extract.py (972 LOC, wc-verified) — `fuzzy_map()` ~140-LOC triple-nested loop (perf + decomposition); pdfplumber bbox fallback is deliberate (trap 8); most reusable engine asset for the PDF round-trip capability.
5. desktop/main/bundle.ts (302 LOC, wc-verified) — the only native-format annotation WRITER (pdf-lib Highlight); untested; centerpiece input to the Acrobat round-trip requirement.
6. desktop/renderer/submit.ts (721 LOC, wc-verified) — submit state machine (idle→pending_send→sent_unconfirmed→…), untested, correctness-critical for the daily-driver bar.
7. Two parallel comment models — engine `.review-state/state.json` vs desktop drafts sidecar `.review-state/drafts/` (map: "not unified") — the structural gap the whole capability direction hinges on; spans state.py (662) + sidecar-migration.ts (213) + types.ts.
8. desktop/renderer/claude-pane.ts (1115 LOC, wc-verified) — legacy xterm pane live in parallel with React agent-pane behind a localStorage flag (trap 6); duplication cost vs migration plan needs assessment.
9. src/review_pdf_to_latex/apply.py (838 LOC, wc-verified) — edit/revert primitives + line-shift recompute; duplicate AnnotationNotFoundError vs preview.py:158 (verified, apply.py:38); JSON-read pattern triplicated across apply/server/state (map suspicion).
10. desktop/main/index.ts (826 LOC, wc-verified) — single IPC handler registry mixing fs/dialog/drafts/appState/results/bundle/submit/pty/agent concerns; lane 3A/3C split point.
11. src/review_pdf_to_latex/cli.py (832 LOC, wc-verified) — 16 argparse subcommands in one file; `_reviewer_rig_guard()` looks dead but is Gas Town rig plumbing (trap 7).
12. Desktop viewer family — pdf-viewer.ts (506) / md-viewer.ts (460) / html-viewer.ts (209) / docx-viewer.ts (200), all wc-verified — per-viewer Options interfaces and selection payloads diverge (map suspicion); must converge before DOCX/HTML comment UI; shared/file-viewer.ts is only 21 LOC of shared surface.
13. desktop/main/claude-pty.ts (693 LOC, wc-verified) — conversational + worker pty lifecycle; process-lifecycle risk zone, untested.
14. Desktop test gap — only 7 vitest files (verified), clustered on agent-pane/adapter/anchors/IPC/sidecar-migration; viewers, submit flow, bundle writer, comment rendering all untested while being the correctness-critical surfaces.
15. desktop/main/results-watcher.ts (318 LOC, wc-verified) — fs-watch of results-*.json matched by submit_id; race/missed-event surface in the submit confirmation loop, untested.
16. src/review_pdf_to_latex/state.py (662 LOC, wc-verified) + migrate.py (90 LOC, stub with no migrations) — schema_version 1 with no migration machinery, while a unified comment model will force a schema change on both sides.
17. src/review_pdf_to_latex/terminal.py (456 LOC, wc-verified) — hand-rolled RFC 6455 WebSocket framing + pty bridge; maintenance liability tied to the keep-vs-kill verdict on server.py.
18. desktop/renderer/styles.css (1891 LOC, wc-verified) — single global stylesheet for the whole renderer; organization-only review (lane 4A) but couples every UI change.
