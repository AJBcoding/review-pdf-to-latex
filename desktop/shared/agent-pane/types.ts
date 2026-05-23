// Event shapes shared between main and renderer.
//
// Modeled on t3's contract types (apps/web/src/types.ts + packages/contracts/
// src/orchestration.ts) so that M3 can carve ChatView/session-logic from t3
// with minimal schema translation. We drop t3's branded `MessageId`/`TurnId`/
// `EventId` types and use plain strings; the rest of the shape matches.

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  /** SDK's parent_tool_use_id — non-null when emitted by a subagent. */
  parentToolUseId?: string | null;
  /** True while a partial assistant message is still streaming. Cleared
   * when the authoritative full assistant SDKMessage arrives. */
  streaming?: boolean;
  createdAt: string;
}

export type ActivityTone = "info" | "tool" | "approval" | "error";

/**
 * Semantic classification of a tool call, independent of the SDK's tool
 * name strings. Picked by the adapter from the tool name; the renderer's
 * icon mapper reads this so renames upstream (Bash → Shell, etc.) don't
 * break icon selection. Mirrors t3's workEntryIcon dispatch on
 * `requestKind` / `itemType` rather than name-string matching.
 */
export type ActivityCategory =
  | "command"
  | "file-read"
  | "file-change"
  | "web"
  | "search"
  | "mcp"
  | "other";

/**
 * Non-message timeline entries. Tool calls, tool results, rate-limit notices,
 * compact boundaries, etc. T3's MessagesTimeline interleaves these with
 * ChatMessages by createdAt.
 */
export interface ThreadActivity {
  id: string;
  tone: ActivityTone;
  /** Dotted kind, e.g. "tool.started", "tool.completed", "rate_limit", "compact_boundary". */
  kind: string;
  /** Semantic category for icon dispatch. Set on tool.started entries by
   * the adapter; tool.completed and non-tool kinds typically omit it. */
  category?: ActivityCategory;
  /** Short single-line summary suitable for the timeline. */
  summary: string;
  /** Original SDK payload, opaque to the renderer except for kind-specific UI. */
  payload?: unknown;
  parentToolUseId?: string | null;
  createdAt: string;
}

export type SessionStatus =
  | "starting"
  | "running"
  | "ready"
  | "stopped"
  | "error";

export interface SessionInfo {
  sessionId: string;
  status: SessionStatus;
  model?: string;
  cwd?: string;
  lastError?: string;
  updatedAt: string;
}

export interface TurnDone {
  /** SDK's session_id; turn-level uuid is not always available. */
  sessionId: string;
  success: boolean;
  numTurns?: number;
  durationMs?: number;
  totalCostUsd?: number;
  stopReason?: string;
  terminalReason?: string;
  permissionDenials?: unknown;
  usage?: unknown;
  lastError?: string;
}

/**
 * A pending tool-use permission prompt. Emitted when canUseTool fires;
 * the renderer renders an approve/deny card and posts back via IPC.
 */
export interface PermissionRequest {
  toolUseId: string;
  toolName: string;
  /** Raw tool input (e.g. { command: "rm -rf /" } for Bash). */
  input: Record<string, unknown>;
  /** Bridge-rendered headline, e.g. "Claude wants to read foo.txt". */
  title?: string;
  /** Short noun phrase, suitable for compact UI: "Read file". */
  displayName?: string;
  /** Human-readable subtitle from the bridge. */
  description?: string;
  /** Path that triggered the prompt (eg blocked-path Bash). */
  blockedPath?: string;
  /** Explains why this permission request was triggered. */
  decisionReason?: string;
  createdAt: string;
}

/**
 * Discriminated union of everything the backend sends to the renderer.
 * Plain JSON, IPC-safe.
 *
 * Project 4 M-int-4a: events carry an optional sessionId so a single
 * onEvent stream can route to multiple concurrent ClaudeSession instances
 * (e.g. the conversational session vs Create Context / Sling workers).
 * undefined → the legacy "conv" session for back-compat.
 */
type BackendEventInner =
  | { type: "session"; session: SessionInfo }
  | { type: "message"; message: ChatMessage }
  | { type: "activity"; activity: ThreadActivity }
  | { type: "turnDone"; turnDone: TurnDone }
  | { type: "permissionRequest"; request: PermissionRequest }
  | { type: "permissionResolved"; toolUseId: string };

export type BackendEvent = BackendEventInner & { sessionId?: string };

/** Canonical sessionId for the user's conversational session. */
export const CONV_SESSION_ID = "conv";
