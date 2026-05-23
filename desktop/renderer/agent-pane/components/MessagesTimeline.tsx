import { useEffect, useRef } from "react";
import { useTimeline } from "../timeline";
import { useStore } from "../store";
import { MessageBubble } from "./MessageBubble";
import { WorkGroup } from "./WorkGroup";
import { WorkingIndicator } from "./WorkingIndicator";

export function MessagesTimeline() {
  const entries = useTimeline();
  const busy = useStore((s) => s.busy);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Show "working" placeholder when busy and the last entry isn't already
  // a fresh assistant message (so we don't double up while assistant is
  // mid-streaming or has just finished). Cheap approximation: any time
  // busy is true and the last entry is a user message or work group.
  const lastEntry = entries[entries.length - 1];
  const showWorking =
    busy &&
    (!lastEntry ||
      lastEntry.kind === "workGroup" ||
      (lastEntry.kind === "message" && lastEntry.data.role === "user"));

  // Auto-scroll to bottom on new entries or working flicker.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length, showWorking]);

  if (entries.length === 0 && !showWorking) {
    return (
      <div className="timeline timeline--empty" ref={scrollRef}>
        <div className="timeline__placeholder">
          No messages yet. Send something to start.
        </div>
      </div>
    );
  }

  return (
    <div className="timeline" ref={scrollRef}>
      {entries.map((entry) =>
        entry.kind === "message" ? (
          <MessageBubble key={entry.id} message={entry.data} />
        ) : (
          <WorkGroup key={entry.id} activities={entry.data} />
        ),
      )}
      {showWorking && <WorkingIndicator />}
    </div>
  );
}
