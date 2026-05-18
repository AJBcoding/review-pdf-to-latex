---
date: 2026-05-18
author: review_pdf_to_latex/crew/anthony
session: kraken/6610c838-f1b6-4e4c-9c5d-fb0437ea4dcd
mode: research-only (no engine code touched)
---

# UX research + bug-screenshot handoff

**To:** Next Claude Code agent started in this repo.
**Status:** Research artifacts staged in `docs/research/`. Nothing committed. Engine + viewer code untouched.

This session was triggered by an empty hook (`gt hook`) and AJB's question "look at our original research and see if you can get screenshots of the UX layouts for each of [the 3 ready bugs] for research." It expanded into three deliverables, all sitting in `docs/research/` as new directories.

## What was delivered

### 1. Live viewer screenshots for the three ready bugs

**Path:** `docs/research/2026-05-17-ready-bugs-ux/`

Live Playwright captures against `~/gt/python419/crew/anthony/reports/cota-impact/` (the python419 verification project, 40 annotations, 31 pending + 9 surfaced_pending, order=surface-first, current_annotation_id=null).

- **rev-3pm (P0 silent no-op).** Before/after captures of a Skip click. The single visible difference: status indicator flips **Ready.** → **Waiting for engine…** but `state.json` and counts don't change. `state-events.jsonl` records the events; no consumer dispatches them. This is the canonical photographic evidence for the bug.
- **rev-cav (P2 surface-first ignored at entry).** Single capture showing header simultaneously reading `Order: surface-first` and `ann-001 · Status: pending`. The 9 surfaced_pending annotations exist; viewer just doesn't enter at one.
- **rev-2mq (P3 extract count mismatch).** CLI bug, not a viewer bug — captured `review-pdf status` stdout to `screenshots/rev-2mq-status-output.txt`. Could not reproduce end-to-end because the COTA RESTORED source PDF wasn't locatable on disk; folder README flags this.

The folder's `README.md` ties each capture to its bd issue and quotes the load-bearing evidence inline.

### 2. Recovered the existing-tools survey (lost research)

**Path:** `docs/research/2026-05-16-existing-tools-survey/`

AJB asked where the pre-project "market survey" referenced by `2026-05-16-superdoc-fit-analysis.md` was. It wasn't in the repo — it was in Claude episodic memory.

**Where it was found:** subagent transcripts of session `3013a85f` in the Python419 project at `~/.claude-accounts/anthony/.claude/projects/-Users-anthonybyrnes-PycharmProjects-Python419/3013a85f-…/subagents/`. The session ran 2026-05-16 18:35–19:32 PDT (the hour directly before the brainstorm session that created this repo). AJB had prompted: *"deploy 4 sub agents to search github and the web… RUN THIS PROMPT THROUGH A 4-pass Ralph loop in sub agents before we execute the search."*

**What was recovered** (1581 lines total across 11 files):

- `README.md` — provenance, process, headline findings
- `00-orchestration-parent-session.md` — assistant narration from the parent session over the 18-min orchestration window
- `ralph-pass-{1,2,3,4}-*.md` — each containing the orchestrator prompt fed into that pass **and** the verbatim subagent response. The 4 passes evolve the search brief from one-line ask → 5 launch-ready agent prompts.
- `agent-{A,B,C,D}-*.md` — the four parallel search reports (turnkey SaaS; AI PDF + legal redline; OSS substrates; non-English + adjacent UX).
- `synthesis-merged-report.md` — Top-10 + readiness groups + cross-agent themes + gap callouts.

**Headline that informed the project's existence:** "Inline AI-diff on PDF does not exist in the wild as of 2026-05." Every PDF-native AI tool collapses to rag-chat. Revise (revise.io) is the only turnkey product with first-class PDF ingest. That's the gap `review-pdf-to-latex` was conceived to fill.

### 3. UX screenshots of all 18 survey candidates

**Path:** `docs/research/2026-05-16-existing-tools-survey/screenshots/` (18 files) + `ux-images/` (77 files) + `SCREENSHOTS.md` index. ~130 MB total.

Two layers of imagery captured with Playwright (Chromium, 1440×900):

- `screenshots/` — one full-page capture per tool, of the canonical landing/docs URL. Mostly marketing chrome.
- `ux-images/` — vendor-embedded product imagery extracted from docs/blog/example pages, plus alt-URL captures targeting live editors and GitHub READMEs. `_manifest.md` lists every harvested file with source URL and alt text.

`SCREENSHOTS.md` picks one **best UX shot per tool** and notes which tools yielded real product UI vs. login-gated marketing.

**Tier breakdown (honest):**
- *Real product UX captured:* Sudowrite, Wordtune, Spellbook, Type.ai, Coda AI, SuperDoc, Plate (playground), BlockNote (editor), Word AI Redliner (GIF demo), Recogito (GIF demo).
- *Marketing chrome only:* WPS AI (Chinese-first), Affine, Harvey (mostly logo collages), Trinka (YouTube thumbnails).
- *Login-gated, no public UX:* Revise, Tiptap AI Suggestion.
- *Repo metadata only:* prosemirror-changeset, Nougat.

