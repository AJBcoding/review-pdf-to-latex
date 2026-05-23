// Merge messages + activities into one chronological timeline.
// Mirrors t3's MessagesTimeline row construction: messages flow inline,
// consecutive activities get grouped into a single "workGroup" card.

import { useMemo } from "react";
import { useStore } from "./store";
import type { ChatMessage, ThreadActivity } from "@shared/agent-pane/types";

export type TimelineEntry =
  | { kind: "message"; id: string; createdAt: string; data: ChatMessage }
  | {
      kind: "workGroup";
      id: string;
      createdAt: string;
      data: ThreadActivity[];
    };

interface RawEntry {
  kind: "message" | "activity";
  id: string;
  createdAt: string;
  data: ChatMessage | ThreadActivity;
}

/**
 * Pure timeline derivation — extracted from the hook so it's unit-testable
 * without React. The hook just memoizes the call.
 */
export function buildTimeline(input: {
  messageIds: readonly string[];
  activityIds: readonly string[];
  messages: Record<string, ChatMessage>;
  activities: Record<string, ThreadActivity>;
  displayMode: "phone" | "t3";
}): TimelineEntry[] {
  const raw: RawEntry[] = [];
  for (const id of input.messageIds) {
    const m = input.messages[id];
    if (m) raw.push({ kind: "message", id, createdAt: m.createdAt, data: m });
  }
  // In phone mode, hide all activities (tool calls, rate limits, etc.) —
  // clean iOS-style view, just user + assistant.
  if (input.displayMode === "t3") {
    for (const id of input.activityIds) {
      const a = input.activities[id];
      if (a) raw.push({ kind: "activity", id, createdAt: a.createdAt, data: a });
    }
  }
  raw.sort((a, b) => {
    const cmp = a.createdAt.localeCompare(b.createdAt);
    if (cmp !== 0) return cmp;
    // Stable tiebreaker: messages before activities within the same ms.
    if (a.kind !== b.kind) return a.kind === "message" ? -1 : 1;
    return 0;
  });

  // Group consecutive activities into workGroup entries (matches t3's
  // WorkGroupSection grouping pattern). Messages always remain individual.
  const entries: TimelineEntry[] = [];
  let pendingGroup: ThreadActivity[] = [];
  const flushGroup = (): void => {
    if (pendingGroup.length === 0) return;
    const first = pendingGroup[0]!;
    entries.push({
      kind: "workGroup",
      id: `wg-${first.id}`,
      createdAt: first.createdAt,
      data: pendingGroup,
    });
    pendingGroup = [];
  };
  for (const e of raw) {
    if (e.kind === "message") {
      flushGroup();
      entries.push({
        kind: "message",
        id: e.id,
        createdAt: e.createdAt,
        data: e.data as ChatMessage,
      });
    } else {
      pendingGroup.push(e.data as ThreadActivity);
    }
  }
  flushGroup();
  return entries;
}

export function useTimeline(): TimelineEntry[] {
  const messageIds = useStore((s) => s.messageIds);
  const activityIds = useStore((s) => s.activityIds);
  const messages = useStore((s) => s.messages);
  const activities = useStore((s) => s.activities);
  const displayMode = useStore((s) => s.displayMode);

  return useMemo(
    () =>
      buildTimeline({
        messageIds,
        activityIds,
        messages,
        activities,
        displayMode,
      }),
    [messageIds, activityIds, messages, activities, displayMode],
  );
}
