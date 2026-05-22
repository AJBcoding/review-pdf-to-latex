# Project 2 — Standalone phone-style agent view

Date: 2026-05-22
Status: planning, no code yet

## Goal

A new standalone Electron app that reuses t3's chat display layer (clean assistant/user messages, tool-call noise tucked away) but feeds it from a local Claude session — no Gas City dependency. Full bidirectional chat in v1.

## Decisions locked

- **Backend**: **`@anthropic-ai/claude-agent-sdk`** (locked 2026-05-22). Uses same `claude login` auth as the CLI.
- **Interaction**: full bidirectional chat (input box, multi-turn, in-process session).
- **Repo location**: `~/PycharmProjects/agent-viewer` (locked 2026-05-22).

## Billing model (post-June 15 2026, ~3 weeks from plan date)

Anthropic splits subscription usage into two pools:
- **Chat pool** — web/desktop/mobile Claude.ai (unchanged).
- **Agent SDK pool** — covers BOTH `claude -p` and `@anthropic-ai/claude-agent-sdk`.

Max plan credits (per-user, monthly, no rollover):
- Max 5x: $100/month
- Max 20x: $200/month

Credit exhaustion: spills to API rates if "usage credits" enabled, hard stop otherwise.

**Implication**: CLI-stream-json and SDK are billed identically. Choice was made on technical merits, not cost. Sources: [docs](https://code.claude.com/docs/en/sdk/sdk-headless), [Anthropic support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

## Verified facts from research

### Claude CLI stream-json mode (CLI 2.1.148, verified empirically)

Bidirectional streaming works today. Single process, many turns:

```
claude --print --input-format stream-json --output-format stream-json --verbose \
  [--permission-mode bypassPermissions | acceptEdits | default]
```

- Write to stdin: `{"type":"user","message":{"role":"user","content":"…"}}\n`
- Read from stdout (one JSON object per line):
  - `system.init` — session_id, tools, mcp_servers, model, etc.
  - `assistant` — `{message: {content: [{type:"text", text}|{type:"tool_use", name, input}]}}`
  - `user` — `{message: {content: [{type:"tool_result", tool_use_id, content, is_error}]}}`
  - `result` — per-turn end: duration_ms, num_turns, total_cost_usd, permission_denials
  - `rate_limit_event`, `hook_started`, `hook_response` (when relevant)
- Context retained in-process (verified: cache_read_input_tokens grew across turns within same session_id).
- No in-stream permission/approval event observed in 2.1.148 — use `--permission-mode` or SDK's `canUseTool` to gate.

### T3 display layer (file:line citations)

- **`apps/web/src/components/ChatView.tsx`** — props `{ environmentId, threadId, routeKind, draftId? }`. Reads Zustand store via `createThreadSelectorByRef`, `createProjectSelectorByRef`. Composes `MessagesTimeline`, `ChatComposer`, `PlanSidebar`, `ThreadTerminalDrawer`, status banners.
- **`apps/web/src/session-logic.ts`** — `deriveTimelineEntries`, `deriveWorkLogEntries`, `derivePendingApprovals`, `derivePhase` — turn raw activities into display shapes. **Tool-call filtering already lives here** (`deriveWorkLogEntries`).
- **`apps/web/src/types.ts`** — `ChatMessage`, `ThreadSession`, `ThreadTurnState`. Verbatim contract our adapter has to produce:
  ```typescript
  interface ChatMessage {
    id: MessageId; role: "user"|"assistant"|"system";
    text: string; attachments?: ChatAttachment[];
    turnId?: TurnId|null; createdAt: string; completedAt?: string;
    streaming: boolean;
  }
  ```
- **`apps/web/src/store.ts`** — event handler `case "thread.message-sent"` appends to thread. `MAX_THREAD_MESSAGES: 2000` cap. Activities go via `buildActivitySlice`.
- **`packages/contracts/src/orchestration.ts`** — Effect Schema definitions for `OrchestrationMessage`, `OrchestrationThreadActivity`, `OrchestrationSession`. **This is the wire contract** our adapter targets.
- **Gas City coupling** is small and stubbable: `environmentApi`, `readLocalApi`, `readEnvironmentHttpUrl`, `retainThreadDetailSubscription`, `readServerConfig`. No Gas City refs inside ChatView/session-logic/store proper.

## Adapter: Claude JSONL → t3 event shapes

| Claude event | t3 event |
|---|---|
| `system.init` | `OrchestrationSession` w/ status "ready", capture session_id |
| `assistant` w/ text block | `OrchestrationMessage` role="assistant", text=joined text blocks, streaming during turn |
| `assistant` w/ tool_use block | `OrchestrationThreadActivity` tone="tool", kind="tool.started", payload=tool name+input |
| `user` w/ tool_result | `OrchestrationThreadActivity` tone="tool", kind="tool.completed", payload=result |
| `result` | mark turn done, update `ThreadSession.status` → idle, emit usage |
| `rate_limit_event` | `OrchestrationThreadActivity` tone="info" |

User input flow (reverse): user types in ChatComposer → IPC to main → write to stdin of claude process.

## Files to carve out of t3

Core (copy, slim, port):
- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/chat/MessagesTimeline.tsx`
- `apps/web/src/components/chat/ChatComposer.tsx`
- `apps/web/src/session-logic.ts`
- `apps/web/src/store.ts`
- `apps/web/src/types.ts`
- Subset of `packages/contracts/src/orchestration.ts` (the Schemas we use)

Drop from v1:
- `PlanSidebar` (no plan flow yet)
- `ThreadTerminalDrawer` (no terminals; tool calls visualize as activity entries instead)
- TanStack Router (single-screen app)
- `retainThreadDetailSubscription` (we own the stream)

Top-level deps: `zustand`, `effect`, `@legendapp/list` (virtualized message list), `react-markdown`, `tailwindcss`, `class-variance-authority`. Plus Electron + Vite + React 19.

## Proposed v1 app structure

```
agent-viewer/
├── package.json
├── electron/
│   ├── main.ts             # window, IPC handlers
│   ├── preload.ts          # contextBridge → window.electronAPI
│   └── claude-backend.ts   # spawn SDK/CLI, JSONL → event adapter, emit IPC
├── src/                    # renderer
│   ├── main.tsx
│   ├── App.tsx
│   ├── components/
│   │   ├── ChatView.tsx       # from t3, slimmed
│   │   ├── MessagesTimeline.tsx
│   │   └── ChatComposer.tsx
│   ├── session-logic.ts    # from t3
│   ├── types.ts            # from t3, subset
│   ├── store.ts            # zustand, slimmed
│   └── ipc-client.ts       # bridge to window.electronAPI
├── vite.config.ts
└── tsconfig.json
```

## Milestones

- **M0 — scaffold** (~half day). Electron + Vite + React + TS. Empty window renders.
- **M1 — backend bring-up** (~1 day). Main process spawns Claude (SDK or CLI), sends one user message, logs assistant text to terminal. Bare; no UI yet.
- **M2 — event adapter + tests** (~1 day). JSONL → t3 event shapes. Unit-test the adapter against captured fixtures. This is the contract layer; worth getting right before UI.
- **M3 — display layer carve-out** (~2 days). Copy ChatView/MessagesTimeline/store/session-logic/types from t3. Stub Gas City refs. Wire to a fake event source first; verify it renders.
- **M4 — connect renderer to backend** (~1 day). IPC: renderer subscribes to event stream, dispatches to store; composer input → IPC → claude stdin. End-to-end one-way working.
- **M5 — bidirectional, multi-turn** (~half day). Continuation across turns; session_id persistence; resume on restart.
- **M6 — polish** (~1-2 days). Markdown rendering, code blocks, tool-activity display tuning, approval UX (canUseTool if SDK; permission-mode toggle otherwise).

Total: ~1 week of focused work for a clean v1.

## Risks / unknowns

- **Effect dep** for session-logic.ts derivations. Real ramp if unfamiliar. Could rewrite without Effect, but that defeats "reuse t3's code."
- **`@legendapp/list`** virtualization may or may not behave well outside t3's full layout context.
- **Tailwind config**: t3's tailwind setup is non-trivial; replicating styles 1:1 needs care.
- **Type drift**: t3's `Schema.Struct` (Effect Schema) types are the source of truth. If they change upstream, our adapter breaks silently. Pin a t3 commit.
