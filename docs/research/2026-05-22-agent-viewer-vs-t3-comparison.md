# agent-viewer vs t3 — same job, different choices

Date: 2026-05-22
Sources: `~/PycharmProjects/agent-viewer` (Project 2 v1, milestones M0–M6) vs `~/t3`.

Both apps solve the same problem: render a chat with a Claude-like agent, including tool calls and approval prompts. They diverge sharply on a few axes and converge on others. This doc catalogs both.

## Overall stack

| Concern | agent-viewer | t3 |
|---|---|---|
| Framework | Electron 42 + electron-vite + React 19 + Zustand 5 | Electron 40 + tsdown + React 19 + Zustand + Effect |
| Renderer routing | None — single screen | TanStack Router (`/$environmentId/$threadId`) |
| Renderer styling | Hand-rolled CSS + custom properties | Tailwind + CSS custom properties (oklch color tokens) |
| Backend transport | Direct `@anthropic-ai/claude-agent-sdk` in main process | WebSocket RPC to a separate Gas City backend process |
| Auth | `claude login` (subscription Agent SDK credit) | Gas City's own provider plumbing |
| Lines of TS/TSX | ~1200 | ~50,000+ |

We're roughly **1/40th the surface area**. T3 spans environments, projects, sessions, planning, terminals, attachments, MCP, diffs, branches. We do one chat, one session at a time.

## Store / state shape

**Convergent — almost identical pattern.**

agent-viewer (`src/renderer/src/store.ts`):
```ts
apply: (event: BackendEvent) => set((state) => {
  switch (event.type) {
    case "session": return { session: { ...(state.session ?? {}), ...event.session } };
    case "message": return appendOrdered(...);
    case "activity": return appendOrdered(...);
    case "turnDone": return { busy: false, lastTurn: event.turnDone };
    case "permissionRequest": ...
    case "permissionResolved": ...
  }
})
```

t3 (`apps/web/src/store.ts:1158-1458`):
```ts
function applyEnvironmentOrchestrationEvent(state, event) {
  switch (event.event) {
    case "thread.message-sent": return updateThreadState(state, ..., (thread) => { ... })
    case "thread.activity-recorded": ...
    case "thread.session-status-changed": ...
    // ~20 more cases
  }
}
```

Both use **one big switch reducer** rather than per-event action creators. Both use Zustand `set()` with immutable updates. Both store messages + activities in normalized maps keyed by id.

T3's reducer is harder to read because every case is keyed per-thread (`updateThreadState(state, threadId, fn)`) and operates on `EnvironmentState.threadById[threadId].messages: ChatMessage[]` — they store messages as a flat array per thread, not a `Record<id, message> + ids[]`. We picked the normalized variant because it makes O(1) dedup on duplicate event IDs cheap.

**One real divergence**: t3 handles **streaming partial messages** by concatenating into the same message-id slot:
```ts
const messages = existingMessage
  ? thread.messages.map((entry) =>
      entry.id !== message.id ? entry
        : { ...entry, text: message.streaming
            ? `${entry.text}${message.text}`        // ← concat partial chunks
            : message.text.length > 0 ? message.text : entry.text,
          streaming: message.streaming, ... }
    )
  : [...thread.messages, message];
```

We don't enable `--include-partial-messages`, so we never emit duplicate-id message events. If we want live "typing" of assistant text, we'd need to (a) ask the SDK for partial messages and (b) port this concat path.

T3 also caps at `MAX_THREAD_MESSAGES: 2000`. We don't cap — naive but fine for typical session lengths.

## Persistence

**Different philosophy.**

- **t3 persists composer drafts only** (`composerDraftStore.ts`, key `t3code:composer-drafts:v1`). Conversation history lives on Gas City; the renderer re-fetches on load.
- **agent-viewer persists the whole transcript** (key `agent-viewer.store`) via `zustand/middleware/persist`. We also persist session_id to disk in main so the SDK can resume Claude's context on relaunch.

This isn't a quality difference — it reflects the architecture. T3 has a server; we don't. If we ever added a server-side session store (e.g. for sync across devices), we'd flip toward t3's model.

