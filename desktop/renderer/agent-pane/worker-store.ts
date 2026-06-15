// Worker-session store (X8 Stage 3 — minimal worker UI on the SDK route).
//
// The conv store (./store.ts) tracks the single conversational session. This
// store tracks the N ephemeral worker sessions (Create Context / Sling) that
// the toolbar spawns via agent:spawnSession. It mirrors the conv store's
// reducer semantics — reusing mergeMessage/appendOrdered — but keys every
// slice by sessionId so concurrent workers stay isolated.
//
// Why a separate store rather than extending the conv one:
//   - Workers are ephemeral and never resume, so (unlike conv) we DON'T
//     persist them to localStorage.
//   - The conv UI (timeline, composer, context meter) renders a single
//     session; folding a sessionId dimension into it would churn every
//     selector. A focused worker store keeps the conv path untouched.
//
// Workers are auto-registered lazily on their first event (the SDK system.init
// `session` event), mirroring how the conv store never needs an explicit
// "register" — the first event populates it. The toolbar (plain-TS) therefore
// needs no coupling to this React store.

import { create } from "zustand";
import type {
  BackendEvent,
  ChatMessage,
  PermissionRequest,
  SessionStatus,
  ThreadActivity,
  TurnDone,
} from "@shared/agent-pane/types";
import { appendOrdered, mergeMessage } from "./store";

/** Per-worker session state. Shape parallels the conv store's slice, scoped
 * to one worker. */
export interface WorkerSlice {
  sessionId: string;
  /** User-visible label, e.g. "Context 1" / "Sling 2". */
  label: string;
  status: SessionStatus;
  /** True from spawn until the worker's turn completes. */
  busy: boolean;
  /** ISO timestamp the slice was first seen (spawn time, best-effort). */
  startedAt: string;
  messages: Record<string, ChatMessage>;
  messageIds: string[];
  activities: Record<string, ThreadActivity>;
  activityIds: string[];
  pendingApprovals: Record<string, PermissionRequest>;
  pendingApprovalIds: string[];
  lastTurn: TurnDone | null;
  lastError?: string;
}

/** Collapsed lifecycle state for the strip icon. `needs-approval` takes
 * precedence — it's the one state demanding user action (the whole reason
 * Stage 3 exists). */
export type WorkerUiState = "running" | "needs-approval" | "done" | "failed";

interface WorkerStoreState {
  workers: Record<string, WorkerSlice>;
  /** Workers in spawn order (oldest first), used for stable labels + render. */
  workerIds: string[];
}

interface WorkerStoreActions {
  /** Route a backend event (already known to target this worker) into its
   * slice, lazily creating the slice on first sight. */
  applyWorkerEvent: (sessionId: string, event: BackendEvent) => void;
  /** Drop a finished worker from the panel (user dismiss). */
  dismissWorker: (sessionId: string) => void;
}

/** Derive a human label from the worker's sessionId + spawn order. The
 * toolbar mints ids like `worker-ctx-<ts>` / `worker-sling-<ts>`; map the
 * prefix to a kind word and append the 1-based spawn index. */
export function workerLabel(sessionId: string, index: number): string {
  const n = index + 1;
  if (sessionId.startsWith("worker-sling")) return `Sling ${n}`;
  if (sessionId.startsWith("worker-ctx") || sessionId.startsWith("worker-context"))
    return `Context ${n}`;
  return `Worker ${n}`;
}

/** Collapse a worker's slice into a single lifecycle state for the strip. */
export function workerUiState(slice: WorkerSlice): WorkerUiState {
  if (slice.pendingApprovalIds.length > 0) return "needs-approval";
  if (slice.busy) return "running";
  if (slice.status === "error" || slice.lastTurn?.success === false)
    return "failed";
  if (slice.lastTurn) return "done";
  // No turn yet and not busy — still spinning up.
  return "running";
}

/** One-line status summary for the strip row: prefer a pending-approval
 * count, then the latest assistant text, then the latest activity. */
