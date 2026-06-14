# Handoff — Architectural Review pipeline + NOW-wave dispatch (2026-06-12 → 06-14)

Session covered the full arc: **research → gated multi-agent review → roadmap + spec → 49 beads →
dispatch the entire NOW phase via polecats → drive it to 15/15 merged**, through two infra
incidents. This hands off a completed NOW phase and a gated NEXT phase ready to start.

## TL;DR state

- **Arch-review Phase A + B: DONE.** Deliverable `docs/reports/arch-review/2026-06-12/REVIEW.md`
  (14/14 claims independently verified), companion spec
  `docs/specs/2026-06-12-unified-comment-model-and-roundtrip.md`. Both hard gates were opened by
  the owner (`docs/reports/arch-review/2026-06-12/GATES.md`).
- **Roadmap filed as 49 beads** under epics `rev-enow` (NOW) / `rev-enext` (NEXT) / `rev-elater`
  (LATER), with dependency + parent wiring.
- **NOW phase: 15/15 COMPLETE.** 13 fixes merged to `main` (rev-n1..n6, rev-ra1..ra7); 2 spikes
  (rev-n7, rev-n8) closed no-merge with verdicts recorded on `rev-l4`.
- **NEXT phase: NOT started, gated.** Needs two owner decisions first (see "Next steps").

## What was produced (artifacts)

| Path | What |
|---|---|
| `docs/research/2026-06-12-ground-truth-map.md` | Verified inventory + format-capability matrix + domain traps (Step-0 for the review) |
| `docs/reports/arch-review/2026-06-12/REVIEW.md` | The review: ~57 findings, exec summary, `## Roadmap` (Now/Next/Later), both gate packets |
| `docs/reports/arch-review/2026-06-12/_prompts/` | Charter, run-plan, lane/synth templates (provenance) |
| `docs/reports/arch-review/2026-06-12/evidence/` | Raw lane findings + pass-6 verification + phaseB drafts/challenge/dispositions |
| `docs/reports/arch-review/2026-06-12/GATES.md` | Hard-gate file (GATE 1 + GATE 2 both OPEN, owner-signed) |
| `docs/specs/2026-06-12-unified-comment-model-and-roundtrip.md` | Capability spec: anchor union, 3-party rollout, per-format adapters, status table |
| `docs/plans/2026-06-12-now-sling-plan.md` | Per-bead model-tier dispatch plan (updated to `rev-` IDs) |

## NOW phase results (all in `main` unless noted)

Data-loss/correctness fixes: **rev-n1** MD frontmatter, **rev-n2** draft-seed idempotence,
**rev-n3** abandoned-tombstone filter, **rev-n4** validate-before-mutate, **rev-n5** commit-phase
gitignore exit-19, **rev-n6** submit retry/resume/compensation (merged with conflict resolution).
Ride-alongs: **rev-ra1** empty-revert, **rev-ra2** gt-mail EPIPE, **rev-ra3** SDK-session zombie,
**rev-ra4** window event rebind, **rev-ra5** skip-perms clobber, **rev-ra6** doc-open race,
**rev-ra7** pre-v2 anchor-kind gate.

Spikes (no-merge, artifacts on their polecat branches + `docs/research/2026-06-13-*`):
- **rev-n7** PDF `/IRT` reply chains — **PASS both halves** → v1 ships replies read+write
  (`capabilities.replies=true`). Implementer note on `rev-l4`: pdf.js `.inReplyTo` is the parent
  REF-ID string, not `/NM`; write half must stamp `/NM` for stable ids.
- **rev-n8** per-line `/QuadPoints` write-back — **PASS** (survived ghostscript/degraded re-save,
  no bbox-collapse) → `PdfQuadAnchor.quads[]` is full-fidelity, not read-only fallback.

Both spike outcomes are appended to **rev-l4**'s notes (the PDF-write adapter bead).
Open follow-up: one manual Acrobat-panel visual check for the reply/quads render
(`desktop/spikes/rev-cvr-pdf-lib/out-threaded.pdf`) — deferred into L4, optional.

## Next steps (NEXT / X-series — gated, do these in order)

1. **Resolve two owner-decision beads** (PROPOSED DEFAULTS are written in each + spec §6/§9):
   - **rev-od1** — status-vocabulary mapping. Blocks **rev-x2**, which blocks **rev-x5**.
   - **rev-od3** — Claude-route convergence target (SDK vs pty). Blocks **rev-x8**, **rev-l10**.
   (rev-od2 legacy-viewer kill + rev-od4 rig-guard are LATER-scoped; not blocking NEXT.)
2. **Dispatch the X5 prerequisites** once od1 is closed: **rev-x1** (persistence vitest),
   **rev-x2** (status table), **rev-x3** (split shared/types.ts), plus **rev-n2** (already merged).
   These four gate **rev-x5** — the discriminated anchor-union centerpiece (the 3-party schema
   event: drafts sidecar + submit/results + rig contract). X5 then unblocks X6/X7/X11 and all
   LATER format adapters (L3–L6).
3. `bd ready` from the rig is the live frontier once od1/od3 are decided.

## CRITICAL operational gotchas (also saved to agent memory)

These cost hours this session. See memory files; summary:
- **Run `gt` rig-scoped commands from the gt rig tree** `~/gt/review_pdf_to_latex`, NOT the
  PycharmProjects clone, or gt can't resolve town/rig ("prefix not in routes" / "town root
  unavailable" / "unknown recipient"). `bd` is fine from either.
- **bd store routing:** `.beads/redirect` points to canonical
  `~/gt/review_pdf_to_latex/mayor/rig/.beads`. Rig bead prefix is **`rev-`** (bd's `issue_prefix`
  config drifted to `review-pdf-to-latex`; create rig beads with explicit `--id rev-<key> --force`).
- **THROTTLE sling waves on TWO axes:** firing 15 polecats at once **wedged the shared Dolt SQL
  server** (town-wide; needed a mayor `bd dolt killall && bd dolt start` + MQ reconciliation).
  Firing 4 at one account (`--account axbounds`) **starved spawns** (rev-n1 failed 3× on axbounds,
  succeeded instantly on kraken). Next wave: small batches, spread `--account` ~2-3 each, watch
  `origin/main` between batches.
- **Recovery patterns:** polecat died without pushing a branch → re-sling (try a different
  account). Branch pushed but never merged → its MR didn't register; resume via
  `gt sling rev-X review_pdf_to_latex --branch <branch> --force`.
- **Model aliases created this session** (mayor-approved, town-wide): `claude-opus48`,
  `claude-fable5` (joining existing `claude-sonnet46`, `claude-haiku`, `claude-opus47`). Model
  rides on `gt sling --agent <alias>`; there is no `--model` flag (a P3 gt-tool bead was filed).

## Loose ends / watch-items

- Post-wedge **MQ may still show a stale "ready" entry or two** for already-merged beads
  (e.g. `vault/rev-n4`) — cosmetic; refinery/mayor reconciliation clears them. Verify merged
  beads aren't left HOOKED if you rely on bead status.
- A mayor task is outstanding to confirm full MQ reconciliation; all 13 fixes are confirmed in
  `origin/main` regardless (git is the source of truth for "landed").
- The closed pre-`rev-` tracking bead `review-pdf-to-latex-en6` remains in the store (harmless).
