# Project 3 — v1 milestone arc shipped; deferred polish items remain

Date: 2026-05-22
Branch: `feat/multi-agent-columns-scaffold` in `~/t3`
Previous handoffs:
- `2026-05-22-project-3-multi-agent-columns-handoff.md` (initial path-A/B scoping)
- `2026-05-22-project-3-m-col-0-scaffold-handoff.md` (after M-col-0)
- `2026-05-22-project-3-m-col-1-first-pass-handoff.md` (after M-col-1)
- This doc supersedes them; read the scope doc `docs/research/2026-05-22-project-3-multi-column-scoped.md` for the design rationale.

## What landed end-to-end this autonomous run

8 commits on `feat/multi-agent-columns-scaffold` in `~/t3`:

| Commit | Milestone | What it adds |
|---|---|---|
| `cb4bd782` | M-col-0 | `/columns` route + 2-panel scaffold, `react-resizable-panels` v4 |
| `42f03ba4` | M-col-0a | `/perf-columns` synthetic harness + Playwright runner |
| `d002ea4c` | M-col-1 | `columnsStateStore` + `ColumnContext` + `<ColumnChatSurface>` + focus frame |
| `1b2196a3` | M-col-1b | ChatView 3-of-5 navigate calls rerouted to column intent callbacks |
| `a2ce51ea` | M-col-1c | keydown handler gated on focused column |
| `5c0340d0` | M-col-2 | `<ColumnHeader>` thread picker, add/remove columns, persist middleware |
| `8964dd0f` | M-col-3 | italicized recap line with activity blurb + accent dot |
| `7e88105e` | M-col-4+5 | Cmd+1..5 column focus + Restart button for ended crews |

Plus, in `~/PycharmProjects/review-pdf-to-latex`:
- `docs/research/2026-05-22-project-3-multi-column-scoped.md` — design doc with the 3 resolved open questions (resume, approval UX, perf) and milestone plan
- `docs/research/2026-05-22-project-3-m-col-0a-perf-harness.md` — perf harness writeup + manual run procedure
- A chain of bd issues (rev-5sz through rev-7r8) with sub-beads for every deferred polish item

## Current behavior of the columns workspace (code-verified)

**Without live verification — needs t3 backend up to actually drive.** Everything below is what the code does; whether it _feels right_ in real use is what the manual smoke test will tell you.

