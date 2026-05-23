// Zustand store. Mirrors t3's per-thread state shape (apps/web/src/store.ts
// `EnvironmentState.threadSessionById` / `messagesByThreadId` / activity
// slices) but for a single session — multi-session lands at Project 3 when
// we add column layout.
//
// M5: persists the transcript to localStorage so the conversation survives
// reloads and full app restarts. The main process separately persists the
// session_id and uses it to resume Claude's context.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  BackendEvent,
  ChatMessage,
  PermissionRequest,
  SessionInfo,
  ThreadActivity,
  TurnDone,
} from "@shared/agent-pane/types";

export type DisplayMode = "phone" | "t3";

interface State {
  messages: Record<string, ChatMessage>;
  messageIds: string[];
  activities: Record<string, ThreadActivity>;
  activityIds: string[];
  session: SessionInfo | null;
  busy: boolean;
  lastTurn: TurnDone | null;
  displayMode: DisplayMode;
  /** Tool-use prompts awaiting user approve/deny. */
  pendingApprovals: Record<string, PermissionRequest>;
  pendingApprovalIds: string[];
  /** User's chosen model. Takes precedence over session.model in the UI
   * and is passed through on agent:send so a fresh session starts with
   * the right model rather than the SDK default. */
  selectedModel?: string;
}

interface Actions {
  apply: (event: BackendEvent) => void;
  pushUserMessage: (text: string) => void;
  markBusy: (busy: boolean) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setSelectedModel: (modelId: string) => void;
  /** Wipe transcript + session info. Caller is responsible for telling
   * the main process to close + clear its saved session_id. */
  resetTranscript: () => void;
}

const initialState: State = {
  messages: {},
  messageIds: [],
  activities: {},
  activityIds: [],
  session: null,
  busy: false,
  lastTurn: null,
  displayMode: "phone",
  pendingApprovals: {},
  pendingApprovalIds: [],
};

function appendOrdered<T extends { id: string; createdAt: string }>(
  map: Record<string, T>,
  ids: string[],
  item: T,
): { map: Record<string, T>; ids: string[] } {
  if (map[item.id]) {
    return { map: { ...map, [item.id]: item }, ids };
  }
  return { map: { ...map, [item.id]: item }, ids: [...ids, item.id] };
}

// Merge a ChatMessage into the store, with t3-style streaming semantics
// (apps/web/src/store.ts:1370-1458): if both existing and incoming are
// `streaming`, concatenate text — the SDK ships per-delta chunks, not
// cumulative snapshots. Otherwise replace (the authoritative full
// assistant message ends streaming and overwrites the partial).
function mergeMessage(
  messages: Record<string, ChatMessage>,
  ids: string[],
  incoming: ChatMessage,
): { messages: Record<string, ChatMessage>; ids: string[] } {
  const existing = messages[incoming.id];
  if (!existing) {
    return {
      messages: { ...messages, [incoming.id]: incoming },
      ids: [...ids, incoming.id],
    };
  }
  const merged: ChatMessage =
    existing.streaming && incoming.streaming
      ? { ...incoming, text: existing.text + incoming.text, createdAt: existing.createdAt }
      : { ...incoming, createdAt: existing.createdAt };
  return { messages: { ...messages, [incoming.id]: merged }, ids };
}

export const useStore = create<State & Actions>()(
  persist(
    (set) => ({
      ...initialState,

      apply: (event) =>
        set((state) => {
          switch (event.type) {
            case "session":
              // Merge — don't replace — so fields set by earlier events
              // (model, cwd from system.init) survive a later partial
              // update (e.g. result emitting status="ready" only).
              return {
                session: { ...(state.session ?? {}), ...event.session },
              };
            case "message": {
              const { messages, ids } = mergeMessage(
                state.messages,
                state.messageIds,
                event.message,
              );
              return { messages, messageIds: ids };
            }
            case "activity": {
              const { map, ids } = appendOrdered(
                state.activities,
                state.activityIds,
                event.activity,
              );
              return { activities: map, activityIds: ids };
            }
            case "turnDone":
              return { busy: false, lastTurn: event.turnDone };
            case "permissionRequest": {
              const req = event.request;
              if (state.pendingApprovals[req.toolUseId]) return {};
              return {
                pendingApprovals: {
                  ...state.pendingApprovals,
                  [req.toolUseId]: req,
                },
                pendingApprovalIds: [
                  ...state.pendingApprovalIds,
                  req.toolUseId,
                ],
              };
            }
            case "permissionResolved": {
              if (!state.pendingApprovals[event.toolUseId]) return {};
              const next = { ...state.pendingApprovals };
              delete next[event.toolUseId];
              return {
                pendingApprovals: next,
                pendingApprovalIds: state.pendingApprovalIds.filter(
                  (id) => id !== event.toolUseId,
                ),
              };
            }
            default:
              return {};
          }
        }),

      pushUserMessage: (text) =>
        set((state) => {
          const id = `local-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const message: ChatMessage = {
            id,
            role: "user",
            text,
            createdAt: new Date().toISOString(),
          };
          const { map, ids } = appendOrdered(state.messages, state.messageIds, message);
          return { messages: map, messageIds: ids, busy: true };
        }),

      markBusy: (busy) => set({ busy }),

      setDisplayMode: (mode) => set({ displayMode: mode }),

      setSelectedModel: (modelId) => set({ selectedModel: modelId }),

      resetTranscript: () =>
        set((state) => ({
          ...initialState,
          // Preserve display + model preferences across resets.
          displayMode: state.displayMode,
          selectedModel: state.selectedModel,
        })),
    }),
    {
      name: "agent-viewer.store",
      storage: createJSONStorage(() => localStorage),
      // `busy` and `pendingApprovals` are transient — never restore them
      // after a reload (the in-flight turn from the prior process is gone).
      partialize: (state) => ({
        messages: state.messages,
        messageIds: state.messageIds,
        activities: state.activities,
        activityIds: state.activityIds,
        session: state.session,
        lastTurn: state.lastTurn,
        displayMode: state.displayMode,
        selectedModel: state.selectedModel,
      }),
    },
  ),
);
