---
type: handoff
status: milestone #7 fully scoped. spec patch landed. 7 bd issues filed (rev-1md epic + 6 children). next up — start implementation with rev-1md.1 (bundle writer).
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: M7 spec design pass — full §10.1/§9.2/§10.4/§10.5/§10.6 redesign around sling-to-rig transport
predecessors:
  - docs/handoffs/2026-05-20-milestone-6-done-milestone-7-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§8, §8.5, §9.1, §9.2, §10.1, §10.2, §10.3, §10.4, §10.5, §10.6, §11, §11.3, §13.13–13.20, §15 — all touched this session)
---

# Milestone #7 scoped — round-based Submit, sling-to-rig, embedded pane, bundle artifact

## What this session was (and was not)

**Was:** a design pass. The M6 handoff identified §10.1 (Submit → agent handoff)
as the recommended M7 work but flagged it as blocked on spec gaps. This session
walked through 7 gaps in §10.1 + §9.2 + adjacent concerns, made decisions
one-at-a-time with the user, and landed the full spec patch + bd implementation
breakdown.

**Was not:** any code. The desktop app and engine are unchanged. No tests, no
builds. Spec + bd issues only.

## The reframe that shaped everything

Going in, I assumed Submit would process the bundle inside the Electron app —
either via the embedded pty (Transport A) or via a one-shot subprocess
(Transport B). Mid-session the user reframed:

> "Submit returns control to the originating rig. The rig has the project
> context, the LaTeX source, the engine. The Electron app is a review *tool*
> inside a longer workflow that lives in the rig."

This shrank the engineering scope dramatically:

