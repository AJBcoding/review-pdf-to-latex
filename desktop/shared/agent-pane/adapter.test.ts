import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mapSdkMessage, categoryForToolName } from "./adapter.js";
import type { BackendEvent } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): SDKMessage[] {
  const path = join(__dirname, "__fixtures__", name);
  return JSON.parse(readFileSync(path, "utf-8")) as SDKMessage[];
}

function makeDeterministicDeps() {
  let n = 0;
  return {
    nowIso: () => "2026-05-22T18:00:00.000Z",
    nextId: () => `id-${++n}`,
    state: { currentStreamingMessageId: null as string | null },
  };
}

function runFixture(name: string): BackendEvent[] {
  const messages = loadFixture(name);
  const deps = makeDeterministicDeps();
  return messages.flatMap((m) => mapSdkMessage(m, deps));
}

describe("mapSdkMessage — simple hello", () => {
  it("produces session-running, ignores rate_limit summary text, emits assistant message, and ends with turnDone+session-ready", () => {
    const events = runFixture("simple-hello.json");

    expect(events.map((e) => e.type)).toEqual([
      "session",
      "activity",
      "message",
      "turnDone",
      "session",
    ]);

    const first = events[0];
    expect(first.type).toBe("session");
    if (first.type === "session") {
      expect(first.session.sessionId).toBe("sess-001");
      expect(first.session.status).toBe("running");
      expect(first.session.model).toBe("claude-opus-4-7");
    }

    const rateLimit = events[1];
    expect(rateLimit.type).toBe("activity");
    if (rateLimit.type === "activity") {
      expect(rateLimit.activity.kind).toBe("rate_limit");
      expect(rateLimit.activity.tone).toBe("info");
    }

    const message = events[2];
    expect(message.type).toBe("message");
    if (message.type === "message") {
      expect(message.message.role).toBe("assistant");
      expect(message.message.text).toBe("Hi! How can I help you today?");
      // Assistant messages now key on the API-level message.id (msg_xxx),
      // which is what stream_event partials carry too. The fixture's
      // top-level uuid stays as the SDK's per-chunk tracing id.
      expect(message.message.id).toBe("msg_a1");
      expect(message.message.parentToolUseId).toBeNull();
    }

    const turnDone = events[3];
    expect(turnDone.type).toBe("turnDone");
    if (turnDone.type === "turnDone") {
      expect(turnDone.turnDone.success).toBe(true);
      expect(turnDone.turnDone.numTurns).toBe(1);
      expect(turnDone.turnDone.totalCostUsd).toBeCloseTo(0.2183, 4);
      expect(turnDone.turnDone.stopReason).toBe("end_turn");
    }

    const sessionReady = events[4];
    expect(sessionReady.type).toBe("session");
    if (sessionReady.type === "session") {
      expect(sessionReady.session.status).toBe("ready");
    }
  });
});

describe("mapSdkMessage — tool-call cycle", () => {
  it("splits assistant text+tool_use into one message and one activity", () => {
    const events = runFixture("tool-cycle.json");

    // session, [tool_use activity + text message from first assistant],
    // tool_result activity from user, second assistant text message,
    // turnDone + session-ready.
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "activity",
      "message",
      "activity",
      "message",
      "turnDone",
      "session",
    ]);

    const toolStarted = events[1];
    expect(toolStarted.type).toBe("activity");
    if (toolStarted.type === "activity") {
      expect(toolStarted.activity.kind).toBe("tool.started");
      expect(toolStarted.activity.tone).toBe("tool");
      expect(toolStarted.activity.summary).toBe("Bash: echo hello-from-bash");
      expect(toolStarted.activity.id).toBe("toolu_017Xabc");
      // Semantic category is set on tool.started for icon dispatch.
      expect(toolStarted.activity.category).toBe("command");
    }

    const firstAssistant = events[2];
    expect(firstAssistant.type).toBe("message");
    if (firstAssistant.type === "message") {
      expect(firstAssistant.message.text).toBe("Let me check that for you.");
    }

    const toolCompleted = events[3];
    expect(toolCompleted.type).toBe("activity");
    if (toolCompleted.type === "activity") {
      expect(toolCompleted.activity.kind).toBe("tool.completed");
      expect(toolCompleted.activity.summary).toBe("hello-from-bash");
    }

    const secondAssistant = events[4];
    expect(secondAssistant.type).toBe("message");
    if (secondAssistant.type === "message") {
      expect(secondAssistant.message.text).toBe(
        "Done. The command printed: hello-from-bash",
      );
    }
  });

  it("does NOT emit a user ChatMessage for synthetic tool_result wrappers", () => {
    const events = runFixture("tool-cycle.json");
    const userMessages = events.filter(
      (e) => e.type === "message" && e.message.role === "user",
    );
    expect(userMessages).toHaveLength(0);
  });
});

describe("mapSdkMessage — error result", () => {
  it("emits turnDone with success=false and session status=error", () => {
    const events = runFixture("error-result.json");
    expect(events.map((e) => e.type)).toEqual(["session", "turnDone", "session"]);

    const turnDone = events[1];
    expect(turnDone.type).toBe("turnDone");
    if (turnDone.type === "turnDone") {
      expect(turnDone.turnDone.success).toBe(false);
      expect(turnDone.turnDone.lastError).toBe("error_max_turns");
      expect(turnDone.turnDone.terminalReason).toBe("max_turns");
    }

    const session = events[2];
    expect(session.type).toBe("session");
    if (session.type === "session") {
      expect(session.session.status).toBe("error");
      expect(session.session.lastError).toBe("error_max_turns");
    }
  });
});

