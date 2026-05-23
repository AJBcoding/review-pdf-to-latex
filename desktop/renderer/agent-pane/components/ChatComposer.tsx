import { useState, useRef, useEffect } from "react";
import { useStore } from "../store";
import { agentViewer } from "../ipc-client";

interface Props {
  /** Called when the user submits. M4: dispatches IPC to main. */
  onSubmit: (text: string) => void;
}

const MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
];

export function ChatComposer({ onSubmit }: Props) {
  const [text, setText] = useState("");
  const busy = useStore((s) => s.busy);
  const markBusy = useStore((s) => s.markBusy);
  const sessionModel = useStore((s) => s.session?.model);
  const selectedModel = useStore((s) => s.selectedModel);
  const setSelectedModel = useStore((s) => s.setSelectedModel);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Precedence: the user's explicit pick > what the SDK reports for the live
  // session > Opus default (so the dropdown isn't empty before first send).
  // This is what closes the pre-session UX gap — picking Sonnet before the
  // first message used to be silently dropped because the backend setModel
  // call no-ops when there's no Query yet. Now we persist the pick locally
  // and thread it through agent:send so a fresh session starts with the
  // right model.
  const currentModel =
    MODEL_OPTIONS.find((m) => m.id === (selectedModel ?? sessionModel))?.id ??
    MODEL_OPTIONS[0].id;

  // Autosize textarea up to ~6 rows.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  }, [text]);

  const canSend = text.trim().length > 0 && !busy;

  const send = (): void => {
    const t = text.trim();
    if (!t || busy) return;
    onSubmit(t);
    setText("");
  };

  const interrupt = (): void => {
    void agentViewer.interrupt();
    // Optimistically clear busy — backend's turnDone will also clear it.
    markBusy(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== "Enter") return;
    // Send on plain Enter or Cmd/Ctrl+Enter. Option+Enter or Shift+Enter
    // inserts a newline (default textarea behavior).
    if (e.altKey || e.shiftKey) return;
    e.preventDefault();
    send();
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <textarea
        ref={taRef}
        className="composer__input"
        placeholder={busy ? "claude is thinking…" : "message (enter to send, option+enter for newline)"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        disabled={busy}
      />
      <select
        className="composer__model"
        value={currentModel}
        onChange={(e) => {
          // Always store the pick locally so the UI is the source of truth.
          // The setModel IPC is best-effort: it succeeds mid-session and
          // no-ops pre-session — but agent:send below will thread the
          // selected model through on the next send so a fresh session
          // picks it up.
          setSelectedModel(e.target.value);
          void agentViewer.setModel(e.target.value);
        }}
        title="Model used for subsequent turns"
        aria-label="model"
      >
        {MODEL_OPTIONS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      {busy ? (
        <button
          type="button"
          className="composer__stop"
          onClick={interrupt}
          title="Interrupt the current turn"
          aria-label="stop"
        >
          stop
        </button>
      ) : (
        <button
          type="submit"
          className="composer__send"
          disabled={!canSend}
          aria-label="send"
        >
          send
        </button>
      )}
    </form>
  );
}