- Open `/columns` from a logged-in t3 session → empty state with "+ add a column" button, or the persisted layout from a prior session (`localStorage` key `t3code:columns:v1`)
- Click "+ column" → adds an empty slot with a new palette color (max 5)
- In each column header, native `<select>` lists every non-archived server thread across all environments, formatted "title · status"
- Pick a thread → `bindColumn` → `<ChatView>` mounts with that thread's environmentId + threadId
- Click another column or its composer → focus frame moves (inset box-shadow in column's palette color)
- Cmd/Ctrl + 1..5 → focus the column at that index + DOM focus into the composer/root
- Italicized recap line under each ChatView shows `<title> · <activity>` with an accent dot when running
- Clicking diff button in a column **stays in `/columns`** (placeholder badge above footer; inline DiffPanel deferred)
- "Implement in new thread" inside a column rebinds the column to the new thread instead of navigating away
- When a column's session ends/errors, the recap line shows a Restart button → unbinds the column → user picks a new thread via header dropdown
- ChatView keydown shortcuts (terminal toggle, diff toggle, model picker, etc.) only fire for the focused column — no multi-column fan-out
- `×` button on each header closes that column
- Layout (columns + focused column) persists to localStorage; diff state is ephemeral

## What didn't land — all filed as child beads

| Bead | Description | Why deferred |
|---|---|---|
| rev-5sz.1 | Perf data capture | Headless run blocked by t3 backend boot; manual run procedure documented |
| rev-t7q.1 | 2 remaining navigate calls + inline DiffPanel | Drafts have different state; DiffPanel needs narrow-column UI |
| rev-8j5.1 | Sidebar "send to columns" action | Touches sidebar.tsx (~860 lines), needs its own session |
| rev-cam.1 | Tab cycle + Cmd+Enter verification | Needs live test; cheap once backend is up |
| rev-7r8.1 | Clone-original-prompt restart | Needs orchestration.dispatchCommand wiring outside ChatView |

## How to take it for a test drive

```bash
cd ~/t3 && git checkout feat/multi-agent-columns-scaffold
# bring up t3 backend daemon however you normally do
cd apps/web && bun run dev
# open http://localhost:5733/columns
# (URL shortcut for direct binding: /columns?col0=<envId>:<threadId>&col1=<envId>:<threadId>)
```

If a regression surfaces, the suspect-list ranking by churn:
1. `apps/web/src/components/ChatView.tsx` (lines 825, 1713, 2484, 3329, 3469) — the navigate + keydown surgeries
2. `apps/web/src/diffRouteSearch.ts` — added `col0`/`col1` to the strip set
3. `apps/web/src/columnsStateStore.ts` (whole file is new)
4. `apps/web/src/components/{ColumnChatSurface,ColumnHeader,columnContext}.tsx` — new
5. `apps/web/src/routes/_chat.columns.tsx` — new

## Beads state (M-col-* family)

| Bead | Status | Notes |
|---|---|---|
| rev-5sz (M-col-0) | Open | Scaffold done; perf data pending |
| rev-5sz.1 (M-col-0a) | Open | Harness done; awaiting data |
| rev-t7q (M-col-1) | Open | First pass done; 1b 3/5 done; 1c closed |
| rev-t7q.1 (M-col-1b) | Open | 2 draft navs + inline diff |
| rev-t7q.2 (M-col-1c) | **Closed** | Keydown scoped |
| rev-8j5 (M-col-2) | Open | First pass done; sidebar deferred |
| rev-8j5.1 (M-col-2b) | Open | Sidebar action |
| rev-drt (M-col-3) | Open | Acceptance met; closure blocked by upstream still-open |
| rev-cam (M-col-4) | Open | Cmd+1..5 shipped; Tab/Cmd+Enter follow-up |
| rev-cam.1 (M-col-4b) | Open | Tab + Cmd+Enter polish |
| rev-7r8 (M-col-5) | Open | Restart button shipped; clone-prompt follow-up |
| rev-7r8.1 (M-col-5a) | Open | Clone-original-prompt restart |

bd close is blocked by upstream open issues on most milestones because the dep chain still has rev-5sz.1 (perf data) at the head. Functionally all the work is shipped; the chain just hasn't been formally closed.

## Recommended next session

1. **Smoke test with backend up** (highest information value). Verify columns mount, picker lists threads, focus frame follows clicks, recap line updates as crews work, diff button stays in /columns, Restart unbinds, Cmd+1..5 focuses. Capture perf data while you're there (closes rev-5sz.1).
2. **rev-8j5.1 sidebar integration** if you want the "right-click thread → send to columns" UX. Biggest remaining feature gap.
3. **rev-7r8.1 clone-prompt restart** if you want a true "resume" experience.
4. **rev-t7q.1 inline DiffPanel** if diff-in-column is critical workflow.

## Gotchas worth carrying forward

- **T3 commit identity**: memory note at `~/.claude-accounts/.../memory/t3-commit-identity.md`. The GAS TOWN env overrides git config; commits need explicit `GIT_AUTHOR_NAME=AJBcoding ...` prefix.
- **react-resizable-panels v4 API rename**: `PanelGroup` → `Group`, `PanelResizeHandle` → `Separator`, `direction` → `orientation`.
- **TanStack Router validateSearch pollution**: adding new search params to one route can break navigate-callback typing in siblings sharing a parent layout. `stripDiffSearchParams` in `diffRouteSearch.ts` now also drops `col0`/`col1`.
- **Route tree autogen**: after adding a new route file, run `bun run dev` briefly to regen `routeTree.gen.ts`, then typecheck.
- **Pre-existing baseline**: 8 typecheck errors on the branch base have been stable through every commit; none added by this work. Don't try to "fix while you're there."
