# Project 4 — agent-viewer integration into pdf/latex desktop

Date: 2026-05-23
Status: scoped; M-int-1 ready to start

## TL;DR

Replace pdf/latex desktop's lower-right xterm-based Claude pane (`desktop/renderer/claude-pane.ts` + `desktop/main/claude-pty.ts`) with the structured chat UI from agent-viewer (`~/PycharmProjects/agent-viewer`). New pane uses the Claude SDK directly via `claude-backend.ts` instead of spawning a `claude` CLI subprocess and pty-streaming its output.

User-chosen integration model:
- **Port in-place**: copy agent-viewer's React renderer + claude-backend into pdf/latex; add React/Zustand deps; mount in the lower-right pane instead of the xterm component.
- **Feature flag**: old xterm pane stays behind a flag for the transition. Default flips to new pane once stable.
- **Port the context features**: `[Now viewing: …]` priming, multi-tab worker ptys, fresh-start handoff — all reimplemented on top of the agent-viewer model.

## What's there today

### pdf/latex's "agent" (lower right)

```
desktop/renderer/claude-pane.ts   (1104 lines)
desktop/main/claude-pty.ts        (pty subprocess manager)
```

- xterm.js terminal wired to a `claude` CLI subprocess
- Up to 3 tabs: conv pty + 2 worker ptys (Create Context, Sling)
- `notifyDocSwitch(docPath, …)` writes `[Now viewing: …]` to pty stdin (debounced)
- Slash-command priming `/review-pdf-to-latex` injected on first spawn (rev-gkl)
- Fresh Start kills + respawns the conv pty with a handoff priming line
- Workers report status to a γ panel row at the bottom

### agent-viewer

Standalone Electron app at `~/PycharmProjects/agent-viewer`. v1.1 shipped this morning. Structure:

```
src/shared/{types.ts, adapter.ts}        – BackendEvent contract + state adapter
src/main/{claude-backend.ts, session-store.ts, index.ts}
src/preload/index.ts                      – IPC bridge
src/renderer/src/
  App.tsx, main.tsx, store.ts, ipc-client.ts, timeline.ts
  components/{ChatComposer, MessagesTimeline, MessageBubble, StatusBar,
              StatusFooter, ApprovalBanner, WorkGroup, ContextMeter,
              CodeBlock, WorkingIndicator, ...}
```

Features the xterm pane doesn't have: structured messages, streaming partials with cursor, model picker, per-tool approve/deny, persisted transcript, session resume across restarts, ContextMeter, phone/t3 display modes.

## Why this is non-trivial

1. **JSX vs plain TS**: pdf/latex's renderer is plain TypeScript (xterm-based, imperative DOM). agent-viewer is React + Zustand. The new pane needs a React island mounted into the plain-TS host. electron-vite config needs `@vitejs/plugin-react`.

2. **Dep delta**: pdf/latex/desktop's renderer has zero React deps. Adding `react`, `react-dom`, `zustand`, `react-markdown`, `remark-gfm`, `shiki`, `lucide-react` is a real bundle-size change.

3. **Two main-process Claude integrations**: `claude-pty.ts` (pty subprocess) and `claude-backend.ts` (Claude SDK) handle Claude completely differently. They don't share code. Both can coexist behind the feature flag.

4. **Workspace context isn't first-class in agent-viewer**: priming, doc-switch notification, worker spawn, fresh-start — these are all pdf/latex-specific. Need to extend agent-viewer's BackendEvent contract and add IPC methods.

5. **Two gotchas already known from agent-viewer v1.1** (carry forward):
   - SDK emits interim `assistant` SDKMessages mid-stream — don't clear `currentStreamingMessageId` on every assistant, only on `message_stop`.
   - `PermissionResult` "allow" branch needs `updatedInput` echoed back at runtime even though the type marks it optional.

## Milestone plan

### M-int-0 — scope (this doc) ✓