`SCREENSHOTS.md` also has a "patterns worth noting for our design" section pulled from scanning the harvested imagery — per-suggestion card with status badge, side panel as AI conversation surface, inline tracked-changes with colored strikethroughs, etc. Useful input when picking the Electron layout (L1/L2/L3) from `2026-05-17-electron-pivot-handoff.md` §4.

## What was NOT touched

- No engine, viewer, server, CLI, or SKILL.md code changes.
- No bd issues opened, closed, or updated.
- No git commits, no push.
- Modified files outside research/ (`.beads/issues.jsonl`, `docs/specs/2026-05-16-review-pdf-to-latex-design.md`) were not touched this session — they were already dirty when the session began.

## State at handoff time

```
?? docs/research/2026-05-16-existing-tools-survey/    (11 .md + 95 images, ~130MB)
?? docs/research/2026-05-17-ready-bugs-ux/            (1 .md + 7 PNGs + 1 .txt)
```

Pre-existing dirty files (untouched this session):
- `M .beads/issues.jsonl` (from prior session)
- `M docs/specs/2026-05-16-review-pdf-to-latex-design.md` (per Electron pivot handoff §6, needs rewrite — not done)
- Several `??` handoff files from May 17

## Open questions for the next session

1. **Commit the research?** It's ~130MB, dominated by ux-images. Options: (a) commit all of it; (b) commit the .md analysis + the smaller `screenshots/` set, gitignore `ux-images/`; (c) commit nothing and treat as local artifact. Recommend (b) — the analytical work is durable, the marketing screenshots aren't worth the repo weight.
2. **Apply pattern insights to layout pick?** The Electron pivot handoff §4 asks the next session to pick L1/L2/L3 (or sketch L4) before writing Electron code. `SCREENSHOTS.md`'s "patterns worth noting" section is now load-bearing input for that decision.
3. **Re-extract for rev-2mq?** The fresh-extract divergence (39 pending · 1 surfaced_pending vs. summary "8 surfaced_pending") needs a re-extract from the RESTORED COTA PDF to reproduce. The PDF wasn't on disk; AJB would need to provide it, or the bug repro can wait until the next real review run.
4. **rev-3pm path forward.** Per the Electron pivot handoff, rev-3pm, rev-cav, rev-2mq pre-date the pivot decision and will be "re-scoped or closed-as-superseded depending on which Electron path is picked." Don't fix in the sidecar architecture; wait for the pivot direction.

## Resumption steps for the next session

1. Read this handoff in full.
2. Skim `docs/research/2026-05-16-existing-tools-survey/SCREENSHOTS.md` and the "patterns worth noting" section.
3. Read `docs/handoffs/2026-05-17-electron-pivot-handoff.md` (the load-bearing strategic doc — this session did not touch its decisions).
4. Decide on the commit question (#1 above) and act.
5. Continue with whatever AJB hooks next.

## File index

```
docs/research/2026-05-17-ready-bugs-ux/
├── README.md
└── screenshots/
    ├── rev-3pm-1-before-click.png        ← Status: Ready
    ├── rev-3pm-2-after-skip-click.png    ← Status: Waiting for engine… (silent no-op)
    ├── rev-3pm-3-after-next-click.png
    ├── rev-3pm-4-topbar-waiting.png
    ├── rev-3pm-5-buttons-area.png
    ├── rev-cav-1-initial-surface-first.png  ← Order: surface-first but ann-001 (pending)
    ├── rev-cav-2-topbar-zoom.png
    └── rev-2mq-status-output.txt            ← CLI stdout, not a viewer bug

docs/research/2026-05-16-existing-tools-survey/
├── README.md
├── SCREENSHOTS.md                          ← UX comparison index
├── 00-orchestration-parent-session.md      ← parent-session orchestration narrative
├── ralph-pass-1-initial-brief.md           ← search brief V1
├── ralph-pass-2-critique.md                ← search brief V2 (F1/F2 framing introduced)
├── ralph-pass-3-critique-v2.md             ← search brief V3
├── ralph-pass-4-launch-prompts.md          ← 5 launch-ready prompts
├── agent-A-turnkey-saas-editors.md         ← Sudowrite, Wordtune, Coda, Type.ai, Lex.page, Revise
├── agent-B-ai-pdf-and-legal-redline.md     ← Harvey, Spellbook, Trinka, Ivo, Humata, Adobe AI
├── agent-C-oss-substrate-frameworks.md     ← Plate, BlockNote, Tiptap, ProseMirror, SuperDoc
├── agent-D-non-english-and-adjacent-ux.md  ← WPS AI, Tencent Docs, Lokalise, Crowdin
├── synthesis-merged-report.md              ← Top-10 + readiness groups + themes
├── screenshots/                            ← 18 full-page captures (~70MB)
└── ux-images/                              ← 77 harvested product images + _manifest.md (~60MB)
```
