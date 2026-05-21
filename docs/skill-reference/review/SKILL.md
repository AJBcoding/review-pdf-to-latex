---
name: review
description: Use when a user inside a crew rig wants to review an annotated source doc (.pdf / .md / .tex) in the review-pdf Electron app — opens the app with origin recorded so Submit slings the bundle back to this rig. Rig-side launcher; one-shot, no orchestration.
---

# review — rig-side Electron launcher

Cross-refs: spec §10.1 (round-based Submit), §10.5 (origin discovery + destination picker), §13.18 (skill contracts).

## What this skill does

This skill is the **rig-side leg** of the round-based Submit loop. The user is working in a crew rig (e.g., `report-engine/anthony`) that authored a document, and wants to walk that document's review in the `review-pdf` Electron app. Invoking `/review <path>` from that rig session:

1. Resolves the rig identity from `gt` (the skill is running inside the rig — it knows its own name).
2. Resolves the path to an absolute path.
3. Spawns the Electron app via the CLI shim, **detached**, passing `--from <rig-id>` so the app records `origin_rig` on launch.
4. Prints a one-line confirmation to this terminal and yields control back. The rig session stays alive — the user keeps working here while the app opens in the background. When they hit Submit in the app, `gt mail send "<rig-id>/" …` (spec §10.1 step 3) lands in this rig's mailbox and the user runs `/review-pdf process <submit-file>` from this session.

That's the entire surface. Bundle reading, results parsing, build orchestration, L3 conversation, and version bumping all live in the sibling `/review-pdf process` skill (bd `rev-ek3`). This skill is intentionally tiny so it can land early and unblock end-to-end testing of the §10.1 Submit loop against a stand-in processor.

## When to invoke

Invoke when the user:

- Types `/review <path>` from a crew rig terminal.
- Asks to "open this PDF in the review app", "open the review tool on …", or similar, while in a rig that has source access to the doc.

Do **not** invoke when:

- The user is in a polecat or witness session — only crew rigs originate Submit rounds. (`gt mail`'s envelope assumes the originator can later receive its own Submit traffic; polecats are ephemeral and won't be alive when Submit fires.) If `$GT_ROLE` doesn't contain `/crew/`, halt and tell the user this skill expects a crew rig.
- The user wants to open the app without a `--from` (standalone case). They should invoke `review-pdf-app open <path>` directly; the app's destination picker (§10.5) handles standalone Submit.
- The user wants to *process* an already-submitted bundle — that's `/review-pdf process` (bd `rev-ek3`).

## Argument

One positional argument: the path to the source doc.

- **Absolute path** (`/abs/path/to/report.pdf`): use as-is.
- **Rig-relative path** (`reports/cota-impact/cota-1.0.pdf`): resolved against the current working directory.
- **Accepted extensions**: `.pdf`, `.md`, `.tex` (matches the source doc types the app handles — spec §3.5).

If the user provides no argument, halt and ask which doc they want to review.

## Procedure

### Step 1 — Verify the rig identity

```bash
gt prime 2>/dev/null | grep '^Identity:' || echo "no-gt"
```

