---
type: handoff
status: active
created: 2026-05-17
audience: review-pdf-to-latex author (AJB)
session_role: first-run validator (run 2 — post-fix verification)
source_project: ~/gt/python419/crew/anthony/reports/cota-impact
source_pdf: ~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment-RESTORED.pdf
companion: 2026-05-17-first-run-cota-feedback.md (run 1)
---

# review-pdf-to-latex — second-run friction report (post-fix verification)

## Run summary

Second pass against the same COTA Impact v2.0 PDF, after thirteen fixes landed:

- BLOCKER fix `rev-8ox` (viewer render context) — confirmed working
- `rev-fv6` (bbox text recovery via `crop` instead of `within_bbox`) — confirmed working
- `rev-fpe` (pdfannots dedup) — confirmed working
- `rev-mvd` (auto-route empty-text non-trigger_match → surfaced_pending) — confirmed working
- `rev-9m5` (sticky note ↔ highlight spatial association) — didn't fire on our data
- `rev-16m` (--project-dir accepted both positions) — confirmed working
- `rev-hgj` (compact status, --quiet, --json) — confirmed working
- `rev-bwi` (`bulk-surface` CLI) — confirmed working
- `rev-bus` (Prev/Next + set-current) — partially wired; see new finding below
- `rev-s1o` (counter defaults to unresolved + filter toggle) — confirmed working
- `rev-dyn` (embedded Claude Code terminal pane) — confirmed working
- `rev-ze1` (corrupt PDF preflight) — not retested in this run
- Dark theme — readable

The remaining problem is the viewer button-click event consumer gap (new substantive finding below). The COTA Phase 2b sweep itself was completed via the CLI workflow alongside this run; commit `88de112`.

## Quantitative deltas vs run 1

| metric | run 1 | run 2 |
|---|---|---|
| `extract` wall time | 3.87s | **1.88s** (~2x faster) |
| `needs_review` after extract | 9 | **1** (only ann-013 — sticky note with no nearby highlight) |
| Empty-`highlighted_text` after extract | 9 | **1** (same as above) |
| `trigger_match=True` count | 8 | 8 (consistent) |
| `surfaced_pending` after bootstrap_state | 0 | 1 (rev-mvd auto-routed ann-013) |
| `bulk-surface` output | n/a | "promoted 8" (atomically transitioned trigger_match items) |
| Doubled "Missing text" warnings | yes | **no** (single emission per annotation) |

The `extract`-time summary line now reports counts:

```
extracted 40 annotation(s); 1 needs_review, 8 surfaced_pending
```

but right after extract, `status` reports:

```
Counts: 40 total · 39 pending · 1 surfaced_pending
```

— that is, only 1 surfaced_pending in actual state. The extract summary appears to count `trigger_match=True` items as if they were surfaced_pending, but bootstrap_state only auto-routes empty-text non-trigger_match items. **Minor file-the-bd: extract summary line miscounts**. The discrepancy is "8 vs 1 surfaced_pending" in the headline.

## What worked

In short: everything the engine team wanted us to confirm, except the viewer button-click consumption path.

- The mapping confidence histogram against the post-fix extract is materially the same as run 1 (15 / 8 / 5 / 3 / 0 across the buckets ≥0.95 / 0.80–0.94 / 0.60–0.79 / 0.40–0.59 / <0.40). Recovery improved the `needs_review` count without disturbing the previously-resolved mappings.
- For the 8 previously-empty-text annotations now with recovered text, the recovered strings include:
  - ann-030: "permits" (literal target of the "permits → allows" edit AJB intended)
  - ann-031: "Graduation equity" (the table-header AJB wanted to "surface this whole table" against)
  - ann-022: pdfplumber returned a fragment near the bbox but it didn't match the original "Fall 2025" intent — bbox sits on adjacent text in the clean PDF. Acceptable degradation.
- `bulk-surface` produces a clean atomic transition with a precise stdout list — easy to audit.
- Dark theme: readable, no overlap problems, status indicators (orange/green/red) still legible against #1a1d23.
- `rev-dyn` terminal pane: toggle works, `claude` subprocess spawns, terminal accepts input.

## What broke / friction

### BLOCKER #1 — viewer button clicks log events but nothing consumes them

**Symptom:** AJB clicked Approve / Reject / Skip / Surface / Prev / Next buttons in the viewer. Nothing visibly happened. State.json's `current_annotation_id` stayed `None`; no status transitions; no rendered annotation change.

**Diagnosis (verified):** The viewer's `/api/events` POST handler accepts clicks (HTTP 204 No Content) and writes to `state-events.jsonl`. State changes are downstream: an external consumer (the orchestrating Claude in their conversation) is expected to be running `review-pdf wait-event` in a loop, reading new events, and dispatching the appropriate CLI subcommands.

Without a consumer running, clicks are silent. The 4 events logged from AJB's clicks + my probes:

```
{"ts":"2026-05-17T16:52:14Z","annotation_id":"ann-001","action":"skip"}
{"ts":"2026-05-18T01:35:55Z","annotation_id":"ann-001","action":"navigate","direction":"next"}
{"ts":"2026-05-18T01:38:21Z","annotation_id":"ann-001","action":"surface"}
{"ts":"2026-05-18T01:38:21Z","annotation_id":"ann-001","action":"navigate","direction":"next"}
```

Note both navigation events and a status-mutating "surface" event sit unprocessed in the log.

**Impact:**