describe("categoryForToolName", () => {
  it("classifies common tools by canonical name", () => {
    expect(categoryForToolName("Bash")).toBe("command");
    expect(categoryForToolName("Read")).toBe("file-read");
    expect(categoryForToolName("Edit")).toBe("file-change");
    expect(categoryForToolName("Write")).toBe("file-change");
    expect(categoryForToolName("WebFetch")).toBe("web");
    expect(categoryForToolName("WebSearch")).toBe("web");
    expect(categoryForToolName("Glob")).toBe("search");
    expect(categoryForToolName("Grep")).toBe("search");
  });

  it("classifies MCP tools via the prefix convention", () => {
    expect(categoryForToolName("mcp__filesystem__read")).toBe("mcp");
    expect(categoryForToolName("mcp__playwright__click")).toBe("mcp");
  });

  it("falls back to 'other' for unknown tools and undefined", () => {
    expect(categoryForToolName(undefined)).toBe("other");
    expect(categoryForToolName("something_new")).toBe("other");
  });
});

describe("mapSdkMessage — streaming partials", () => {
  it("captures message id from message_start and reuses it for every delta + the final assistant message", () => {
    const events = runFixture("streaming-hello.json");

    // session(running), 3 partials (one per text_delta), full assistant
    // message, turnDone, session(ready). message_start/stop and
    // content_block_start/stop are state-only and emit no events.
    expect(events.map((e) => e.type)).toEqual([
      "session",
      "message",
      "message",
      "message",
      "message",
      "turnDone",
      "session",
    ]);

    const partials = events.slice(1, 4);
    const partialMessages = partials.map((e) => {
      if (e.type !== "message") throw new Error("expected message event");
      return e.message;
    });
    expect(partialMessages.map((m) => m.text)).toEqual(["Hi", "! How", " can I help?"]);
    // All partials share the API-level message id captured from
    // message_start. NOT each stream_event's per-chunk uuid.
    for (const m of partialMessages) {
      expect(m.id).toBe("msg_stream_a1");
      expect(m.role).toBe("assistant");
      expect(m.streaming).toBe(true);
    }

    const full = events[4];
    if (full.type !== "message") throw new Error("expected final assistant message");
    // Full message uses msg.message.id — same as the partials, so the
    // store can merge them into a single ChatMessage.
    expect(full.message.id).toBe("msg_stream_a1");
    expect(full.message.text).toBe("Hi! How can I help?");
    expect(full.message.streaming).toBeUndefined();
  });

  it("falls back to msg.uuid when no AdapterState is threaded (caller hasn't migrated)", () => {
    // Same fixture, but call mapSdkMessage WITHOUT state — simulates a
    // caller that hasn't started passing state yet. Partials end up with
    // their per-chunk uuids and won't merge, but the call doesn't throw.
    const messages = loadFixture("streaming-hello.json");
    const events = messages.flatMap((m) =>
      mapSdkMessage(m, {
        nowIso: () => "2026-05-22T18:00:00.000Z",
        nextId: () => "id-x",
      }),
    );
    const partials = events.filter(
      (e) => e.type === "message" && e.message.streaming === true,
    );
    expect(partials).toHaveLength(3);
    // Each partial keyed on its per-chunk uuid → won't merge in the store.
    expect(
      partials.map((e) => (e.type === "message" ? e.message.id : "")),
    ).toEqual(["uuid-chunk-3", "uuid-chunk-4", "uuid-chunk-5"]);
  });

  it("ignores non-text stream_event deltas (thinking, input_json, etc.)", () => {
    const msg = {
      type: "stream_event",
      session_id: "sess-x",
      parent_tool_use_id: null,
      uuid: "uuid-x",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "…" },
      },
    } as unknown as SDKMessage;
    expect(mapSdkMessage(msg, makeDeterministicDeps())).toEqual([]);
  });

  it("ignores stream_event content_block_start/stop framing", () => {
    const start = {
      type: "stream_event",
      session_id: "sess-x",
      parent_tool_use_id: null,
      uuid: "uuid-x",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    } as unknown as SDKMessage;
    const stop = {
      type: "stream_event",
      session_id: "sess-x",
      parent_tool_use_id: null,
      uuid: "uuid-x",
      event: { type: "content_block_stop", index: 0 },
    } as unknown as SDKMessage;
    expect(mapSdkMessage(start, makeDeterministicDeps())).toEqual([]);
    expect(mapSdkMessage(stop, makeDeterministicDeps())).toEqual([]);
  });
});

describe("mapSdkMessage — edge cases", () => {
  it("emits a user ChatMessage for plain string content (non-synthetic)", () => {
    const msg = {
      type: "user",
      message: { role: "user", content: "Hello, claude!" },
      parent_tool_use_id: null,
      session_id: "sess-x",
      uuid: "uuid-user-x",
    } as unknown as SDKMessage;

    const events = mapSdkMessage(msg, makeDeterministicDeps());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("message");
    if (events[0].type === "message") {
      expect(events[0].message.role).toBe("user");
      expect(events[0].message.text).toBe("Hello, claude!");
    }
  });

  it("ignores unknown SDK message types without throwing", () => {
    const msg = {
      type: "task_started",
      session_id: "sess-x",
    } as unknown as SDKMessage;
    expect(mapSdkMessage(msg, makeDeterministicDeps())).toEqual([]);
  });

  it("emits compact_boundary as an info activity", () => {
    const msg = {
      type: "system",
      subtype: "compact_boundary",
      session_id: "sess-x",
    } as unknown as SDKMessage;
    const events = mapSdkMessage(msg, makeDeterministicDeps());
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("activity");
    if (events[0].type === "activity") {
      expect(events[0].activity.kind).toBe("compact_boundary");
      expect(events[0].activity.tone).toBe("info");
    }
  });
});
