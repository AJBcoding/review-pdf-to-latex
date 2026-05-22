# Project 3 handoff — multi-agent horizontal columns

Date: 2026-05-22
Previous session: shipped agent-viewer v1.1 (Project 2) end-to-end. This session sets up Project 3.

## Where things stand

**Project 2 (agent-viewer) is done and live.** Standalone Electron app at `~/PycharmProjects/agent-viewer`, pushed to https://github.com/AJBcoding/agent-viewer (private), `main` branch. v1.1 covers:

- Streaming partial assistant messages with blinking cursor (merged on `message.id` from `message_start`, not per-chunk uuid)
- Composer model picker (Opus/Sonnet/Haiku) with pre-session selection that survives via `selectedModel` in the store
- Context-window meter (sums `input_tokens + cache_creation + cache_read` — caching-aware)
- canUseTool per-tool approve/deny with `updatedInput` echoed back (Zod runtime schema required it even though TS type marked it optional)
- Session resume across full restarts (session.json under userData)
- Transcript persisted to localStorage via zustand persist middleware
- phone / t3 view modes, GFM markdown, Shiki code highlighting, semantic tool icons (lucide)
- `new` + `phone/t3` controls at top, passive `state · model · session · last cost` pinned at the bottom

**26/26 tests pass.** No known live bugs.

## What "Project 3" means — the scoping fork

Original framing (from `docs/research/2026-05-22-t3-integration-projects.md`): **add multi-agent horizontal columns to t3**. T3 is the shell; we lift agent-viewer's local-Claude backend pattern into t3 alongside Gas City, then build the columns UI on top.

Two viable paths the new session needs to choose between:

### Path A — extend agent-viewer to N columns (Recommended)

**Pros:**
- We own all the code; no t3 upstream PR or Gas City coupling
- ChatComposer / MessagesTimeline / StatusBar / store / ipc-client already work in isolation per session — exactly what columns need
- The `ClaudeSession` interface in `src/main/claude-backend.ts` is already a single-session abstraction; we can instantiate N of them keyed by column id
- Days, not weeks, to a working prototype
- Once the columns UX is proven, the pattern can be lifted into t3 deliberately (this becomes Path B as a follow-up)

**Cons:**
- Doesn't deliver "in t3" per the original strategic ordering
- Eventually we still owe a t3-side integration

**Sized:** ~1 week for a clean v1 of multi-column inside agent-viewer.

### Path B — build directly in t3 (Original plan)

**Pros:**
- Lands inside the larger t3 ecosystem (environments, projects, settings, themes)
- One canonical app for users rather than two

**Cons:**
- Requires adding a "local PTY" backend to t3 alongside Gas City (significant; touches main process Effect plumbing)
- Touches t3 upstream — changes need to be defensible to t3 maintainers
- Larger surface area before any visible columns

**Sized:** ~2 weeks, mostly the backend split.

### Recommendation

**Do Path A first.** It's the smallest path to the actual UX the user originally asked for (multi-agent columns), validates the pattern in code we own, and produces a working artifact within days. Once the columns UI is proven to feel right (right resize behavior, right per-column state isolation, right keyboard nav), the pattern can be cleanly lifted into t3 as Path B with much less guesswork.

## Concrete starting plan (Path A)

Suggested milestones for the next session:

- **M-col-0** — scaffold the column shell. Add `react-resizable-panels`, rework `App.tsx` to render N `<Column>` instances inside a `<PanelGroup>`. Each `<Column>` mounts its own `<StatusBar>` (top, per-column), `<MessagesTimeline>`, `<ChatComposer>`, `<StatusFooter>` (per-column or shared? design choice). Start with hard-coded N=2.
- **M-col-1** — per-column state isolation. Refactor `useStore` from a singleton into a factory `createColumnStore(columnId)`. Or restructure existing store to be column-keyed (`messagesByColumnId`, etc.). Pick one and document why. Update every component to take a column-context.
- **M-col-2** — per-column backend session. Main process: change `session: ClaudeSession | null` to `sessions: Map<columnId, ClaudeSession>`. IPC contracts gain a `columnId` field. Each column gets its own `agentState` so streaming partials route correctly.
- **M-col-3** — add/remove columns at runtime. Toolbar button "+ column" creates a new column. Each column gets a close button. Layout persists to localStorage.
- **M-col-4** — keyboard navigation. Cmd+1/2/3 to focus a column. Cmd+Enter sends to the focused column. Tab cycles.
- **M-col-5** — polish. Per-column model picker (each column can run a different model). Per-column display mode (phone vs t3 independently). Approval routing — clear which column is paused.

