// Pure mapper: SDKMessage → BackendEvent[].
//
// One SDKMessage can produce 0, 1, or 2 BackendEvents. The adapter is
// stateless; turn/sequence tracking happens in the renderer store.
//
// Tested against fixtures in __fixtures__/. Do not import Electron, Node fs,
// or anything that would make the adapter side-effectful.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ActivityCategory,
  BackendEvent,
  ChatMessage,
  SessionInfo,
  SessionStatus,
  ThreadActivity,
  TurnDone,
} from "./types.js";

/**
 * Classify a tool name into a stable semantic category for icon dispatch.
 * Public for testing.
 */
export function categoryForToolName(name: string | undefined): ActivityCategory {
  if (!name) return "other";
  const n = name.toLowerCase();
  if (n === "bash" || n.includes("command") || n.includes("shell")) return "command";
  if (n === "read" || n === "view") return "file-read";
  if (n === "edit" || n === "write" || n === "multiedit") return "file-change";
  if (n.includes("webfetch") || n === "websearch" || n.startsWith("web_")) return "web";
  if (n === "glob" || n === "grep" || n === "search") return "search";
  if (n.startsWith("mcp__")) return "mcp";
  return "other";
}

/**
 * Mutable state the caller maintains across mapSdkMessage invocations,
 * so partial-streaming events can be correlated to the eventual full
 * assistant message. The adapter itself stays free of module-level state
 * (still testable in isolation); the host (claude-backend) instantiates
 * one of these per session and passes it on every call.
 */
export interface AdapterState {
  /**
   * API-level message id captured from the `message_start` stream event.
   * All subsequent content_block_delta events on the same message share
   * this id, and the eventual full assistant SDKMessage carries it as
   * `msg.message.id`. Cleared on `message_stop`.
   */
  currentStreamingMessageId: string | null;
}

export function createAdapterState(): AdapterState {
  return { currentStreamingMessageId: null };
}

export interface AdapterDeps {
  /** Injected for deterministic tests. Defaults to wall-clock ISO. */
  nowIso?: () => string;
  /** Injected for deterministic activity IDs. Defaults to incrementing counter. */
  nextId?: () => string;
  /** Per-session mutable state for streaming-partials correlation. */
  state?: AdapterState;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

function summarizeToolUse(name: string | undefined, input: unknown): string {
  const n = name ?? "tool";
  if (!input || typeof input !== "object") return n;
  const obj = input as Record<string, unknown>;
  // Prefer human-relevant fields if present.
  const candidates = ["command", "description", "path", "file_path", "query", "url"];
  for (const k of candidates) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) {
      return `${n}: ${v.length > 120 ? v.slice(0, 117) + "..." : v}`;
    }
  }
  return n;
}

function summarizeToolResult(content: unknown, isError: boolean): string {
  const prefix = isError ? "error: " : "";
  if (typeof content === "string") {
    const trimmed = content.trim();
    return prefix + (trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed);
  }
  if (Array.isArray(content)) {
    const text = content
      .filter((b): b is ContentBlock => !!b && typeof b === "object")
      .map((b) => b.text ?? "")
      .join("\n")
      .trim();
    if (text) return prefix + (text.length > 120 ? text.slice(0, 117) + "..." : text);
  }
  return prefix + "(non-text result)";
}

function makeCounter(): () => string {
  let n = 0;
  return () => `adp-${++n}`;
}

function mapResultToSessionStatus(
  msg: Extract<SDKMessage, { type: "result" }>,
): SessionStatus {
  if (msg.subtype === "success") return "ready";
  if (msg.is_error) return "error";
  return "ready";
}