This is the actual blocker that ends a real-world casual viewer test. AJB's reasonable conclusion: "buttons don't work." A user reading the README's mention of Prev/Next buttons would expect them to function standalone. The current design *requires* an orchestrating Claude session attached, but that's not surfaced in the viewer itself.

This is partially `rev-bus`'s scope. The Prev/Next buttons and the `set-current` CLI both landed, but the connection between a Prev/Next button click in the viewer and a `set-current` server-side call is missing.

**Suggested fix shape:**

1. **Auto-dispatch status-neutral actions server-side.** Prev/Next, set-current — these have no state-machine implications. The server can compute `next_unresolved_annotation_id` from state.json itself and call `set-current` directly when it receives a `navigate` event. This makes navigation work without any external consumer.

   Concretely, in `do_POST` for `/api/events`:

   ```python
   def _handle_events_post(self):
       # ... existing parse + body-size guard ...
       payload = json.loads(body)
       action = payload.get("action")
       if action == "navigate":
           direction = payload.get("direction")
           # compute next/previous unresolved annotation id
           next_id = _navigate_unresolved(state, direction)
           if next_id is not None:
               set_current_annotation_id(self.project_dir, next_id)
           # still log the event for audit
           _append_event(payload)
           self._send_simple(HTTPStatus.NO_CONTENT, b"")
           return
       # other actions: just log, let external consumer handle
       _append_event(payload)
       self._send_simple(HTTPStatus.NO_CONTENT, b"")
   ```

2. **Surface "no consumer attached" feedback.** When a status-mutating action sits unprocessed for >2s, the viewer JS could flash the status-line with "No active consumer. Click logged but not yet processed." Better than silent failure.

3. **Document the consumer requirement.** A line in the viewer's startup banner: "Note: state-mutating actions (approve/reject/redraft/skip/surface) require an attached event consumer (`review-pdf wait-event` from the orchestrating Claude session). Navigation works standalone."

I'd push for (1) first — small surface, big UX delta.

### LESSER #2 — `--order surface-first` doesn't reorder the viewer entry point

After `bulk-surface` (9 surfaced_pending) + `serve --order surface-first`, the viewer opened at ann-001 (pending), index 1 of 40. The `state.json.order` field reads `surface-first` but `current_annotation_id` was `None` so the viewer fell back to the first annotation by extraction order. surface-first should arguably set `current_annotation_id` to the first surfaced_pending item on load.

### LESSER #3 — extract summary line counts don't match resulting state

Noted above. Likely a 1-line fix in `extract.py` to compute the summary from the post-bootstrap state rather than from the trigger_match flag.

### NON-ISSUE #4 — surface_chat_log not preserved across `extract --force`

Force re-extract blows away `.review-state/`. The 8 surface_chat_logs we recorded during Phase 2b are now gone (we kept a tar backup at `/tmp/cota-review-state-backup-20260517-183253/`). Not a bug per se — `--force` is explicit, the user is consenting to destruction — but: maybe `extract --force` should refuse if `surface_chat_log` entries exist somewhere in the prior state, or rotate them to a sibling `.review-state-archive/` directory rather than deleting. The audit value of those logs is real (they document the *reasoning* behind decisions, not just the decisions themselves).

## What I wish was different in the docs / skill / UX

- **Skill should mention that viewer buttons require an attached consumer.** Right now the skill describes the Phase 2a wait-event loop but doesn't make it clear that *without that loop running, the viewer is a read-only artifact.* Coming back to the viewer fresh (or as a non-orchestrating user), this is surprising.
- **`extract` exit code 3 on re-extract without `--force` is reasonable, but the user message could mention `surface_chat_log` preservation explicitly.** Right now it says (paraphrasing) "existing state, use --force to overwrite" — but the user might not appreciate that they're about to lose audit chat logs.
- **`bulk-surface` was a delightful CLI affordance** — easy to use, atomic output. Suggest the same shape for a "bulk-defer" CLI that promotes a list of annotation IDs to `deferred` status (useful for "this PDF was already manually applied; defer all the resolved ones before viewing").

## Path forward (suggested order)

1. **BLOCKER #1 viewer event consumption** — auto-dispatch navigate events server-side, surface "no consumer attached" for status-mutating actions.
2. **LESSER #2** — set `current_annotation_id` to first surfaced_pending when order is `surface-first` and current is unset.
3. **LESSER #3** — fix extract summary count.
4. **NON-ISSUE #4** — consider chat-log preservation across `--force` re-extract.

## State preserved at handoff

- Project: `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/`
- `.review-state/` is the post-`--force` extract (40 pending/surfaced, 0 terminal). Original session's surface_chat_logs are in `/tmp/cota-review-state-backup-20260517-183253/.review-state/state.json`.
- `.review-config.toml` added with `terminal_enabled = true` and `terminal_command = "claude"`.
- COTA Impact v2.0 review pass committed in `88de112` (8 cota-impact files, 4 new claims, 3 new bd issues filed).

## Resumption notes

If/when `BLOCKER #1` lands, a third run on the same project would test the viewer end-to-end with all four phases. Until then, the viewer is read-only-ish (terminal pane usable, action buttons silent).

If a third run happens, I'd suggest:
1. `git pull` + reinstall.
2. Don't `--force` re-extract — preserve the surface_chat_logs from this session by reading state.json before the run.
3. `review-pdf serve --order surface-first` with the same `.review-config.toml`.
4. Verify Prev/Next advance current_annotation_id without a wait-event loop running.
5. Attach a wait-event loop for status-mutating actions and walk one cycle of approve/reject/redraft/skip/surface.