## Key technical decisions already made (do not relitigate)

- **Zustand for state**, NOT Effect or Redux. Pattern: one big switch reducer in `apply()`, normalized maps + ids arrays for collections.
- **BackendEvent discriminated union** (`src/shared/types.ts`): `session | message | activity | turnDone | permissionRequest | permissionResolved`. Plain JSON, IPC-safe. The shape mirrors t3's contracts using plain strings instead of branded types.
- **Adapter is mostly pure**, with a tiny stateful `AdapterState { currentStreamingMessageId }` threaded via deps. `createAdapterState()` returns a fresh instance per session.
- **electron-vite** for build, **plain CSS** (not Tailwind), **lucide-react** for icons, **react-markdown + remark-gfm + shiki** for content.

For columns, the natural extension is `Map<columnId, ClaudeSession>` in main and a `columnId` prefix on every store slice.

## Practical reminders the new session will need

- **Launch dev**: `cd ~/PycharmProjects/agent-viewer && npm run dev`. Window opens; the user-data-dir is `~/Library/Application Support/agent-viewer/` (separate from t3's).
- **Run tests**: `npm test` (vitest, ~100ms total).
- **Typecheck**: `npm run typecheck`.
- **Logs**: `console.log` in main goes to the terminal running `npm run dev`. Renderer logs are in DevTools (Cmd+Opt+I in the window).
- **Identity**: commits in `agent-viewer` need `GIT_AUTHOR_NAME=AJBcoding GIT_COMMITTER_NAME=AJBcoding GIT_AUTHOR_EMAIL=kraken-11.sitcoms@icloud.com GIT_COMMITTER_EMAIL=kraken-11.sitcoms@icloud.com` prefixed — the GAS TOWN shell env overrides local git config otherwise. Memory saved at `~/.claude-accounts/kraken/projects/.../memory/agent-viewer-commit-identity.md`.
- **Two gotchas hit during v1.1 polish — verified fixed but worth knowing:**
  1. SDK emits interim `assistant` snapshot SDKMessages mid-stream (after thinking block, before text block). Do NOT clear `state.currentStreamingMessageId` on every `assistant` — only on `message_stop`. Otherwise streaming text fragments.
  2. `PermissionResult` for the `allow` branch requires `updatedInput` as a record at runtime, even though the TS type marks it optional. Echo the original `input` back.

## References

- **Strategic ordering / scoping**: `docs/research/2026-05-22-t3-integration-projects.md`
- **Project 2 plan (now done)**: `docs/research/2026-05-22-project-2-plan.md`
- **Agent-viewer vs t3 comparison**: `docs/research/2026-05-22-agent-viewer-vs-t3-comparison.md`  ← Read this first if going Path B; the relevant t3 components and patterns are catalogued here.
- **Mayor's polecat dispatch thread**: gt mail inbox, thread-37c8743ce1a8 (search "agent-viewer")
- **Formula hardening bead** (mayor-acknowledged, awaiting prioritization): `rev-hd8` — required REPO frontmatter on polecat-work bead descriptions, validated at sling time.
- **Agent-viewer repo**: https://github.com/AJBcoding/agent-viewer (private). Last commit: `393f7cf fix: echo updatedInput on canUseTool allow + split status top/bottom`.

## What is NOT in scope for Project 3

- Project 1 (review-pdf-to-latex on t3 shell). Still unblocked but separate work.
- Tier 3 single-column composer features the polecats didn't get: mode controls dropdown, @-tag file picker, slash commands, image attachments, `updatedPermissions` "always allow" UX. These can be done after columns work, in any column context. Each is sized in the mayor mail.
- Upstreaming agent-viewer changes to t3. Future work, post-Path-A.

## Suggested first action for the new session

1. Read this handoff.
2. Read `docs/research/2026-05-22-agent-viewer-vs-t3-comparison.md` (10 min — it's the architectural overview).
3. Decide Path A vs Path B. If A, start M-col-0 in `~/PycharmProjects/agent-viewer` on a new branch `feat/multi-agent-columns-scaffold`.
4. If unsure, confirm the choice with the user before scaffolding.