export function mapSdkMessage(
  msg: SDKMessage,
  deps: AdapterDeps = {},
): BackendEvent[] {
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const nextId = deps.nextId ?? makeCounter();

  switch (msg.type) {
    case "system": {
      if (msg.subtype === "init") {
        const session: SessionInfo = {
          sessionId: msg.session_id,
          status: "running",
          model: msg.model,
          cwd: msg.cwd,
          updatedAt: nowIso(),
        };
        return [{ type: "session", session }];
      }
      if (msg.subtype === "compact_boundary") {
        const activity: ThreadActivity = {
          id: nextId(),
          tone: "info",
          kind: "compact_boundary",
          summary: "context compacted",
          payload: msg,
          createdAt: nowIso(),
        };
        return [{ type: "activity", activity }];
      }
      return [];
    }

    case "assistant": {
      const events: BackendEvent[] = [];
      const blocks = (msg.message?.content as ContentBlock[] | undefined) ?? [];
      const textParts: string[] = [];
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          const activity: ThreadActivity = {
            id: block.id ?? nextId(),
            tone: "tool",
            kind: "tool.started",
            category: categoryForToolName(block.name),
            summary: summarizeToolUse(block.name, block.input),
            payload: { name: block.name, input: block.input },
            parentToolUseId: msg.parent_tool_use_id ?? null,
            createdAt: nowIso(),
          };
          events.push({ type: "activity", activity });
        }
      }
      const joinedText = textParts.join("\n").trim();
      if (joinedText) {
        // Prefer the API-level message id so partials (whose ids come from
        // `message_start.event.message.id`) merge with the final
        // authoritative message in the store. Fall back to msg.uuid for
        // older fixtures + edge cases where message id is absent.
        const message: ChatMessage = {
          id: msg.message?.id ?? msg.uuid,
          role: "assistant",
          text: joinedText,
          parentToolUseId: msg.parent_tool_use_id ?? null,
          createdAt: nowIso(),
        };
        events.push({ type: "message", message });
      }
      // Do NOT clear streaming state here: the SDK emits `assistant`
      // SDKMessages as INTERIM snapshots between content blocks (e.g.
      // after a thinking block, before the text block). State is owned
      // by message_start/message_stop only.
      return events;
    }

    case "user": {
      const events: BackendEvent[] = [];
      const raw = msg.message?.content;
      // String content: plain user prompt — emit a user ChatMessage.
      if (typeof raw === "string") {
        if (raw.length > 0) {
          const message: ChatMessage = {
            id: msg.uuid ?? nextId(),
            role: "user",
            text: raw,
            parentToolUseId: msg.parent_tool_use_id ?? null,
            createdAt: nowIso(),
          };
          events.push({ type: "message", message });
        }
        return events;
      }
      const blocks = (raw as ContentBlock[] | undefined) ?? [];
      const textParts: string[] = [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          const activity: ThreadActivity = {
            id: nextId(),
            tone: "tool",
            kind: "tool.completed",
            summary: summarizeToolResult(block.content, block.is_error === true),
            payload: {
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error === true,
            },
            parentToolUseId: msg.parent_tool_use_id ?? null,
            createdAt: nowIso(),
          };
          events.push({ type: "activity", activity });
        } else if (block.type === "text" && typeof block.text === "string") {
          textParts.push(block.text);
        }
      }
      const joinedText = textParts.join("\n").trim();
      // Only emit a user message for non-synthetic text-only user messages.
      // Synthetic messages (tool_result wrappers) are already captured as activities.
      if (joinedText && msg.isSynthetic !== true) {
        const message: ChatMessage = {
          id: msg.uuid ?? nextId(),
          role: "user",
          text: joinedText,
          parentToolUseId: msg.parent_tool_use_id ?? null,
          createdAt: nowIso(),
        };
        events.push({ type: "message", message });
      }
      return events;
    }

    case "result": {
      const turnDone: TurnDone = {
        sessionId: msg.session_id,
        success: msg.subtype === "success",
        numTurns: msg.num_turns,
        durationMs: msg.duration_ms,
        totalCostUsd: msg.total_cost_usd,
        stopReason:
          msg.subtype === "success" ? msg.stop_reason ?? undefined : undefined,
        terminalReason: msg.terminal_reason,
        permissionDenials: msg.permission_denials,
        usage: msg.usage,
        lastError: msg.subtype !== "success" ? msg.subtype : undefined,
      };
      const session: SessionInfo = {
        sessionId: msg.session_id,
        status: mapResultToSessionStatus(msg),
        updatedAt: nowIso(),
        lastError: turnDone.lastError,
      };
      return [
        { type: "turnDone", turnDone },
        { type: "session", session },
      ];
    }

    case "stream_event": {
      // Partial assistant message — emitted between assistant SDKMessages
      // when `includePartialMessages: true`. We only act on text deltas;
      // thinking/citation/json deltas are out of scope for the chat bubble.
      //
      // Each SDK stream_event carries its OWN per-chunk uuid (NOT shared
      // across deltas), so we can't key on msg.uuid for merging. Instead
      // we track the API-level message id from `message_start` and reuse
      // it for every delta — this matches the eventual full SDKAssistant
      // Message's `message.id` so the store can merge cleanly.
      const ev = msg.event as
        | {
            type: string;
            delta?: { type?: string; text?: string };
            message?: { id?: string };
          }
        | undefined;
      if (!ev) return [];

      // message_start: capture the API-level message id for this stream.
      if (ev.type === "message_start") {
        if (deps.state) {
          deps.state.currentStreamingMessageId = ev.message?.id ?? null;
        }
        return [];
      }
      // message_stop: clear state. The next event in the stream is the full
      // assistant SDKMessage which will also clear (defensive).
      if (ev.type === "message_stop") {
        if (deps.state) deps.state.currentStreamingMessageId = null;
        return [];
      }
      // content_block_start / _stop are framing-only — no UI effect.
      if (ev.type !== "content_block_delta") return [];
      const delta = ev.delta;
      if (!delta || delta.type !== "text_delta") return [];
      const text = delta.text;
      if (typeof text !== "string" || text.length === 0) return [];
      // Fallback to msg.uuid when state isn't threaded (legacy tests, or
      // adapter callers that haven't migrated yet) — partials won't merge
      // in that case but the app stays functional.
      const streamingId = deps.state?.currentStreamingMessageId ?? msg.uuid;
      const message: ChatMessage = {
        id: streamingId,
        role: "assistant",
        text,
        parentToolUseId: msg.parent_tool_use_id ?? null,
        streaming: true,
        createdAt: nowIso(),
      };
      return [{ type: "message", message }];
    }

    case "rate_limit_event": {
      const activity: ThreadActivity = {
        id: nextId(),
        tone: "info",
        kind: "rate_limit",
        summary: "rate limit event",
        payload: msg,
        createdAt: nowIso(),
      };
      return [{ type: "activity", activity }];
    }

    default:
      // Ignore types we don't render yet (status, hook_*, permission_denied,
      // task_*, plugin_install, mirror_error, ...).
      return [];
  }
}
