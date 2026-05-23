# Project 3 — M-col-1 first pass landed; navigate/keydown surgeries deferred

Date: 2026-05-22
Bead: rev-t7q (M-col-1)
Branch: `feat/multi-agent-columns-scaffold` in `~/t3`
Previous handoff: `2026-05-22-project-3-m-col-0-scaffold-handoff.md`

## What landed this session

T3 commit `d002ea4c` on the scaffold branch. Four files (three new, one updated):

- `apps/web/src/columnsStateStore.ts` — zustand store for the columns workspace layout. Tracks `columns: { columnId, threadRef, colorIndex }[]` + `focusedColumnId`. Actions: `setLayout`, `bindColumn`, `unbindColumn`, `setFocusedColumn`. No persistence yet (M-col-2 adds it).
- `apps/web/src/components/columnContext.tsx` — `ColumnContext` + `useColumnContext()` + `useIsInsideColumn()`. Signals to descendants that they're rendered inside a column so they can adapt routing/focus behavior. Currently just carries `columnId`; future surgeries (M-col-1b) will extend it.
- `apps/web/src/components/ColumnChatSurface.tsx` — the per-column wrapper. Reads its threadRef from the store by columnId, wraps `<ChatView>` in `ColumnContextProvider`, draws an inset box-shadow focus frame in one of five palette colors, and shows a thin color-coded footer (column id + thread id suffix).
- `apps/web/src/routes/_chat.columns.tsx` — now reads layout from `columnsStateStore` instead of computing it inline. URL `?col0=…&col1=…` is still the entry point but only seeds the store on first mount; subsequent state updates go through the store.

## What's NOT done (deferred to children of rev-t7q)

The Explore audit of `ChatView.tsx` (3788 lines) found that most state is already per-thread (store messages/turns/sessions keyed by threadId, composer drafts keyed by `composerDraftTarget`, terminal state keyed by threadKey). Two genuine gaps surfaced and both are now child beads:

### rev-t7q.1 — M-col-1b: rewire ChatView navigate() calls to callbacks

Five `useNavigate()` calls in `ChatView.tsx` navigate the whole window away from `/columns` when triggered from a column:

| Line | Trigger | Target | Column-mode want |
|---|---|---|---|
| 1042-1045 | PR dialog → draft | `/draft/$draftId` | rebind this column to the new draft |
| 1076-1079 | new draft thread | `/draft/$draftId` | rebind this column |
| 1226 | "Reconnect" → Connections | `/settings/connections` | open in new tab or modal |
| 1713-1724 | Toggle diff panel | `/$envId/$threadId?diff=1` | flip per-column diff panel state |
| 3329-3335 | "Implement in new thread" | `/$envId/$threadId` | rebind column to new thread |
| 3469-3481 | Open turn diff | `/$envId/$threadId?diff=1&...` | open column-local diff |

The fix pattern is the same for each: detect `useColumnContext()`. If inside a column, route the action through a callback (likely extending ColumnContext with a `routeAction()` method, or via the store). If outside, keep existing navigate.

Each is a small targeted surgery (~20-40 lines) but five of them is a session of work.

### rev-t7q.2 — M-col-1c: scope the global keydown handler

`ChatView.tsx:2467-2555` registers a window-level keydown listener. The terminal-focus gate at :2473 calls `isTerminalFocused()` from `terminalFocus.ts:6`, which uses `document.activeElement` globally — so both column-mounted ChatViews see the same answer, and both will respond to terminal shortcuts. Fix: scope the focus check by threadRef, or only fire the handler when this ChatView's column is the focused one.

## Acceptance vs reality

| M-col-1 acceptance | Status |
|---|---|
| Two columns behave fully independently | **Mostly**: store state was already per-thread; this session adds the wrapper. The 5 navigate calls and the keydown handler are remaining holes — child beads filed. |
| Switching focus only highlights one frame | ✓ box-shadow inset frame driven by `focusedColumnId` |
| No cross-talk on streaming or approvals | **Believed yes** by audit (store keyed by threadId, composer + terminal already scoped) but NOT live-verified — needs t3 backend up to actually run. |

The runtime verification gap is the same one M-col-0a hit: t3 dev needs the backend daemon to bootstrap. Inspecting the code is high-confidence but not the same as actually seeing two columns side-by-side stream without cross-talk.

## How to pick up

```bash
cd ~/t3 && git checkout feat/multi-agent-columns-scaffold
cd apps/web && bun run typecheck   # 8 pre-existing baseline errors, none mine
# (start backend daemon here)
bun run dev
# then http://localhost:5733/columns?col0=<env>:<thread>&col1=<env>:<thread>
```

Suggested first action for next session:
1. **Manual verification** of M-col-1 with backend up — confirm two columns stream independently, focus indicator follows clicks, footer shows the right thread suffix per column. If green, close rev-t7q.
2. Then **rev-t7q.1 (M-col-1b)** — the navigate-call surgeries are the biggest remaining UX hole; without them, opening a diff in a column kicks you out of `/columns`.
3. **rev-t7q.2 (M-col-1c)** — the keydown handler — is lower priority unless you actually try terminal shortcuts in columns.

## Beads state

- rev-5sz (M-col-0): open, scaffold + perf harness done, awaiting manual perf run
- rev-5sz.1 (M-col-0a): open, harness shipped, awaiting data
- **rev-t7q (M-col-1): open, first-pass shipped this session, audit-verified core + 2 deferred surgeries**
- rev-t7q.1 (M-col-1b): open — navigate→callback surgeries
- rev-t7q.2 (M-col-1c): open — keydown handler scoping
- rev-8j5 (M-col-2): blocked on rev-t7q
- rev-drt (M-col-3): blocked on rev-8j5
- rev-cam (M-col-4): blocked on rev-drt
- rev-7r8 (M-col-5): blocked on rev-cam

## Files of interest for next session

- `~/t3/apps/web/src/columnsStateStore.ts` — extend with persistence (M-col-2) and add/remove column actions (M-col-2)
- `~/t3/apps/web/src/components/columnContext.tsx` — extend the context with `routeAction(kind, payload)` for the navigate-call surgeries (M-col-1b)
- `~/t3/apps/web/src/components/ColumnChatSurface.tsx` — the per-column unit; will get a header picker dropdown in M-col-2 and a recap line in M-col-3
- `~/t3/apps/web/src/components/ChatView.tsx` — the targets of M-col-1b and M-col-1c surgeries (lines listed above)