export function workerSummary(slice: WorkerSlice): string {
  if (slice.pendingApprovalIds.length > 0) {
    const n = slice.pendingApprovalIds.length;
    return `awaiting approval (${n})`;
  }
  // Last assistant message text (trimmed to one line).
  for (let i = slice.messageIds.length - 1; i >= 0; i -= 1) {
    const m = slice.messages[slice.messageIds[i]!];
    if (m && m.role === "assistant" && m.text.trim()) {
      return firstLine(m.text);
    }
  }
  // Fall back to the most recent activity summary.
  const lastActId = slice.activityIds[slice.activityIds.length - 1];
  if (lastActId) {
    const a = slice.activities[lastActId];
    if (a?.summary) return firstLine(a.summary);
  }
  if (slice.lastError) return `error: ${firstLine(slice.lastError)}`;
  return slice.busy ? "working…" : "done";
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return line.length > 120 ? line.slice(0, 117) + "…" : line;
}

function emptySlice(
  sessionId: string,
  label: string,
  startedAt: string,
): WorkerSlice {
  return {
    sessionId,
    label,
    status: "starting",
    busy: true,
    startedAt,
    messages: {},
    messageIds: [],
    activities: {},
    activityIds: [],
    pendingApprovals: {},
    pendingApprovalIds: [],
    lastTurn: null,
  };
}

/** Pure reducer: fold one event into a worker slice, returning a new slice. */
function reduceSlice(slice: WorkerSlice, event: BackendEvent): WorkerSlice {
  switch (event.type) {
    case "session":
      // Merge so earlier-set fields (model/cwd) survive a partial later update.
      return {
        ...slice,
        status: event.session.status,
        ...(event.session.lastError !== undefined
          ? { lastError: event.session.lastError }
          : {}),
      };
    case "message": {
      const { messages, ids } = mergeMessage(
        slice.messages,
        slice.messageIds,
        event.message,
      );
      // An incoming message means the worker is actively producing output.
      return { ...slice, messages, messageIds: ids, busy: true };
    }
    case "activity": {
      const { map, ids } = appendOrdered(
        slice.activities,
        slice.activityIds,
        event.activity,
      );
      return { ...slice, activities: map, activityIds: ids };
    }
    case "turnDone":
      return { ...slice, busy: false, lastTurn: event.turnDone };
    case "permissionRequest": {
      const req = event.request;
      if (slice.pendingApprovals[req.toolUseId]) return slice;
      return {
        ...slice,
        pendingApprovals: {
          ...slice.pendingApprovals,
          [req.toolUseId]: req,
        },
        pendingApprovalIds: [...slice.pendingApprovalIds, req.toolUseId],
      };
    }
    case "permissionResolved": {
      if (!slice.pendingApprovals[event.toolUseId]) return slice;
      const next = { ...slice.pendingApprovals };
      delete next[event.toolUseId];
      return {
        ...slice,
        pendingApprovals: next,
        pendingApprovalIds: slice.pendingApprovalIds.filter(
          (id) => id !== event.toolUseId,
        ),
      };
    }
    default:
      return slice;
  }
}

export const useWorkerStore = create<WorkerStoreState & WorkerStoreActions>()(
  (set) => ({
    workers: {},
    workerIds: [],

    applyWorkerEvent: (sessionId, event) =>
      set((state) => {
        const existing = state.workers[sessionId];
        if (!existing) {
          // Lazy auto-registration on first event.
          const index = state.workerIds.length;
          const startedAt =
            event.type === "session"
              ? event.session.updatedAt
              : new Date().toISOString();
          const fresh = reduceSlice(
            emptySlice(sessionId, workerLabel(sessionId, index), startedAt),
            event,
          );
          return {
            workers: { ...state.workers, [sessionId]: fresh },
            workerIds: [...state.workerIds, sessionId],
          };
        }
        const updated = reduceSlice(existing, event);
        if (updated === existing) return {};
        return { workers: { ...state.workers, [sessionId]: updated } };
      }),

    dismissWorker: (sessionId) =>
      set((state) => {
        if (!state.workers[sessionId]) return {};
        const next = { ...state.workers };
        delete next[sessionId];
        return {
          workers: next,
          workerIds: state.workerIds.filter((id) => id !== sessionId),
        };
      }),
  }),
);
