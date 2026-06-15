// Claude Agent SDK driver. Owns the lifetime of a single streaming-input
// session: spawn once via query() with an AsyncIterable<SDKUserMessage>,
// push user messages onto the queue from IPC, run incoming SDK messages
// through the adapter, emit BackendEvents to the renderer.
//
// M5: supports `resume` for context continuity across restarts.
// M6: implements canUseTool → emits a permissionRequest event and awaits
// the renderer's approve/deny response over IPC.

import {
  query,
  type SDKMessage,
  type SDKUserMessage,
  type Query,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { mapSdkMessage, createAdapterState } from "@shared/agent-pane/adapter.js";
import type { BackendEvent } from "@shared/agent-pane/types.js";
import { sdkPermissionOptions } from "./session-policy.js";

type EventSink = (event: BackendEvent) => void;

class UserMessageQueue implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: Array<
    (v: IteratorResult<SDKUserMessage>) => void
  > = [];
  private done = false;

  push(text: string): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    if (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: msg, done: false });
    } else {
      this.queue.push(msg);
    }
  }

  end(): void {
    this.done = true;
    while (this.resolvers.length > 0) {
      const r = this.resolvers.shift()!;
      r({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

interface PendingApproval {
  resolve: (result: PermissionResult) => void;
  reject: (err: Error) => void;
  /** The tool input as the SDK passed it to canUseTool — must be echoed
   * back as `updatedInput` on allow (SDK Zod schema requires it as a
   * record even though the TS type marks it optional). */
  input: Record<string, unknown>;
}

export interface ClaudeSession {
  send(text: string): void;
  interrupt(): Promise<void>;
  setModel(modelId: string): Promise<void>;
  approve(toolUseId: string, allow: boolean, denyReason?: string): void;
  close(): Promise<void>;
  getSessionId(): string | null;
}

export interface StartSessionOptions {
  emit: EventSink;
  resume?: string | undefined;
  onSessionId?: (sessionId: string) => void;
  /** Called once when the session terminates on its own — either the SDK
   * stream ended or `query()` threw. NOT called for a host-initiated
   * `close()` (the host already owns teardown in that path). Symmetric to
   * `onSessionId`: lets the host drop its registry entry so the next send
   * lazily creates a FRESH session instead of feeding this dead one. */
  onClosed?: () => void;
  /** Optional initial model. Closes the pre-session selection gap — if the
   * user picks a model before the first send, the renderer threads it
   * through here so the fresh query() starts with the right model rather
   * than the SDK default. */
  model?: string;
  /** Working directory for the session (X8 parity with the pty route's cwd
   * anchoring). Resolved by the host via resolveSessionCwd; when omitted the
   * SDK defaults to process.cwd(). The SDK freezes cwd for the session's
   * lifetime, so later doc switches don't move it — same semantics as
   * §9.2.9's spawn-time anchoring. */
  cwd?: string;
  /** When true, run the session under `bypassPermissions` (no canUseTool
   * prompts) — parity with the pty route's `--dangerously-skip-permissions`.
   * Default false: keep `permissionMode: "default"` + canUseTool so the
   * permission UI stays active (OD-3's structural advantage). */
  skipPermissions?: boolean;
}

export function startSession(opts: StartSessionOptions): ClaudeSession {
  const { emit, resume, onSessionId, onClosed, model, cwd, skipPermissions } =
    opts;
  const queue = new UserMessageQueue();
  const pending = new Map<string, PendingApproval>();
  let q: Query | null = null;
  let sessionId: string | null = null;
  // Set by close() so the run() teardown knows the host is already handling
  // teardown and must NOT fire onClosed (which would race a freshly-created
  // session for the same registry key — e.g. agent:newSession closes then
  // immediately re-creates "conv").
  let hostClosing = false;

  const wrappedEmit: EventSink = (event) => {
    if (event.type === "session" && !sessionId && event.session.sessionId) {
      sessionId = event.session.sessionId;
      onSessionId?.(sessionId);
    }
    emit(event);
  };

  const canUseTool: CanUseTool = (toolName, input, options) => {
    return new Promise<PermissionResult>((resolve, reject) => {
      const toolUseId = options.toolUseID;
      pending.set(toolUseId, { resolve, reject, input });

      // If the SDK aborts (eg session close), reject the pending promise so
      // canUseTool unblocks. Returning deny would also work but reject is
      // more accurate semantically.
      options.signal.addEventListener("abort", () => {
        const p = pending.get(toolUseId);
        if (p) {
          pending.delete(toolUseId);
          p.reject(new Error("aborted"));
        }
      });

      wrappedEmit({
        type: "permissionRequest",
        request: {
          toolUseId,
          toolName,
          input,
          title: options.title,
          displayName: options.displayName,
          description: options.description,
          blockedPath: options.blockedPath,
          decisionReason: options.decisionReason,
          createdAt: new Date().toISOString(),
        },
      });
    });
  };

  // Per-session adapter state. Tracks the API-level message id across
  // stream_event partials so they merge into the eventual full assistant
  // message in the store. One instance lives for the lifetime of this
  // session — multi-session lands at Project 3.
  const adapterState = createAdapterState();

  // Resolve every outstanding canUseTool promise as a deny so the SDK (or its
  // abort path) unblocks and no promise leaks. Idempotent — clears the map.
  const drainPending = (message: string): void => {
    for (const [id, p] of pending.entries()) {
      p.resolve({ behavior: "deny", message });
      wrappedEmit({ type: "permissionResolved", toolUseId: id });
    }
    pending.clear();
  };

  const run = async (): Promise<void> => {
    try {
      console.log(
        `[claude-backend] starting session${resume ? ` (resume=${resume.slice(0, 8)})` : ""}${skipPermissions ? " (skip-permissions)" : ""}`,
      );
      const permOpts = sdkPermissionOptions(skipPermissions === true);
      q = query({
        prompt: queue,
        options: {
          ...permOpts,
          // canUseTool only matters under "default" mode; under
          // bypassPermissions the SDK never calls it, so omit it to avoid
          // implying a permission UI that won't fire.
          ...(permOpts.permissionMode === "default" ? { canUseTool } : {}),
          includePartialMessages: true,
          ...(cwd ? { cwd } : {}),
          ...(resume ? { resume } : {}),
          ...(model ? { model } : {}),
        },
      });
      for await (const message of q) {
        const events = mapSdkMessage(message as SDKMessage, {
          state: adapterState,
        });
        for (const event of events) wrappedEmit(event);
      }
    } catch (err) {
      console.error("[claude-backend] session error:", err);
      const msg = err instanceof Error ? err.message : String(err);
      emit({
        type: "session",
        session: {
          sessionId: sessionId ?? "error",
          status: "error",
          lastError: msg,
          updatedAt: new Date().toISOString(),
        },
      });
    } finally {
      // The session is over — the SDK stream ended or query() threw. Without
      // this, an errored session stayed in the host's registry as a zombie:
      // queue never ended (so every later send() was silently buffered onto a
      // consumer-less queue), pending approvals leaked, and ensureSession kept
      // handing the dead session back. End the queue, drain approvals, and —
      // unless the host is already tearing us down — notify it to drop the
      // registry entry so the next send creates a fresh session.
      drainPending("Session ended before approval.");
      queue.end();
      if (!hostClosing) onClosed?.();
    }
  };

  void run();

  return {
    send(text: string): void {
      queue.push(text);
    },

    approve(toolUseId: string, allow: boolean, denyReason?: string): void {
      const p = pending.get(toolUseId);
      if (!p) {
        console.warn(
          `[claude-backend] approve() called for unknown toolUseId=${toolUseId}`,
        );
        return;
      }
      pending.delete(toolUseId);
      if (allow) {
        // Echo the original tool input back as `updatedInput`. The SDK's
        // runtime Zod schema for the `allow` branch requires this field
        // as a record even though the TS type marks it optional —
        // omitting it triggers "Tool permission request failed:
        // ZodError: ... expected record, received undefined" and the
        // tool is rejected. Verified empirically on SDK 0.3.148 via
        // [perm-trace] logging.
        p.resolve({
          behavior: "allow",
          updatedInput: p.input,
          toolUseID: toolUseId,
        });
      } else {
        p.resolve({
          behavior: "deny",
          message: denyReason ?? "User denied this tool call.",
          toolUseID: toolUseId,
        });
      }
      wrappedEmit({ type: "permissionResolved", toolUseId });
    },

    async interrupt(): Promise<void> {
      if (!q) return;
      try {
        await q.interrupt();
      } catch (err) {
        console.error("[claude-backend] interrupt failed:", err);
      }
    },

    async setModel(modelId: string): Promise<void> {
      if (!q) return;
      try {
        await q.setModel(modelId);
      } catch (err) {
        console.error("[claude-backend] setModel failed:", err);
      }
    },

    async close(): Promise<void> {
      // Host-initiated teardown: suppress the run() onClosed callback so it
      // can't race a session the host re-creates under the same registry key.
      hostClosing = true;
      // Resolve any pending approvals as denies so canUseTool doesn't hang.
      drainPending("Session closed before approval.");
      queue.end();
      if (q) {
        try {
          await q.return();
        } catch {
          // SDK may not implement return cleanly; ignore.
        }
      }
    },

    getSessionId(): string | null {
      return sessionId;
    },
  };
}

// M1 one-shot smoke test, kept for debugging via AGENT_VIEWER_SMOKE=1.
export async function runOneShot(prompt: string): Promise<void> {
  console.log(`\n[claude-backend] ── one-shot ─────────────`);
  console.log(`[claude-backend] prompt: ${JSON.stringify(prompt)}`);
  try {
    const q = query({
      prompt,
      options: { permissionMode: "bypassPermissions" },
    });
    for await (const message of q) {
      const events = mapSdkMessage(message as SDKMessage);
      for (const event of events) {
        console.log(`[claude-backend] ${event.type}`);
      }
    }
    console.log(`[claude-backend] ── one-shot complete ─────────────\n`);
  } catch (err) {
    console.error(`[claude-backend] error:`, err);
  }
}