### M-int-1 — scaffold the React mount + feature flag
- Add `@vitejs/plugin-react` + React/Zustand/markdown/shiki/lucide deps to `desktop/package.json`
- Update `electron.vite.config.ts` renderer block with the React plugin
- Copy agent-viewer's renderer code to `desktop/renderer/agent-pane/` (rename + adjust imports)
- Add a feature flag: env var `PDF_LATEX_NEW_AGENT_PANE=1` (or settings key)
- In `desktop/renderer/index.ts`, swap between the old `claude-pane.ts` mount and the new React mount based on the flag
- New pane renders without a backend (placeholder "agent backend not wired" message) — proves the mount works
- Acceptance: `bun run dev` opens the pdf/latex app; with flag off, old xterm pane works as before; with flag on, the lower-right shows the React shell

### M-int-2 — port claude-backend + wire IPC
- Copy `agent-viewer/src/main/claude-backend.ts` + `session-store.ts` into `desktop/main/` (sibling to `claude-pty.ts`)
- Copy `src/shared/types.ts` + `adapter.ts` to `desktop/shared/`
- Wire IPC channels in `desktop/preload/index.ts` and the renderer ipc-client
- Verify: send message, see streaming response, approve a tool, see persisted transcript on restart
- Acceptance: full chat with Claude works inside the new pane; tool approval prompts render and resolve correctly

### M-int-3 — port `[Now viewing:]` doc-context priming
- Extend agent-viewer's backend with a `notifyDocSwitch` IPC method
- Inject a system or user "context update" message into the active session when called
- Debounce 500ms (matching current xterm pane behavior)
- Acceptance: opening a PDF in pdf/latex updates the agent pane with the new document context without disrupting the conversation

### M-int-4 — port worker pty spawn mechanics
- Workers in xterm model are extra ptys. In agent-viewer model, they become separate `ClaudeSession` instances keyed by worker id
- Add IPC: `spawnWorker({ kind: "create-context" | "sling", params, ... })`
- Each worker gets its own tab + session; conversation persists per worker
- Workers report status to γ panel row (existing UI, just feed it from new source)
- Acceptance: Create Context / Sling spawns work as before; up to 3 tabs in the pane

### M-int-5 — port fresh-start handoff
- Tear down current ClaudeSession; create a new one with handoff text injected as first user message
- Preserve existing transcript? Probably yes — start a NEW session but keep old transcript readable somewhere (history view)
- Acceptance: Fresh Start triggers a new conversation seeded with handoff content

### M-int-6 — flip default + remove old pane
- Flag defaults to new pane
- After a real-use bake-in period: delete `claude-pane.ts`, `claude-pty.ts`, related IPC, and the flag
- Update docs

## Risks / open questions

- **node-pty stays for terminal drawer** (different feature) but `claude-pty.ts` specifically goes away when M-int-6 lands. Verify no other code paths import from it.
- **Settings UI for the flag** (rev-68j is already filed for a settings panel; flag could land there). For M-int-1, env var is fine.
- **Multi-window**: agent-viewer assumes one window per session. pdf/latex is single-window with potential multiple PDFs — that maps to one session per app (current model) plus workers. Should be fine.
- **Diff with agent-viewer upstream**: this is a fork moment. If agent-viewer improves later, we'll need to backport. Worth tagging the agent-viewer commit hash we copy from.

## References

- agent-viewer repo: `~/PycharmProjects/agent-viewer`, branch `main`, last commit `393f7cf` at time of port
- pdf/latex desktop: `~/PycharmProjects/review-pdf-to-latex/desktop`
- Existing Claude pane: `desktop/renderer/claude-pane.ts`, `desktop/main/claude-pty.ts`
- Earlier handoff (agent-viewer v1.1 done): `docs/handoffs/2026-05-22-project-3-multi-agent-columns-handoff.md` — section "agent-viewer v1.1 is shipped"
