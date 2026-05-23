# Project 3 — multi-agent columns: scoped + decided

Date: 2026-05-22
Supersedes the path-A/path-B framing in `docs/handoffs/2026-05-22-project-3-multi-agent-columns-handoff.md`. That handoff predates the user's scope clarification.

## TL;DR

Build a t3-native **columns workspace** at a new `/columns/$layoutId` route. Up to 5 Gas City crews side by side, each a full interactive chat surface (composer, streaming, per-column inline tool-approval panel). Color-coded footer + italicized "what we're working on" line + frame highlight on the focused column. Selection via per-column header picker plus a "send to columns" action from t3's main sidebar (driven by the existing `threadSelectionStore`). Exited columns stay visible with a "restart" button that clones the original first user message into a fresh crew.

Sized at ~1 week. T3's store and RPC are **already threadId-keyed**, so this is wiring + UI work, not a backend refactor.

## How we got here

The original handoff framed Project 3 as a choice between Path A (extend agent-viewer to N columns) and Path B (build in t3 with a new local-Claude backend, ~2 weeks).

The user clarified the actual vision:
- Columns attach to **Gas City crews** t3 already runs — not fresh local Claude sessions
- Each column is **fully interactive** (composer + tool approval + streaming)
- Selection: **per-column header picker + sidebar "send to columns" action**
- Lifecycle: when a crew exits, the column **stays open with a resume/restart button**