T3 *does* flush composer drafts on `beforeunload` to prevent data loss:
```ts
window.addEventListener("beforeunload", () => composerDebouncedStorage.flush());
```

We don't — Zustand persist writes on every state change synchronously, so we don't need a flush hook. (T3 uses a debounced storage wrapper.)

## Display layer — messages

**Convergent visual design.**

User messages: both right-aligned with a rounded bubble. T3 uses Tailwind: `rounded-2xl rounded-br-sm border border-border bg-secondary px-4 py-3`. We have equivalent CSS. T3's bubble is `max-w-[80%]`; ours is `max-width: 75%`.

Assistant messages: both **no bubble**, just markdown inline. Both align left with full text width.

**Divergence: markdown rendering.**

| | agent-viewer | t3 |
|---|---|---|
| Library | `react-markdown` | `react-markdown` + `remark-gfm` |
| GitHub-flavored md | no | yes |
| Syntax highlighting | no — `<pre><code>` plain | yes — `@pierre/diffs` (Shiki-based) with LRU cache |
| Streaming-aware | n/a (we don't stream) | yes — `SuspenseShikiCodeBlock` defers expensive highlight during streaming |

Real gap. If a Claude response includes a code block, ours renders it as monospace plain text on a dark background. T3 colorizes it per language. **Adding `remark-gfm` is one line; adding Shiki is more work but well-trodden.** Both worth doing.

## Display layer — tool calls (work groups)

**Convergent structure, slightly different mapping.**

Both render consecutive tool calls as a single card with a small uppercase header and one row per call. Both use lucide-react icons (Terminal/Eye/SquarePen/Globe/Wrench/Hammer).

**Divergence: how the icon gets picked.**

Our `pickIcon` (`WorkGroup.tsx:14`) matches on **tool name strings**:
```ts
if (n === "bash" || n.includes("command")) return Terminal;
if (n === "read") return Eye;
if (n === "edit" || n === "write") return SquarePen;
```

T3's `workEntryIcon` (`MessagesTimeline.tsx:1062`) matches on **semantic categories** carried in the event payload:
```ts
if (workEntry.requestKind === "command") return TerminalIcon;
if (workEntry.requestKind === "file-read") return EyeIcon;
if (workEntry.itemType === "command_execution" || workEntry.command) return TerminalIcon;
if (workEntry.itemType === "mcp_tool_call") return WrenchIcon;
```

T3's approach is more robust — rename `Bash` to `Shell` and our icon breaks; t3's keeps working because the **bridge classifies the tool semantically before it leaves the backend**. We could do the same in our adapter (classify in main, ship a `kind` field, render against the classification). Modest refactor, worth it pre-v2.

## Composer

**Convergent skeleton, vastly different chrome.**

We have: textarea + send button + cmd-enter shortcut + autosize + disabled-while-busy.

T3 has: textarea + send button + cmd-enter + autosize + disabled-while-busy + model picker + mode controls (plan/edits/etc) + image attachments + drag-and-drop + `@`-tag command menu + `$` skills + `/` slash commands + pending-approval slot in the composer header + pending-input slot + plan-followup banner + interrupt button + context-window meter + branch toolbar.

We can land most of these incrementally as needs come up. The cheap wins are probably: interrupt button **inside the composer** (currently in status bar — less obvious), `@`-tag command menu for file references, and the context-window meter.

## Approval flow

**This is where we're actually ahead.**

T3's `ComposerPendingApprovalPanel` (full file, 32 lines):
```jsx
return (
  <div className="px-4 py-3.5 sm:px-5 sm:py-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
      <span className="text-sm font-medium">{approvalSummary}</span>
      {pendingCount > 1 ? <span>1/{pendingCount}</span> : null}
    </div>
  </div>
);
```

That's it — just a **status header**. The actual allow/deny buttons live elsewhere (`ComposerFooterPrimaryActions`) inside the composer's bottom toolbar. T3 splits the approval surface across the panel header and the footer buttons.

Our `ApprovalBanner` puts everything in one card: title (using the SDK's pre-rendered `title` string), description, command preview, allow/deny/details buttons, expandable details panel. Self-contained, easier to scan, doesn't depend on composer state.

T3 doesn't appear to surface the SDK's **`updatedPermissions` suggestions** (the "always allow this kind of tool" path) anywhere visible — neither do we. Both are leaving that future-work feature on the table.

If you ever want t3's split layout, it's purely a CSS/component refactor — the IPC and state shape are the same.

## Transport

This is the biggest architectural gap, and it's deliberate.

- **t3** runs a separate **Gas City** process. The renderer talks to it via WebSocket RPC (`@orpc` style). Gas City is a long-lived service that hosts conversations, environments, sessions, and SSH/remote runtimes. Multiple t3 windows / devices can connect to the same Gas City.
- **agent-viewer** runs the SDK **directly in the Electron main process**. No separate service. No SSH. No multi-device. One window, one session.

For Project 1 (review-pdf-to-latex on t3), this matters — review users won't run Gas City. The agent-viewer transport is exactly the "local PTY backend" we'd need to add to t3 to support that.

For Project 3 (multi-agent columns), our transport is fine — we'd just spawn N `ClaudeSession` instances in main and route IPC by column id.

## Streaming

T3 streams. We don't. Specifically:

- T3 enables partial-assistant-message events (or relies on Gas City to surface them) and concatenates text chunks into the same message slot as they arrive. Code blocks defer Shiki highlight until streaming finishes (`isStreaming` prop).
- T3 also shows a `WorkingTimelineRow` with three animated dots while the agent is mid-turn but hasn't emitted text yet.

We get the assistant's full message in one event because we don't pass `--include-partial-messages`. Adding it requires (a) flipping the SDK option, (b) porting t3's concat-into-same-id logic, (c) probably adding a "working…" placeholder.

Real UX difference. Not hard to add.

## State persistence on disk (main process)

- **agent-viewer** writes `~/Library/Application Support/agent-viewer/session.json` capturing the active session_id from `system.init`. Used for `resume` on next launch.
- **t3** doesn't need this — Gas City stores everything.

If you ever want history search, transcript export, etc., we'd need to also write the message log to disk. Right now it lives in localStorage only.

## Where we converged

- Store as one big switch reducer
- Normalized message/activity maps
- Lucide icons + same set
- Right-bubble user, no-bubble assistant
- Work-group cards with uppercase header
- Approval flow gated by `canUseTool` (we use SDK, t3's bridge does similar)

## Where we diverged deliberately

- Single window vs router-based environment/thread navigation
- Direct SDK vs Gas City RPC
- Transcript persistence vs server-authoritative
- Hand CSS vs Tailwind+oklch tokens

## Where we're behind and should catch up

1. **Syntax highlighting in markdown** — add `remark-gfm` (one line) + Shiki or Prism for code blocks.
2. **Tool icon picked by semantic category, not tool name** — refactor adapter to emit a `kind` classification.
3. **Streaming partial assistant messages** — flip SDK flag, add concat-into-same-id path.
4. **"Working…" placeholder** while between user-send and first assistant chunk.
5. **`updatedPermissions` "always allow"** path (we surface deny reasons, not always-allow rules).
6. **Interrupt button inside the composer**, not just status bar (more discoverable).

## Where we should NOT copy t3

- Effect-based main process. Heavy ramp for marginal benefit at our scale.
- TanStack Router. Single screen doesn't need it. Add only when Project 3's multi-column layout demands a route per column.
- `@legendapp/list` virtualization. Not needed until transcripts are routinely >500 entries.
- Tailwind. Our hand CSS is ~300 lines and matches the style we want. Tailwind would be a multi-day migration with no functional gain.
- Gas City. We're explicitly trying to be Gas-City-free.

## Summary

We picked the smallest viable subset of t3's chat patterns and built them on a much simpler transport. The visible UX is ~80% there. The functional gaps are mostly in **streaming display** and **code-block rendering** — both fixable in a day. The architecture gaps are intentional and the right call for an offline-first single-window tool.
