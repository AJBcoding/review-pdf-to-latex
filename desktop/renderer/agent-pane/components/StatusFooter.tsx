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
    </div>
  );
}