This reframes the project as a t3 **view layer** sitting on top of existing Gas City orchestration. Path A is off (agent-viewer doesn't know about crews); Path B's 2-week estimate was for adding a new backend — that work isn't needed because we're reusing Gas City. Real size is closer to a week.

## Architecture readiness (from t3 research)

T3's store and RPC are already designed for multi-thread concurrency:
- `EnvironmentState.threadById: Record<ThreadId, Thread>` — multi-thread state (`store.ts:42–96`)
- All nested data (messages, activities, sessions, turn state) lives in parallel `…ByThreadId` maps
- RPC methods take `threadId` on every call: `WsGcSubmitSessionRpc`, `WsGcRespondToPendingRpc` (`rpc/gcRpc.ts:80–102`)
- `threadSelectionStore` already supports multi-select with toggle + range-select (`threadSelectionStore.ts:9–122`)
- Per-thread UI-state pattern exists (`uiStateStore` keys by threadId, e.g., `threadLastVisitedAtById`)

The current single-thread UX comes from the route `/$environmentId/$threadId` rendering one `<ChatView>` — not from any global "active crew" assumption.

## Resolved open questions

| # | Question | Decision |
|---|---|---|
| 1 | When a crew exits, how does "restart" work? | **Clone the original prompt into a new crew.** No Gas City changes. The old thread stays in the store as a finished transcript; restart spawns a fresh crew in the same project with the same first user message. |
| 2 | Approval UI for multi-column? | **Per-column inline approval panels** above each column's composer. Matches t3's existing single-thread pattern. No new global tray UI. Frame highlight on a column waiting for approval. |
| 3 | Perf risk at 5 columns × 1000-message transcripts? | **Validate during M-col-0 with a synthetic load test.** If it stutters, adjust before building the rest (lower default N, smarter virtualization, lazy off-screen rendering). |

## Milestones

### M-col-0 — scaffold `/columns` route + perf smoke test
- Add `react-resizable-panels` to t3
- Create route `_chat.columns.$layoutId.tsx` (or query-string variant — finalize during scaffolding) rendering 2 hard-coded `<ChatView>` instances side by side
- Synthetic load test: 5 columns × ~1000 messages, scroll concurrently. Capture frame times. Gate go/no-go for N=5.
- Acceptance: route loads with 2 columns each bound to an existing threadId from the URL/state; load test report committed to `docs/research/`

### M-col-1 — extract `<ColumnChatSurface threadId>` + `columnsState`
- Extract from `ChatView.tsx` (currently destructures route props at `ChatView.tsx:610`) into a component that takes `threadId` as a prop and reads everything from per-threadId store slices
- Scope per-threadId in `uiStateStore`: composer draft, scroll position, expanded approval panels — inventory current globals and migrate
- Add `columnsState` store slice: `{ layout: { columnId, threadId, color }[], focusedColumnId }`
- Acceptance: two columns each behave fully independently; switching focus only highlights one frame; no cross-talk on streaming or approvals

### M-col-2 — header picker + sidebar "send to columns"
- Per-column header dropdown: list active threads, pick one. Selecting changes that column's bound threadId.
- Sidebar entry: action on `SidebarMenuItem` (right-click ⋮ menu or per-row affordance — see `components/ui/sidebar.tsx:746–860`). Multi-select drives "send N threads to N columns" via existing `threadSelectionStore`.
- `+ column` / `× close column` affordances. Layout persists to localStorage (extend `uiStateStore` pattern).
- Acceptance: open columns workspace from sidebar with 1–5 pre-selected threads; add/remove/swap columns at will; layout survives reload

### M-col-3 — visual identity (color footer + recap line + focus frame)
- Per-column color (assigned from a palette of 5, persisted in `columnsState`)
- Italicized "what are we working on" line — pull from the latest user message or assistant recap. Decide source during build (the existing `sidebarThreadSummaryById` may already have this).
- Frame highlight on focused column (subtle border / shadow)
- Acceptance: 5-column view shows 5 distinct colors; focus indicator obvious at a glance; recap line stays current as the crew works

### M-col-4 — keyboard nav + per-column approval routing
- Cmd+1..5 → focus column
- Cmd+Enter → send to focused column's composer
- Tab → cycle column focus
- Port `ComposerPendingApprovalPanel` (or its successor) into `<ColumnChatSurface>` so approvals render inside the column. Frame highlight when an approval is pending.
- Acceptance: keyboard-only workflow across 5 columns is fluent; two simultaneous approvals don't tangle

### M-col-5 — exited-state UI + restart (clone-prompt)
- Detect `threadSessionById[threadId].status === "closed"` (or "error")
- Column shows greyed footer + "crew exited" status
- Restart button: read the thread's first user message, call `WsGcSubmitSessionRpc` with a new threadId in the same project. Column rebinds to the new threadId.
- Acceptance: closing a crew leaves a readable transcript; restart spawns a new crew without leaving the columns view

## Open items / unknowns (do not block on these)

- **Per-column UI state migration scope.** Need a full inventory of which `uiStateStore` keys are global vs already per-threadId. Discover during M-col-1.
- **Recap line source.** `sidebarThreadSummaryById` may have a usable summary, or we synthesize from the latest user/assistant message. Decide during M-col-3.
- **Sidebar UX exact placement.** Right-click context menu vs. inline ⋮ vs. multi-select bulk action — pick after looking at the current sidebar interaction patterns. M-col-2.

## File pointers (for the implementer)

- Single-thread route to mirror: `/Users/anthonybyrnes/t3/apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- ChatView to decompose: `/Users/anthonybyrnes/t3/apps/web/src/components/ChatView.tsx` (props at `:338`, threadId selector at `:628`)
- Store to extend: `/Users/anthonybyrnes/t3/apps/web/src/store.ts` (env state `:42-96`)
- RPC layer (unchanged, just reused): `/Users/anthonybyrnes/t3/apps/web/src/rpc/gcRpc.ts` (`:80-102`)
- Multi-select reuse: `/Users/anthonybyrnes/t3/apps/web/src/threadSelectionStore.ts`
- Sidebar to extend: `/Users/anthonybyrnes/t3/apps/web/src/components/ui/sidebar.tsx` (`:746-860`)

## References

- Original handoff (path-A/B framing, superseded by this doc): `docs/handoffs/2026-05-22-project-3-multi-agent-columns-handoff.md`
- Agent-viewer vs t3 comparison: `docs/research/2026-05-22-agent-viewer-vs-t3-comparison.md`
- Strategic ordering: `docs/research/2026-05-22-t3-integration-projects.md`
- T3 multi-column research (Explore agent report, this session): inline above
