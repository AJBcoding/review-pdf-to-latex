# T3 integration — three project breakdowns

Date: 2026-05-22
Status: scoping, no work started

## Context

Two existing Electron apps:

- **review-pdf-to-latex** (this repo): vanilla TS renderer, 3-pane CSS-grid layout, direct `node-pty` spawn of `claude` binary in main process. Single PDF + Claude pane workflow.
- **t3** (`~/t3` / `~/PycharmProjects/t3`): React 19 + TanStack Router + Zustand + Effect renderer. Single BrowserWindow, one-thread-at-a-time chat view. Agents reached via WebSocket RPC to **Gas City** backend (not direct PTY). No multi-agent columns today.

Decision baked in: **t3 is the shell** for projects 1 and 3. Our app's vanilla-TS renderer doesn't scale to the target UI.

---

## Project 1 — Port review feature into t3 as shell

Goal: review-pdf-to-latex's PDF + drafts + Claude-pane feature becomes a route/feature inside t3. T3 is the host app.

### What we lose by adopting t3's stack

- **Vanilla-TS simplicity**. T3 brings React 19 + TanStack Router + Zustand + **Effect** (functional effect system in main process). Effect specifically is a learning ramp.
- **Direct `claude` spawn**. T3 routes agents through Gas City over WebSocket. Our `desktop/main/claude-pty.ts` (skill priming after 1500ms, worker tabs, `[β]` progress parsing, drafts-flush-on-quit handshake) doesn't fit t3's model.
- **Splitter primitives**. `desktop/renderer/splitter.ts` hand-rolled drag gutters → replaced with `react-resizable-panels` or t3's CSS-variable resize approach.
- **2212-line `renderer/index.ts`** monolith — has to be decomposed into React components. Forced refactor; probably good, but expensive.
- **PDF.js direct mount**. `pdf-viewer.ts` needs a React wrapper that doesn't lose perf (refs + effects, selection capture, page nav).
- **Schema-stable IPC channels**. Our 20+ `ipcMain.handle` channels (`drafts:read/write`, `bundle:write`, `submit:promote`, `results:watchStart`, etc.) need to be re-expressed in t3's preload bridge / RPC contract.

### What we gain

- Real component framework, easier to extend (left drawer, right drawer become composable).
- Shared agent infra (one PTY/WS system, not two).
- Routing — multiple PDFs as separate routes possible.
- Modern dev experience.

### Biggest hurdles

1. **Gas City coupling**. T3 assumes Gas City for agent sessions. Review users probably won't run Gas City. Three options: (a) make Gas City a hard dep for review users, (b) add a "local pty" backend to t3 alongside Gas City and let review use that path, (c) keep dual paths in the merged app. **(b) is architecturally right and the biggest single piece of work** — it benefits both apps. Without (b), this project doesn't actually ship a usable review.
2. **PDF.js in React**. Selection capture, page nav, fit-width controls in a way that doesn't re-render the canvas every keystroke. Real engineering.
3. **Drafts/results/bundle pipeline**. Well-tested in vanilla state; porting to Zustand needs deliberate store design (sha256-keyed drafts; results-watcher → store events).
4. **Worker-pty + skill priming**. Review-specific: spawn workers via `pty:startWorker`, parse `[β]` progress markers. Doesn't map onto Gas City's orchestration event shape without an adapter.
5. **Effect.ts ramp**. Not insurmountable; real.

Difficulty: **large** (multi-week).

---

## Project 2 — Phone-style agent message view, standalone (no Gas City)

Goal: extract t3's "clean" message display (user + agent messages only, tool-call noise hidden like Claude on iOS) as a **standalone Electron**, fed by **local Claude** (not Gas City).

### What t3 has that we want

- `apps/web/src/components/ChatView.tsx` — message rendering.
- `apps/web/src/session-logic.ts` — derives display state (pending approvals, phases, work logs) from raw session events.
- Message styling.
- Optional: thread sidebar, keybindings.

### What feeds it today

WebSocket RPC client → Zustand `EnvironmentState.threadSessionById` / `threadTurnStateById` → ChatView reads from store. Events are **structured orchestration events** from Gas City, not raw PTY bytes.

### Two sub-paths for the feed

- **2a — JSONL adapter**: run `claude --output-format stream-json --verbose` (or `--print --output-format json`), parse JSONL, synthesize t3-shaped events, feed ChatView. **Loses interactive TUI** but gets the clean message view.
- **2b — Claude Agent SDK direct**: skip the CLI; use the SDK to get structured events from the source. Cleaner. Bigger rewrite. Requires Agent SDK auth setup.

### Biggest hurdles

1. **Event schema translation**. T3's event shape is Gas City–specific. Need a thin adapter that synthesizes those shapes from Claude's JSONL output (or implements a parallel schema).
2. **Decouple from Gas City config**. T3 references `T3CODE_GASCITY_HOME`, environment bootstrap, settings storage. Carve-out needs to stub or replace.
3. **Tool-call filtering** is the *easy* part. Claude's JSONL tags messages with type (`assistant`, `user`, `tool_use`, `tool_result`); ChatView filters. The filter logic in `session-logic.ts` largely already does this.
4. **Input flow**. User types → send to Claude. JSONL input mode (stdin-piped JSON) is the simplest route.
5. **Approval flow**. Claude pauses for tool approvals in non-skip-permissions mode. T3 has an approval UI; mapping it to Claude's pause/resume needs design.

Difficulty: **small to medium** (days to ~1 week for 2a, longer for 2b).

This project's output is reusable: a working local-Claude backend for t3's display layer becomes the foundation for projects 1 and 3.

---

## Project 3 — Multi-agent horizontal view inside t3

Goal: t3 gains a layout where multiple agent sessions show as **draggable vertical columns** side-by-side, instead of one thread at a time.

### What to add

- **Column layout primitive**: `react-resizable-panels` (~5kb, React 19 compat, active). T3 has none today.
- **Column state**: extend t3 Zustand store with `columnsState: { columns: { id, threadId, focused }[] }`.
- **Per-column ChatView mount**: each column hosts an existing ChatView pointed at a different thread; rely on existing per-`threadId` keying.
- **Drag-add / reorder**: `@dnd-kit` is already in t3's deps (used today only for sidebar reordering).
- **Layout persistence**: save column config to settings via existing desktop bridge.

### Biggest hurdles

1. **Router design**. T3's current route is `/$environmentId/$threadId`. Multi-column needs either `/columns/$layoutId` with column→thread mapping in store, or columns stuffed in search params. TanStack Router supports either; non-trivial choice.
2. **Per-column UI state**. ChatView today assumes global UI state (scroll position, input draft, expanded sections). Multi-column needs a `columnId` scope; without it, all columns mirror each other's scroll/input.
3. **Performance**. 4 active streams × scrolling virtualized chat panes. WS multiplexing is fine; render perf with simultaneous activity needs validation. May force virtualization upgrades in ChatView.
4. **Focus + keybindings**. Cmd+Enter sends — to the focused column. Focus management across N columns is fiddly detail work.
5. **Approval routing**. If two columns are waiting on tool approvals, the UI must make clear which column. T3's approval UI today assumes single thread.

Difficulty: **medium** (~1-2 weeks).

---

## Strategic ordering (if doing more than one)

`2 → 3 → 1`. Project 2's output (local-Claude backend feeding t3's display) is a precondition for project 1 (review can't depend on Gas City) and a useful component for project 3 (multi-column needs the local-Claude path to be cheap to spawn). Project 3 then layers columns on top. Project 1 is last because it's the biggest and benefits from the prior two being in place.

But each project is also valuable standalone.
