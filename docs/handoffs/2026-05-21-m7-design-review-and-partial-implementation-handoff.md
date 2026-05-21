---
type: handoff
status: M7 design fully reviewed and patched; 1 of 6 children shipped (rev-1md.5); 4 more queued but blocked on wedged polecat infrastructure
created: 2026-05-21
audience: next agent picking up M7 implementation
predecessors:
  - docs/handoffs/2026-05-20-milestone-7-scoped-implementation-ready.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§5.1, §8.5, §9.2.3, §9.2.5, §10.1, §10.4, §10.5.3, §11.3 — all patched this session)
---

# M7 design-review pass + partial implementation handoff

## What this session was

A 4-pass design review of the M7 plan (Pass 1 feasibility / Pass 2 UX / Pass 3 consistency / Pass 4 hostile cases via 4 parallel sub-agents), followed by autonomous slinging of resulting precursor + implementation bds. The review surfaced concrete issues across all four lenses; 9 precursor bds were filed and 8 decisions resolved via parallel sub-agents. Two spikes shipped via polecats; one implementation child shipped. The polecat infrastructure then wedged before the remaining 4 children could land.

## What's done (8 commits on origin/main)

| Commit | What |
|---|---|
| `91bd142` | Spec patches round 1: §8.5 (build_failed re-raises), §10.4 (bundle discovery tiebreaker + post-bump), §11.3 (capability-driven needs-followup is status-only) + 9 precursor bds filed |
| `5870475` | rev-cvr spike: pdf-lib annotation API verified + PDF.js→pdf-lib coord transform is identity + QuadPoints UL,UR,LL,LR convention (chrome polecat) |
| `3854a68` | Spec patches round 2: §5.1 + §10.4 highlights-only for v1 (rev-mpe), §10.5.3 two-gate Reviewer enforcement (rev-1s5), §10.1 steps 3/4/6 gt mail invocation + state machine + concurrent-round lock (rev-2k7) |
| `b9ec6f5` | bd hierarchy restructure: rev-1md.6 split into rev-amx + rev-ek3; 11 issues closed; 4 follow-ups filed |
| (rev-a1u merge) | node-pty + xterm.js installed + Electron 42 ABI verified + claude --skill flag confirmed absent + gt presence probe pinned (nitro polecat) |
| `ee2c888` | rev-1md.5 results watcher: new desktop/main/results-watcher.ts + renderer/main/types/styles updates (1063 LOC; typecheck passes) |
| `cd8ca4f` | rev-z8i spec patches §9.2.3 (slash-command activation) + §9.2.5 (gt --version probe) |

## Decisions captured in bd notes (read these before resuming)

- **rev-pya** (palette): L1 #F5C84B amber / L2 #6FB1FF sky-blue / L3 #E26FB1 magenta; /CA 0.5; CSS chip variables in styles.css need adding; shared with rev-1md.1 bundle writer via engagement-palette.ts
- **rev-1s5** (Reviewer rig enforcement): option 3 — skill-level guard in rev-ek3 + engine subcommand $GT_RIG guard; no PATH scrubbing
- **rev-mpe** (kind enum): option B — v1 ships highlights-only; v2 work tracked as rev-6nr
- **rev-ni4** (pdf_annotation_id migration): optional field, read-time v1→v2 upgrade in main, bundle writer is sole populator, per-comment placement in bundle JSON
- **rev-2k7** (Submit contract): full gt mail invocation pinned, 8-state delivery machine with 30s/10min/5s timeouts, concurrent-round lock with 7-day stale threshold, .abandoned soft-tombstone semantics

## What shipped (closed bds)

- `rev-cvr` spike (pdf-lib + coord transform) — polecat chrome
- `rev-a1u` spike (node-pty + xterm + probes) — polecat nitro
- `rev-1md.5` results watcher — polecat nitro (commit ee2c888)
- `rev-z8i` §9.2 spec patches — this session (commit cd8ca4f)
- 8 design decisions: rev-pya, rev-1s5, rev-per, rev-mpe, rev-ni4, rev-2k7, rev-ul7, rev-1md.6 (split into rev-amx + rev-ek3)

