import { useStore } from "../store";

function fmtCost(usd: number | undefined): string {
  if (typeof usd !== "number") return "";
  return `$${usd.toFixed(4)}`;
}

/**
 * Status info pinned to the bottom of the window. State dot + label,
 * model, session id prefix, last-turn cost. Read-only; the `new` and
 * display-mode controls live at the top in StatusBar so this row
 * stays passive.
 */
export function StatusFooter() {
  const session = useStore((s) => s.session);
  const busy = useStore((s) => s.busy);
  const lastTurn = useStore((s) => s.lastTurn);

  const status = busy ? "thinking…" : session?.status ?? "idle";
  const model = session?.model ?? "—";
  const sessionLabel = session?.sessionId
    ? session.sessionId.slice(0, 8)
    : "—";

  return (
    <div className="statusbar statusbar--bottom" role="status">
      <span className={`statusbar__dot statusbar__dot--${status}`} />
      <span className="statusbar__field">{status}</span>
      <span className="statusbar__sep">·</span>
      <span className="statusbar__field">{model}</span>
      <span className="statusbar__sep">·</span>
      <span className="statusbar__field">session {sessionLabel}</span>
      {lastTurn && (
        <>
          <span className="statusbar__sep">·</span>
          <span className="statusbar__field">last {fmtCost(lastTurn.totalCostUsd)}</span>
        </>
      )}
    </div>
  );
}