- No `/review-pdf process` skill running inside the Electron-app pty
- No worker pty for Submit
- No file watcher for Submit completion (still file-watch for results
  reflection, but that's not "wait for Submit")
- The embedded pty (§9.2) is purely for ad-hoc chat / Sling / Create Context /
  Fresh Start — never for Submit processing
- LaTeX dependency stays in the rig where it belongs

The reframe is the single most important thing the next session needs to
internalize. Read §10.1 first; everything else follows from it.

## The 7 gaps and how each resolved

1. **Bundle artifact shape (§10.4 new).** Two-file deliverable: dated PDF (PDF-native annotations for portability) + JSON sidecar (full structured fidelity). Filename: `YYYY-MM-DD <base>-<v> (AJB edits).{pdf,json}`. Date prefix uses today's-date-at-write; per-day overwrite; new-day accumulates as audit trail. Cmd+S writes bundle; Cmd+Return submits.

2. **Submit transport (§10.1 rewrite).** Sling to originating rig via `gt mail`. Electron stays idle after Submit. Standalone case = destination picker (§10.5). Rejected alternatives: pty-injection (couples Submit to §9.2 dep), subprocess (loses rig project context).

3. **`/review-pdf process` skill contract (§10.1 step 5 + §10.6 + rev-1md.6).** Lives in the rig, not the embedded pty. Wraps existing engine atomic subcommands (`apply`, `build`, `revert`, `preview`). Easy-vs-surface default of easy-first with override. Per-comment retry-then-skip on build failure. Single per-round commit at end. Browser viewer dead per user — legacy 4-phase orchestration commands tracked for cleanup in rev-y0r (independent of M7).

4. **LaTeX project dir discovery.** Moot in rig case (rig is already in it). Standalone case = no LaTeX (Reviewer can only L3-discuss; L1/L2 → `needs-followup`).

5. **Results reflection (§10.1 step 6 + §10.3).** File watcher on `.review-state/` + read-on-open. Statuses re-bucket cards live (Reviewer case) or on doc reopen (rig case while Electron closed). "Round in progress — resume?" banner on reopen if `round_status: in_progress` discovered.

6. **Source-file version bumping (§10.6 new).** Regex `^(.+?)-(\d+)\.(\d+)\.(pdf|md|tex)$`. Rig prompts at round end: minor (default) / major / custom (validated against `\d+\.\d+`). Collision = bump-until-free. Standalone has no bump (no source mutation).

7. **Status enum cleanup (§8/§8.5/§9.1).** Add `build_failed` status (per-comment retry-then-skip mechanic). Fix `doc_version` to sha256 (was misleadingly "1.0/1.1"). Add `pdf_annotation_id` linking comments to bundle PDF annotations. Clarify re-raise: `deferred`+`needs-followup` re-raise; `applied`/`rejected`/`build_failed` archive only.

## §9.2 embedded pane sub-spec

This needed its own design pass (was a one-paragraph placeholder in the spec).
9 numbered subsections now spec it out fully:

- **Pty model:** global conversational pty + ephemeral worker ptys for heavy tasks
- **Lifecycle:** lazy spawn on first PDF open; killed on app quit; `[Restart]` on crash
- **Skill priming:** inject one-line first-message; pre-flight to swap to `--skill` flag if Claude Code CLI supports it
- **Doc-switch line:** `[Now viewing: <basename> — <abs_path> (N pages, M comments)]`, debounce 500ms, suppress on initial spawn
- **Reviewer rig:** global `reviewer/<you>` identity, gas-town auto-detected on `gt` presence
- **Toolbar:** three buttons — Create Context (spawn new worker, single-shot or Ralph loop), Sling (gt-mail to other rigs/crews/mayor), Fresh Start (kill+respawn conversational pty with handoff). Icons TBD in rev-ul7
- **Worker visibility:** β inline progress strip + γ tasks panel (combined); first 3 Create Context spawns get tabs in right drawer bottom, 4th+ in γ only; close tab = kill worker
- **Input:** standard terminal, no blocking during agent processing
- **v2 deferrals:** tool-call collapsing, scrollback persistence, per-PDF scoping, tab↔panel promotion

## Standalone Submit + picker (§10.5)

For when the app is opened without an originating rig (no `--from <rig-id>`
at launch). Single dropdown picker, capability labels visible:

```
Send to: [▾]
  ⤷  📨 Reviewer (local) — talk only, no source edits
      ⛏️  rig: report-engine/anthony — full processing
      ⛏️  rig: cota-impact/anthony — full processing
      ⚙️  Pick another rig…
```

Reviewer can't do source mutation (no engine, no LaTeX) — L1/L2 → `needs-followup`,
L3 → full conversational treatment. User can later open the same PDF from a
rig with source access and route the `needs-followup` items through then.

## Spec patch summary

| Section | Change |
|---|---|
| §8 | Fixed `doc_version` (sha256, not "1.0"); added `pdf_annotation_id`; added `build_failed` |
| §8.5 | Lifecycle diagram + rules updated for `build_failed` and re-raise rules clarified |
| §9.1 | Added "Build failed" filter chip |
| §9.2 | **Full rewrite** — 10 subsections (pty model, lifecycle, priming, doc-switch, Reviewer rig, toolbar, β+γ visibility, input/theme, v2 deferrals) |
| §10.1 | **Full rewrite** — sling-to-rig, 6 steps, load-bearing reasoning |
| §10.2 | Live redraft re-routed through rig session |
| §10.3 | File table expanded with bundle entries; schemas updated (`round_status`, `new_source_path`, `version_chosen`, origin metadata) |
| §10.4 (new) | Review bundle contract — filename, files, schema, PDF render rules, discovery |
| §10.5 (new) | Standalone destination picker + origin tracking + capability matrix + gas-town gating |
| §10.6 (new) | Version bumping rules + commit message shape |
| §11 + §11.3 | L3 description updated for rig-venue; "agent" → "rig" |
| §13 | Added 13.13–13.20 — 5 RESOLVED + 3 NEW OPEN |
| §15 | Cmd+S = Export Bundle; Cmd+Return = Submit |

421 insertions, 35 deletions. Single commit: `c132998`.

## bd issues filed

```
rev-1md  M7 epic
├── rev-1md.1  bundle writer (Cmd+S / Cmd+Return + PDF render + JSON sidecar)
├── rev-1md.2  §9.2 embedded pane (xterm + node-pty + Reviewer rig + lazy spawn)
├── rev-1md.3  right-drawer toolbar (Create Context / Sling / Fresh Start)
├── rev-1md.4  Submit flow (sling to rig + standalone picker + --from)
├── rev-1md.5  results file watcher + status reflection
└── rev-1md.6  /review and /review-pdf process skills (rig-side)

Related (independent):
  rev-ul7  pick toolbar icons (Create Context / Sling / Fresh Start)
  rev-y0r  remove legacy 4-phase engine subcommands (cleanup after M7)
```

## State of the repo at handoff

- **Branch:** `main`, pushed to `origin/main` (commit `c132998`).
- **Quality gates:** N/A — no code changed this session.
- **Untracked but not for commit:** `.beads/.gt-types-configured`, `.beads/PRIME.md`, `.beads/locks/` (bd workspace setup, same state as session start).

## Suggested next session

**Start with rev-1md.1 (bundle writer).** It's the smallest self-contained
piece and unblocks rev-1md.4 (Submit flow) once it lands. Concrete first
moves:

1. `bd update rev-1md.1 --claim` to take it
2. Read §10.4 of the spec for the full contract (PDF render rules, JSON
   schema, filename grammar, when to write)
3. Choose a PDF-mutation library — `pdf-lib` is the most popular for
   Electron + Node use; `hummus-recipe` and `pdfkit` are alternatives.
   `pdf-lib` likely wins on TypeScript support and active maintenance
4. Implement Cmd+S handler that writes the bundle to the source dir
   (don't wire Submit yet — that's rev-1md.4)
5. Wire the "Saved" indicator into the title bar — small, but it's part
   of the bundle contract per §10.4

**Then rev-1md.5 (results file watcher).** Even though Submit doesn't
exist yet, the watcher infrastructure can be built and tested against
hand-crafted `.review-state/results-<ts>.json` files. Unblocks the
status-reflection UX work.

**Then rev-1md.2 (§9.2 embedded pane).** Big one (xterm.js + node-pty +
Reviewer rig). The toolbar (rev-1md.3) and Submit flow (rev-1md.4) both
depend on this for full functionality, but neither hard-blocks until
those features need to actually fire.

**Skill work (rev-1md.6) probably goes last on the rig side** — the
desktop pieces can be tested with manual stand-ins for the rig before the
skills are authored.

## Known unknowns / things to verify during implementation

- **`claude --skill review-pdf-to-latex` CLI flag.** §9.2 priming defaults to
  injecting a first message, with a pre-flight to swap to a hypothetical
  `--skill` flag. Need to verify whether that flag exists on the current
  Claude Code CLI. If it does, prefer it (no token cost, no scrollback noise).
- **`gt mail send` payload shape for slings.** §10.1 step 3 lists what goes
  into the payload, but the actual gt CLI interface for structured payloads
  needs to be checked. May need a custom message format.
- **PDF annotation color palette.** §10.4 sketches L1 yellow / L2 blue / L3
  red but exact palette is TBD. File a small bd alongside rev-ul7 if needed.
- **Engine on PATH inside Reviewer rig.** §10.5.3 notes that standalone-via-
  Reviewer can't process L1/L2, but doesn't address what happens if the
  Reviewer rig somehow *does* have the engine on PATH and a source tree it
  could touch. Reviewer's role as "talk-only" is by-convention, not enforced.

## Reading order for the next session

1. This handoff doc (`docs/handoffs/2026-05-20-milestone-7-scoped-implementation-ready.md`)
2. Spec §10.1 (the reframe — read this twice)
3. Spec §10.4 (the bundle artifact — needed for rev-1md.1)
4. Spec §9.2 (the embedded pane — needed for rev-1md.2)
5. Spec §10.5 + §10.6 (standalone picker, version bumping)
6. `bd show rev-1md.1` and its peers — full implementation notes per issue
