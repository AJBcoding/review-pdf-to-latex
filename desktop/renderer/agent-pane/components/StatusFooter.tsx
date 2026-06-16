import { useState, useEffect } from "react";
import { useStore } from "../store";

function fmtCost(usd: number | undefined): string {
  if (typeof usd !== "number") return "";
  return `$${usd.toFixed(4)}`;
}

function readCostPref(): boolean {
  try { return localStorage.getItem("pdf-latex-show-cost") !== "0"; }
  catch { return true; }
}

// Single writer for the cost-display pref: persist to localStorage, then
// broadcast the same event StatusFooter (and any future listener) consumes,
// so the toggle stays the one source of truth. Replaces the deleted
// bootClaudeSettings() DOM toggle (rev-3fr §1).
function writeCostPref(show: boolean): void {
  try { localStorage.setItem("pdf-latex-show-cost", show ? "1" : "0"); }
  catch { /* localStorage unavailable — event still syncs in-session */ }
  window.dispatchEvent(
    new CustomEvent("settings:cost-display-changed", { detail: { show } }),
  );
}

export function StatusFooter() {
  const session = useStore((s) => s.session);
  const busy = useStore((s) => s.busy);
  const lastTurn = useStore((s) => s.lastTurn);
  const [showCost, setShowCost] = useState(readCostPref);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { show: boolean } | undefined;
      if (detail) setShowCost(detail.show);
    };
    window.addEventListener("settings:cost-display-changed", handler);
    return () => window.removeEventListener("settings:cost-display-changed", handler);
  }, []);

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
      {showCost && lastTurn && (
        <>
          <span className="statusbar__sep">·</span>
          <span className="statusbar__field">last {fmtCost(lastTurn.totalCostUsd)}</span>
        </>
      )}
      <span className="statusbar__spacer" />
      <button
        type="button"
        className="statusbar__btn"
        aria-pressed={showCost}
        title={showCost ? "Hide per-turn cost" : "Show per-turn cost"}
        onClick={() => writeCostPref(!showCost)}
      >
        {showCost ? "$ on" : "$ off"}
      </button>
    </div>
  );
}