Read `$GT_ROLE` directly as the authoritative source (it's set by `gt prime`):

```bash
RIG_ID="${GT_ROLE:-}"
[ -z "$RIG_ID" ] && { echo "ERROR: GT_ROLE not set; run 'gt prime' first."; exit 1; }
case "$RIG_ID" in
  */crew/*) ;;  # expected
  reviewer/*) echo "ERROR: reviewer rigs don't originate Submit rounds (spec §10.5.2). Open the app directly with 'review-pdf-app open <path>'."; exit 1 ;;
  */polecats/*|*/witness) echo "ERROR: /review must be invoked from a crew rig session (got $RIG_ID)."; exit 1 ;;
  *) ;;  # unrecognized shape — pass through; the app will record whatever we hand it
esac
```

The value of `$RIG_ID` is what gets passed verbatim with `--from`. It becomes `origin_rig` in the submit file (spec §10.1 step 3) and the destination address for `gt mail send "<origin_rig>/"`.

### Step 2 — Resolve the path

```bash
# Argument from the slash-command line:
RAW_PATH="$1"
[ -z "$RAW_PATH" ] && { echo "ERROR: /review needs a path. Usage: /review <path-to-doc>"; exit 1; }

# Resolve to absolute. python3 is the portable choice on macOS where `realpath -m`
# isn't always available.
ABS_PATH="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$RAW_PATH")"

# Fail-fast on non-existent path (bead acceptance — error paths).
[ -f "$ABS_PATH" ] || { echo "ERROR: file not found: $ABS_PATH"; exit 1; }

# Extension check (informational — the app will also reject unknown types).
case "$ABS_PATH" in
  *.pdf|*.md|*.tex) ;;
  *) echo "WARNING: unexpected extension; the review-pdf app handles .pdf / .md / .tex (spec §3.5)." ;;
esac
```

### Step 3 — Verify the CLI shim is on PATH

```bash
command -v review-pdf-app >/dev/null 2>&1 || cat <<EOF >&2
ERROR: 'review-pdf-app' not on PATH.

Install the shim (dev — until packaging lands, bd rev-1md.4):

  ln -s "$(git -C "$GT_RIG_ROOT" rev-parse --show-toplevel 2>/dev/null)/desktop/bin/review-pdf-app" ~/bin/review-pdf-app

Or invoke the dev path directly:

  desktop/bin/review-pdf-app open "$ABS_PATH" --from "$RIG_ID"

After installing, re-run /review.
EOF
command -v review-pdf-app >/dev/null 2>&1 || exit 1
```

The shim itself (at `desktop/bin/review-pdf-app`) forwards argv to either a packaged binary (`$REVIEW_PDF_APP_BIN` if set) or to `npm run dev` in dev mode. Either way, `--from <rig-id>` rides through to `process.argv` in the Electron main process (see `desktop/main/index.ts` `extractPathFromArgv`).

### Step 4 — Spawn detached and yield control

```bash
# Detach: redirect stdio off the tty, background, disown so the rig session
# can exit/handoff without killing the app. Single-instance lock in the Electron
# main (app.requestSingleInstanceLock) means a running app focuses + pivots
# instead of opening a second window.
LOG="/tmp/review-pdf-app-launch-$(date +%s).log"
nohup review-pdf-app open "$ABS_PATH" --from "$RIG_ID" \
  </dev/null >"$LOG" 2>&1 &
disown $! 2>/dev/null || true

echo "review-pdf: launching app for $(basename "$ABS_PATH") (from $RIG_ID). Log: $LOG"
```

The `nohup … </dev/null >$LOG 2>&1 & disown` idiom is the load-bearing piece. Without `</dev/null`, the Electron child can inherit the terminal and block control return. Without `disown`, a parent-process exit can SIGHUP the app. The skill must return within ~1s (bead acceptance); use `&` not `wait`.

### Step 5 — Confirm and exit

The single `echo` in Step 4 is the entire user-facing confirmation. **Do not** run the app yourself further, watch the log, or poll for window state — control belongs back in the rig session.

If you want to show the user where to look when something goes wrong, append the log location to your final terminal output (it's already there). The app's own startup errors land in that file; the rig user can `tail` it if Electron didn't open.

## Failure modes and recovery

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: GT_ROLE not set` | Not in a gas-town session, or `gt prime` not run | Run `gt prime`. If that fails, the user isn't in a rig; re-launch from one. |
| `ERROR: /review must be invoked from a crew rig session` | Invoked from a polecat / witness / refinery session | Switch to a crew terminal (`gt rig list` to see crew sessions) and re-run. |
| `ERROR: file not found` | Path typo or wrong CWD | Re-issue with the correct path. Rig-relative paths resolve against `$PWD`. |
| `ERROR: 'review-pdf-app' not on PATH` | Shim not installed | Symlink `desktop/bin/review-pdf-app` to a PATH dir per Step 3's message. Until packaging lands (bd `rev-1md.4`), this is a manual step. |
| App opens but `origin_rig` is null in the submit file | Desktop side hasn't wired `--from` parsing yet (bd `rev-1md.4` / `rev-1md.5`) | This is a known gap during M7 staging; the launcher is forward-compatible. File a bd issue if the desktop work is already merged and this still happens. |
| App doesn't open at all; log empty | npm/electron dev not bootstrapped (dev mode), or packaged binary path wrong | `cd desktop && npm install && npm run dev` once to seed the dev env. For packaged mode, verify `$REVIEW_PDF_APP_BIN` points at the installed binary. |

## Verification — does Submit see the origin?

After Submit fires in the app (Cmd+Return), check the submit file written to `<source-dir>/.review-state/`:

```bash
ls -t "$(dirname "$ABS_PATH")/.review-state/submit-"*.json | head -1 | xargs jq .origin_rig
```

Expected: `"<rig-id>"` matching what `/review` passed. If `null`, the app didn't capture `--from`; see "App opens but origin_rig is null" above.

## What this skill is NOT

- **Not a processor.** It doesn't read bundles, doesn't run builds, doesn't apply edits. That's `/review-pdf process` (bd `rev-ek3`).
- **Not a daemon.** No watch loops, no event subscriptions. Spawn-and-exit.
- **Not the rewrite of `review-pdf-to-latex`.** That skill is the legacy 4-phase playbook for the sidecar walker; tracked for rewrite under bd `rev-y0r`.
- **Not Reviewer-aware.** Standalone Submit (no `--from`) and the Reviewer destination picker are handled inside the Electron app (§10.5). Don't try to route around the picker from here.

## Out of scope (sibling work)

- Bundle reading / writing — `/review-pdf process` reads submit + bundle JSON.
- Results JSON writing — `/review-pdf process` writes `.review-state/results-<ts>.json` incrementally.
- Build orchestration — `/review-pdf process` runs `review-pdf apply` / `build` / `revert`.
- Version bump prompt at round end — `/review-pdf process` (spec §10.6).
- Single-commit semantics at round end — `/review-pdf process`.

## Installation

Until packaging lands (bd `rev-1md.4`), install in dev mode:

```bash
# Symlink the source-of-truth into ~/.claude/skills/
ln -s "$(git rev-parse --show-toplevel)/docs/skill-reference/review" ~/.claude/skills/review

# Symlink the CLI shim onto PATH (one-time):
mkdir -p ~/bin
ln -s "$(git rev-parse --show-toplevel)/desktop/bin/review-pdf-app" ~/bin/review-pdf-app

# Verify:
command -v review-pdf-app && echo "shim OK"
ls -l ~/.claude/skills/review/SKILL.md && echo "skill OK"
```
