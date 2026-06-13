# NOW Sling Plan — model-specified dispatch of the arch-review NOW beads

Created 2026-06-12. Source: `docs/reports/arch-review/2026-06-12/REVIEW.md` ## Roadmap (NOW),
filed as beads under epic `review-pdf-to-latex-vzn`. GATE 2 opened by Anthony Byrnes 2026-06-12.

This plan dispatches the 8 NOW items + 7 ride-alongs to polecats via `gt sling`, with a
model chosen per bead by judgment weight, and a wave order chosen to keep the
`renderer/index.ts` collision cluster from fighting itself at merge time.

## How model is specified

`gt sling` has no `--model` flag; model rides on the `--agent` alias (each alias is
`claude --model <id> …`). These four aliases cover the plan (opus48 + fable5 created
2026-06-12 this session; sonnet46 + haiku pre-existed):

| `--agent` value   | Model        | Use for |
|-------------------|--------------|---------|
| `claude-opus48`   | Opus 4.8     | state machines, concurrency/lifecycle, scope-setting spikes |
| `claude-sonnet46` | Sonnet 4.6   | contained correctness fixes with a clear done-when + one test |
| `claude-haiku`    | Haiku 4.5    | trivial, localized, low-blast-radius edits |
| `claude-fable5`   | Fable 5      | (held in reserve; not assigned below) |

Default account is `kraken`; spread heavy waves across `anthony` / `axbounds` to dodge the
Max-20x ceiling (`--account <handle>`).

## Model assignment (the "model specifications")

| Bead | Item | Effort | Model | Why this tier |
|------|------|--------|-------|---------------|
| `review-pdf-to-latex-tuh` | N6 un-strand submit unhappy paths | M–L | **Opus 4.8** | submit state-machine extraction + retry re-plumb against the same-`submit_id` contract + compensation; hardest NOW item |
| `review-pdf-to-latex-5x2` | N7 spike: PDF /IRT reply chains (read+write) | S | **Opus 4.8** | both halves unproven; outcome sets L4 scope — judgment + pdf.js/pdf-lib internals, dead-ends likely |
| `review-pdf-to-latex-8dv` | N8 spike: per-line quads write-back | S | **Opus 4.8** | Acrobat round-trip survival incl. degraded PDFs; sets `PdfQuadAnchor.quads[]` semantics |
| `review-pdf-to-latex-bwh` | ra3 errored SDK session zombie + uncapped creation | S | **Opus 4.8** | session lifecycle/queue subtlety — end-queue + clear-approvals + drop-registry, easy to get half-right |
| `review-pdf-to-latex-73t` | ra6 concurrent doc-open race mis-keys sidecars | S–M | **Opus 4.8** | load-epoch guard re-checked after every await; concurrency correctness |
| `review-pdf-to-latex-2e8` | N1 stop deleting MD frontmatter on save | S | Sonnet 4.6 | localized regex + save path; one vitest case |
| `review-pdf-to-latex-8ex` | N2 idempotent draft seeding (+ draftsCache fix) | S | Sonnet 4.6 | data-loss + X5 prereq, but the change is a contained read-before-write guard |
| `review-pdf-to-latex-kjw` | N3 filter `.abandoned.json` at both layers | S | Sonnet 4.6 | regex guard in two spots + test |
| `review-pdf-to-latex-sbb` | N4 hoist status validation above `.tex` mutation | S | Sonnet 4.6 | pure reorder + regression test |
| `review-pdf-to-latex-x5x` | N5 commit-phase vs `.gitignore` exit-19 | S | Sonnet 4.6 | small policy call (stop-staging vs `-f`) + test |
| `review-pdf-to-latex-dt6` | ra1 empty-text revert destroys a line | S | Sonnet 4.6 | guard + apply-empty→revert tests; rides N4's files |
| `review-pdf-to-latex-lpy` | ra5 skip-permissions silently rewritten | S | Sonnet 4.6 | spread previously-read app state so no-UI fields can't clobber |
| `review-pdf-to-latex-skt` | ra7 pre-v2 bundle/submit anchor-kind gate | S | Sonnet 4.6 | closes C5 exposure early; `writeBundle` + `handleSubmitBundle` guard |
| `review-pdf-to-latex-kdr` | ra2 `gt mail` stdin EPIPE crashes main | S | Haiku 4.5 | one stdin error listener into the existing settle path |
| `review-pdf-to-latex-kxt` | ra4 re-created window misses agent events | S | Haiku 4.5 | re-bind `mainWindowRef` on window creation (C13) |

Haiku floor: if ra2/ra4's first MR bounces gates, re-sling on `claude-sonnet46`.

## Wave order (collision-aware)