## What's queued and what's blocking it

4 convoys queued (`gt convoy list`):

| Convoy | Bead | Status |
|---|---|---|
| hq-cv-egxqc | rev-1md.1 (bundle writer) | UNBLOCKED — all 4 precursors closed (rev-cvr, rev-mpe, rev-ni4, rev-pya) |
| hq-cv-jyx7y | rev-amx (/review launcher) | UNBLOCKED |
| hq-cv-4kck4 | rev-1md.2 (embedded pane) | UNBLOCKED — rev-a1u closed |
| hq-cv-rliow | rev-z8i (§9.2 spec patch) | DONE in-session; convoy is stale, can be GC'd |

**Polecat infrastructure is wedged** — `gt sling`, `gt polecat nuke`, and `gt polecat stale` all hang indefinitely. The nitro polecat session has been alive since 2026-05-20 23:11 (its last activity timestamp) but the polecat status alternates between idle and stalled without picking up the queued convoys. Two polecat-related background commands failed with exit code 144 (killed by timeout/sigterm).

Suspected cause: bd/dolt lock contention or a wedged gt-town daemon. Recovery probably requires restarting gt town at the user level (`gt town restart` or equivalent). The user should run this manually outside the agent session before the next sling attempt.

## Suggested next-session sequence (post-gt-recovery)

1. `gt rig restart review_pdf_to_latex` (or full `gt town` restart) to recover polecat infrastructure
2. Verify with `gt polecat list review_pdf_to_latex` showing fresh sessions
3. Re-sling the 3 unblocked beads: rev-1md.1, rev-amx, rev-1md.2 (rev-z8i convoy can be GC'd via `gt convoy gc`)
4. After rev-1md.1 lands, sling rev-1md.4 (Submit flow — uses bundle from rev-1md.1)
5. After rev-1md.2 lands, sling rev-1md.3 (toolbar) and rev-ek3 (/review-pdf process)
6. rev-ek3 is the densest piece; budget accordingly

## Files added this session worth knowing

- `desktop/spikes/rev-cvr-pdf-lib/spike.mjs` — working pdf-lib annotation reference for rev-1md.1
- `desktop/spikes/rev-cvr-pdf-lib/out-fresh.pdf` + `out-rotated.pdf` + `readback.json` — spike fixtures
- `docs/research/2026-05-21-pdf-lib-annotation-spike/README.md` — pdf-lib + coord-transform findings
- `docs/research/2026-05-21-m7-92-spike/README.md` — node-pty + Claude CLI + gt presence findings (per rev-a1u note)
- `desktop/main/results-watcher.ts` — new file from rev-1md.5
- All four polecat branches on origin: `polecat/chrome/rev-a1u@mpf2km91`, `polecat/chrome/rev-z8i@mpf3kwtv`, `polecat/nitro/rev-1md.5@*`, `polecat/nitro/rev-amx@mpf3dact` (no commits on the last — was a stall artifact)

## What was NOT done

- rev-1md.1 (bundle writer) — wedged in queue
- rev-1md.2 (embedded pane) — wedged in queue
- rev-1md.3 (right-drawer toolbar) — not yet slung; depends on rev-1md.2
- rev-1md.4 (Submit flow) — not yet slung; uses bundle from rev-1md.1
- rev-amx (/review launcher) — wedged in queue
- rev-ek3 (/review-pdf process) — not yet slung; the densest piece, save for after others
- rev-8iw (multi-user safety, P3) — deferred until second user onboards

## Other follow-ups filed this session

- `rev-6nr` (P3): v2 — strikethrough + standalone comment kinds (PDF tools + bundle annotations)
- `rev-8iw` (P3): multi-user safety: bundle author + same-day overwrite collision detection
- `rev-z8i` (P2): §9.2.3 + §9.2.5 spec patches — DONE
- `rev-khz` (P3): M7 §9.2 follow-up: Reviewer rig — capture gt version + warn on skew (filed by rev-a1u polecat)
- `rev-u6j` (P3): M7 §9.2 follow-up: verify node-pty Windows build on CI runner (filed by rev-a1u polecat)
