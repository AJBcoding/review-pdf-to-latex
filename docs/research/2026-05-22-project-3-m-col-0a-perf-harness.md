# Project 3 — M-col-0a perf harness shipped, data capture pending

Date: 2026-05-22
Bead: rev-5sz.1 (child of M-col-0 rev-5sz)
Branch: `feat/multi-agent-columns-scaffold` in `~/t3`

## What landed

Synthetic perf harness for the columns workspace. Mounts 5 columns side-by-side, each containing a `LegendList` with 1000 mock messages rendered through `react-markdown` + `remark-gfm` (same renderer the real chat timeline uses). A "Run" button triggers `scrollToIndex(999)` on all five lists simultaneously and captures frame intervals via `requestAnimationFrame` for 8 seconds.

Files added:
- `~/t3/apps/web/src/routes/perf-columns.tsx` — the harness route at `/perf-columns` (not under `_chat`, so it skips the auth gate)
- `~/t3/apps/web/scripts/run-perf-columns.ts` — Playwright-driven runner for headless data capture

The harness exposes results both on-page (JSON pretty-print under `data-testid="perf-results"`) and on `window.__perfResults` so the runner can read them.

## Why no data this session

The Playwright runner couldn't drive the harness end-to-end because t3's `__root.tsx` `beforeLoad` calls `ensurePrimaryEnvironmentReady()` and `resolveInitialServerAuthGateState()` — both expect the t3 backend (Gas City server / RPC daemon) to respond on the dev server's API endpoints. With no backend running, those requests get HTML 404 pages instead of JSON, and TanStack Router's `MatchInnerImpl` throws `SyntaxError: Unexpected token '<'`. The error happens before any child route mounts, so the harness itself never gets a chance to render.

The harness is on the `/perf-columns` path (root-level, not under `_chat`), so it's not the auth gate that blocks it — it's the root layout's bootstrap. Fixing this autonomously means either:
1. Running the t3 backend daemon (out of scope for a perf-test session — that's its own multi-step setup)
2. Refactoring the harness component into a `vitest-browser-react` fixture with MSW mocks for the backend RPC (~100 lines of fixture setup, see `ChatView.browser.tsx` for the pattern)

Both are heavier than the user clicking "Run" in an already-running t3 dev session.

## How to capture data (manual, ~5 min)

When you have t3's backend up alongside the web dev server:

```bash
cd ~/t3 && git checkout feat/multi-agent-columns-scaffold
cd apps/web && bun run dev
# open http://localhost:5733/perf-columns
# click "Run 5×1000 scroll test"
# wait ~8 seconds; results appear as JSON on-page
```

Copy the JSON and paste it into the "Captured data" section below. The runner script also works once the backend is up:

```bash
bun apps/web/scripts/run-perf-columns.ts          # headless
bun apps/web/scripts/run-perf-columns.ts --headed # visible browser
```

## What to look for — go/no-go on N=5

Frame stats captured: `frameCount`, `avgFrameMs`, `p50FrameMs`, `p95FrameMs`, `p99FrameMs`, `maxFrameMs`, `jankFrames` (>16.67ms), `severeJankFrames` (>50ms).

Suggested thresholds:

| Metric | Green (ship N=5) | Yellow (investigate) | Red (cap at N=3 or refactor) |
|---|---|---|---|
| p95 frame | <20ms | 20–33ms | >33ms |
| Severe jank | 0 | 1–5 frames | >5 frames |
| Max frame | <50ms | 50–100ms | >100ms |

If p95 stays under 20ms with zero severe jank, default N=5 is safe — proceed to M-col-1 with confidence. If yellow, instrument deeper (which component re-renders cause the jank — likely react-markdown). If red, lower default N to 3 and revisit virtualization strategy before M-col-1.

## Captured data

_(Empty — fill in after manual run.)_

```json
// paste window.__perfResults here
```

**Decision:** _(green / yellow / red — fill in after data is captured.)_

## Notes on harness fidelity

The harness is a *library-level* test: it stresses `@legendapp/list` + `react-markdown` rendering at scale, but does not exercise the full ChatView (which adds turn-diff summaries, message-action menus, code highlighting via Shiki, image previews, etc.). That means it's likely *optimistic* — if it stutters here, real ChatView at the same scale will stutter more.

A higher-fidelity test would mount real `MessagesTimeline` components, but that requires synthetic store fixtures matching t3's full message-derivation pipeline — out of scope until M-col-1 (when `<ColumnChatSurface>` is extracted and easier to mount standalone).

## References

- Scope doc: `docs/research/2026-05-22-project-3-multi-column-scoped.md`
- M-col-0 scaffold handoff: `docs/handoffs/2026-05-22-project-3-m-col-0-scaffold-handoff.md`
- Bead chain: rev-5sz → rev-t7q → rev-8j5 → rev-drt → rev-cam → rev-7r8
- This bead: rev-5sz.1
