// @vitest-environment jsdom
//
// Unit tests for the worker-session store (X8 Stage 3). Covers lazy
// auto-registration, per-worker event routing/isolation, approval add/resolve
// scoped to a worker, busy/turnDone lifecycle, and the derived UI helpers
// (workerUiState / workerLabel / workerSummary).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useWorkerStore,
  workerLabel,
  workerSummary,
  workerUiState,
  type WorkerSlice,
} from "./worker-store";
import type {
  BackendEvent,
  ChatMessage,
  PermissionRequest,
  SessionInfo,
  ThreadActivity,
  TurnDone,
} from "@shared/agent-pane/types";

// ─── Fixture builders ───────────────────────────────────────────────────

function msg(input: {
  id: string;
  role?: ChatMessage["role"];
  text?: string;
  createdAt?: string;
  streaming?: boolean;
}): ChatMessage {
  return {
    id: input.id,
    role: input.role ?? "assistant",
    text: input.text ?? `text-${input.id}`,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00Z",
    streaming: input.streaming ?? false,
  };
}

function act(input: { id: string; summary?: string }): ThreadActivity {
  return {
    id: input.id,
    tone: "info",
    kind: "tool.started",
    summary: input.summary ?? `s-${input.id}`,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function permission(input: {
  toolUseId: string;
  toolName?: string;
}): PermissionRequest {
  return {
    toolUseId: input.toolUseId,
    toolName: input.toolName ?? "Bash",
    input: { command: "ls" },
    createdAt: "2026-01-01T00:00:00Z",
  };
}

function session(
  input: Partial<SessionInfo> & { sessionId: string },
): SessionInfo {
  return {
    sessionId: input.sessionId,
    status: input.status ?? "running",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00Z",
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
  };
}

function turnDone(input: Partial<TurnDone> & { sessionId: string }): TurnDone {
  return {
    sessionId: input.sessionId,
    success: input.success ?? true,
    ...(input.numTurns !== undefined ? { numTurns: input.numTurns } : {}),
  };
}

function apply(sessionId: string, event: BackendEvent): void {
  useWorkerStore.getState().applyWorkerEvent(sessionId, event);
}

function get(sessionId: string): WorkerSlice {
  const s = useWorkerStore.getState().workers[sessionId];
  if (!s) throw new Error(`no worker slice for ${sessionId}`);
  return s;
}

function resetStore(): void {
  useWorkerStore.setState({ workers: {}, workerIds: [] });
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe("worker-store", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  describe("lazy auto-registration", () => {
    it("creates a slice on the first event for an unknown worker", () => {
      apply("worker-ctx-1", {
        type: "session",
        session: session({ sessionId: "sess-x" }),
        sessionId: "worker-ctx-1",
      });
      const st = useWorkerStore.getState();
      expect(st.workerIds).toEqual(["worker-ctx-1"]);
      expect(get("worker-ctx-1").label).toBe("Context 1");
    });

    it("registers workers in spawn order with incrementing labels", () => {
      apply("worker-ctx-1", {
        type: "session",
        session: session({ sessionId: "a" }),
      });
      apply("worker-sling-2", {
        type: "session",
        session: session({ sessionId: "b" }),
      });
      const st = useWorkerStore.getState();
      expect(st.workerIds).toEqual(["worker-ctx-1", "worker-sling-2"]);
      expect(get("worker-ctx-1").label).toBe("Context 1");
      expect(get("worker-sling-2").label).toBe("Sling 2");
    });

    it("seeds startedAt from the session event's updatedAt", () => {
      apply("worker-ctx-1", {
        type: "session",
        session: session({ sessionId: "a", updatedAt: "2026-02-02T00:00:00Z" }),
      });
      expect(get("worker-ctx-1").startedAt).toBe("2026-02-02T00:00:00Z");
    });
  });

  describe("per-worker isolation", () => {
    it("routes messages to the correct worker slice", () => {
      apply("wk-a", { type: "message", message: msg({ id: "m1", text: "from A" }) });
      apply("wk-b", { type: "message", message: msg({ id: "m2", text: "from B" }) });
      expect(get("wk-a").messageIds).toEqual(["m1"]);
      expect(get("wk-b").messageIds).toEqual(["m2"]);
      expect(get("wk-a").messages.m1?.text).toBe("from A");
      expect(get("wk-b").messages.m2?.text).toBe("from B");
    });

    it("concatenates streaming chunks within one worker (reuses mergeMessage)", () => {
      apply("wk-a", {
        type: "message",
        message: msg({ id: "m1", text: "hel", streaming: true }),
      });
      apply("wk-a", {
        type: "message",
        message: msg({ id: "m1", text: "lo", streaming: true }),
      });
      expect(get("wk-a").messages.m1?.text).toBe("hello");
      expect(get("wk-a").messageIds).toEqual(["m1"]);
    });

    it("appends activities in order", () => {
      apply("wk-a", { type: "activity", activity: act({ id: "a1" }) });
      apply("wk-a", { type: "activity", activity: act({ id: "a2" }) });
      expect(get("wk-a").activityIds).toEqual(["a1", "a2"]);
    });
  });

  describe("approvals scoped per worker", () => {
    it("adds a pending approval to the targeted worker only", () => {
      apply("wk-a", {
        type: "permissionRequest",
        request: permission({ toolUseId: "t1" }),
      });
      apply("wk-b", {
        type: "session",
        session: session({ sessionId: "b" }),
      });
      expect(get("wk-a").pendingApprovalIds).toEqual(["t1"]);
      expect(get("wk-b").pendingApprovalIds).toEqual([]);
    });

    it("deduplicates a re-emitted approval", () => {
      apply("wk-a", {
        type: "permissionRequest",
        request: permission({ toolUseId: "t1" }),
      });
      apply("wk-a", {
        type: "permissionRequest",
        request: permission({ toolUseId: "t1", toolName: "Write" }),
      });
      expect(get("wk-a").pendingApprovalIds).toEqual(["t1"]);
      expect(get("wk-a").pendingApprovals.t1?.toolName).toBe("Bash");
    });

    it("removes a pending approval on permissionResolved", () => {
      apply("wk-a", {
        type: "permissionRequest",
        request: permission({ toolUseId: "t1" }),
      });
      apply("wk-a", {
        type: "permissionRequest",
        request: permission({ toolUseId: "t2" }),
      });
      apply("wk-a", { type: "permissionResolved", toolUseId: "t1" });
      expect(get("wk-a").pendingApprovalIds).toEqual(["t2"]);
    });

    it("permissionResolved is a no-op for an unknown toolUseId", () => {
      apply("wk-a", { type: "session", session: session({ sessionId: "a" }) });
      apply("wk-a", { type: "permissionResolved", toolUseId: "nope" });
      expect(get("wk-a").pendingApprovalIds).toEqual([]);
    });
  });

  describe("busy / turnDone lifecycle", () => {
    it("starts busy on spawn and clears on turnDone", () => {
      apply("wk-a", { type: "session", session: session({ sessionId: "a" }) });
      expect(get("wk-a").busy).toBe(true);
      apply("wk-a", {
        type: "turnDone",
        turnDone: turnDone({ sessionId: "a", success: true, numTurns: 2 }),
      });
      expect(get("wk-a").busy).toBe(false);
      expect(get("wk-a").lastTurn?.numTurns).toBe(2);
    });

    it("a message after turnDone marks the worker busy again", () => {
      apply("wk-a", {
        type: "turnDone",
        turnDone: turnDone({ sessionId: "a" }),
      });
      expect(get("wk-a").busy).toBe(false);
      apply("wk-a", { type: "message", message: msg({ id: "m1" }) });
      expect(get("wk-a").busy).toBe(true);
    });
  });

  describe("dismissWorker", () => {
    it("removes the worker from the store", () => {
      apply("wk-a", { type: "session", session: session({ sessionId: "a" }) });
      apply("wk-b", { type: "session", session: session({ sessionId: "b" }) });
      useWorkerStore.getState().dismissWorker("wk-a");
      const st = useWorkerStore.getState();
      expect(st.workerIds).toEqual(["wk-b"]);
      expect(st.workers["wk-a"]).toBeUndefined();
    });

    it("is a no-op for an unknown worker", () => {
      apply("wk-a", { type: "session", session: session({ sessionId: "a" }) });
      useWorkerStore.getState().dismissWorker("ghost");
      expect(useWorkerStore.getState().workerIds).toEqual(["wk-a"]);
    });
  });

  describe("workerLabel", () => {
    it("maps id prefixes to kind words + 1-based index", () => {
      expect(workerLabel("worker-ctx-99", 0)).toBe("Context 1");
      expect(workerLabel("worker-sling-99", 1)).toBe("Sling 2");
      expect(workerLabel("something-else", 2)).toBe("Worker 3");
    });
  });

  describe("workerUiState", () => {
    function slice(over: Partial<WorkerSlice>): WorkerSlice {
      return {
        sessionId: "wk",
        label: "Worker 1",
        status: "running",
        busy: false,
        startedAt: "2026-01-01T00:00:00Z",
        messages: {},
        messageIds: [],
        activities: {},
        activityIds: [],
        pendingApprovals: {},
        pendingApprovalIds: [],
        lastTurn: null,
        ...over,
      };
    }

    it("needs-approval takes precedence over everything", () => {
      expect(
        workerUiState(
          slice({ busy: true, pendingApprovalIds: ["t1"] }),
        ),
      ).toBe("needs-approval");
    });

    it("running while busy", () => {
      expect(workerUiState(slice({ busy: true }))).toBe("running");
    });

    it("failed on error status or unsuccessful turn", () => {
      expect(workerUiState(slice({ status: "error" }))).toBe("failed");
      expect(
        workerUiState(
          slice({ lastTurn: turnDone({ sessionId: "a", success: false }) }),
        ),
      ).toBe("failed");
    });

    it("done after a successful turn", () => {
      expect(
        workerUiState(
          slice({ lastTurn: turnDone({ sessionId: "a", success: true }) }),
        ),
      ).toBe("done");
    });

    it("running before any turn (just spun up)", () => {
      expect(workerUiState(slice({}))).toBe("running");
    });
  });

  describe("workerSummary", () => {
    function slice(over: Partial<WorkerSlice>): WorkerSlice {
      return {
        sessionId: "wk",
        label: "Worker 1",
        status: "running",
        busy: false,
        startedAt: "2026-01-01T00:00:00Z",
        messages: {},
        messageIds: [],
        activities: {},
        activityIds: [],
        pendingApprovals: {},
        pendingApprovalIds: [],
        lastTurn: null,
        ...over,
      };
    }

    it("reports a pending-approval count first", () => {
      expect(
        workerSummary(slice({ pendingApprovalIds: ["t1", "t2"] })),
      ).toBe("awaiting approval (2)");
    });

    it("prefers the latest assistant message text (first line, trimmed)", () => {
      expect(
        workerSummary(
          slice({
            messages: {
              m1: msg({ id: "m1", role: "assistant", text: "doing the work\nmore" }),
            },
            messageIds: ["m1"],
          }),
        ),
      ).toBe("doing the work");
    });

    it("falls back to the last activity summary", () => {
      expect(
        workerSummary(
          slice({
            activities: { a1: act({ id: "a1", summary: "running build" }) },
            activityIds: ["a1"],
          }),
        ),
      ).toBe("running build");
    });
  });
});