`renderer/index.ts` (2971 LOC) is touched by **N1, N2, N3, N6, ra5, ra6**. Polecats rebase
onto main before gates, so edits in *different functions* of that file usually rebase clean —
but to avoid a conflict pile-up the index.ts-heavy beads run as a **serialized lane** (sling
the next only after the prior lands in MQ). Everything that touches disjoint files runs fully
parallel.

### Wave 1 — parallel, disjoint files (sling all at once)

```bash
# Engine (Python — cannot collide with the JS lanes)
gt sling review-pdf-to-latex-sbb review_pdf_to_latex --agent claude-sonnet46   # N4 apply/revert validation
gt sling review-pdf-to-latex-x5x review_pdf_to_latex --agent claude-sonnet46   # N5 commit-phase gitignore

# Main-process, disjoint files
gt sling review-pdf-to-latex-bwh review_pdf_to_latex --agent claude-opus48     # ra3 SDK session lifecycle
gt sling review-pdf-to-latex-kxt review_pdf_to_latex --agent claude-haiku      # ra4 window rebind
gt sling review-pdf-to-latex-skt review_pdf_to_latex --agent claude-sonnet46   # ra7 bundle/submit gate

# Spikes — throwaway code, do NOT merge to main (deliverable = the dated research note)
gt sling review-pdf-to-latex-5x2 review_pdf_to_latex --agent claude-opus48 --no-merge   # N7 IRT replies
gt sling review-pdf-to-latex-8dv review_pdf_to_latex --agent claude-opus48 --no-merge   # N8 per-line quads
```

### Wave 1b — renderer/index.ts lane, serialized (one at a time through MQ)

Start the lane in parallel with Wave 1 (it's a separate branch chain); just don't fire the
*next* lane bead until the prior one merges. Order = P1 data-loss first, Opus concurrency last.

```bash
gt sling review-pdf-to-latex-8ex review_pdf_to_latex --agent claude-sonnet46   # N2 draft seeding (X5 prereq) — FIRST
# (after N2 merges)
gt sling review-pdf-to-latex-2e8 review_pdf_to_latex --agent claude-sonnet46   # N1 MD frontmatter
# (after N1 merges)
gt sling review-pdf-to-latex-kjw review_pdf_to_latex --agent claude-sonnet46   # N3 tombstone filter
# (after N3 merges)
gt sling review-pdf-to-latex-73t review_pdf_to_latex --agent claude-opus48     # ra6 doc-open race
# (after ra6 merges)
gt sling review-pdf-to-latex-lpy review_pdf_to_latex --agent claude-sonnet46   # ra5 skip-perms clobber
```

### Wave 2 — submit cluster (after the index.ts lane drains the comments-promoted flip area)

N6 rewrites `submit.ts` + the `submit:comments-promoted` flip in index.ts; ra2 rides its
`gt mail` spawn path. Run after Wave 1b so N6's index.ts touch rebases onto a settled file.

```bash
gt sling review-pdf-to-latex-tuh review_pdf_to_latex --agent claude-opus48     # N6 submit unhappy paths
gt sling review-pdf-to-latex-kdr review_pdf_to_latex --agent claude-haiku      # ra2 gt mail EPIPE (rides N6 area)
```

## Per-bead sling flags

- **Merge:** default `--merge=mr` (refinery fast-paths after the polecat's pre-verify). Fine
  for every code bead here.
- **Spikes N7/N8:** `--no-merge` — the spike code stays on its branch; the real output is a
  dated note in `docs/research/` that the polecat writes and the kill-ladder decision it
  records (feeds L4 scope). If you'd rather the note land on main, have the polecat commit
  *only* the `.md` and still `--no-merge` the spike dir.
- **`--args`:** each bead description already carries the done-when + kill ladders, so no
  extra args are needed. Add `--args "stop at the kill ladder; do not start L4"` to N7/N8 if
  you want to harden the spike boundary.
- **Accounts:** Wave 1 fires 7 polecats — spread them, e.g. append `--account anthony` to the
  three Opus beads and `--account axbounds` to two Sonnet beads, leaving `kraken` for the rest.

## What this plan deliberately does NOT do

- No `--ralph` (none of these are multi-step loop work).
- No `--review-only` — these are fixes to land, not evaluations. The data-loss bugs are
  verified (C1/C2/C7/C8/C9 ✓); they should merge, not report back.
- Does not touch NEXT/LATER. Those wait on the X-lane and the owner-decision beads
  (`od1`–`od4`); slinging them now would race the unbuilt anchor union.

## After the NOW wave lands

`bd ready` will surface the NEXT frontier. The gating owner-decisions to clear before X-work:
`od1` (status mapping → X2), `od3` (Claude-route target → X8). Sling those to yourself or
decide them directly, then the X1/X2/X3/N2 → X5 chain is unblocked.
