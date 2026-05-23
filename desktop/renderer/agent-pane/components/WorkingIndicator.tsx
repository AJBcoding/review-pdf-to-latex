// "Working…" placeholder shown when the agent is mid-turn but hasn't
// emitted text yet. Mirrors t3's WorkingTimelineRow (apps/web/src/
// components/chat/MessagesTimeline.tsx:508) — three pulse dots with
// staggered animation delays.

export function WorkingIndicator() {
  return (
    <div className="working" aria-label="claude is working" role="status">
      <span className="working__dots">
        <span className="working__dot" />
        <span className="working__dot" />
        <span className="working__dot" />
      </span>
      <span className="working__label">working</span>
    </div>
  );
}
