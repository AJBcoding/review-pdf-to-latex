import { useStore } from "../store";
import { agentViewer } from "../ipc-client";

/**
 * Top control bar — `new` + `phone/t3` toggle only. Lives above the
 * messages timeline. Status info (state, model, session, cost) is
 * rendered at the bottom by StatusFooter so it doesn't fight for
 * vertical real estate with the conversation.
 */
export function StatusBar() {
  const displayMode = useStore((s) => s.displayMode);
  const setDisplayMode = useStore((s) => s.setDisplayMode);
  const resetTranscript = useStore((s) => s.resetTranscript);

  const onNewSession = (): void => {
    const ok = window.confirm(
      "Start a new session? This clears the transcript and forgets the resume token.",
    );
    if (!ok) return;
    resetTranscript();
    void agentViewer.newSession();
  };

  return (
    <div className="statusbar statusbar--top" role="toolbar" aria-label="session controls">
      <span className="statusbar__spacer" />
      <button
        type="button"
        className="statusbar__btn"
        onClick={onNewSession}
        title="Clear transcript and start a fresh session"
        aria-label="new session"
      >
        new
      </button>
      <button
        type="button"
        className="statusbar__btn"
        onClick={() => setDisplayMode(displayMode === "phone" ? "t3" : "phone")}
        title="Toggle between phone (clean iOS-style) and t3 (with tool work groups) views"
        aria-label={`switch to ${displayMode === "phone" ? "t3" : "phone"} view`}
      >
        {displayMode === "phone" ? "🔧 t3" : "📱 phone"}
      </button>
    </div>
  );
}
