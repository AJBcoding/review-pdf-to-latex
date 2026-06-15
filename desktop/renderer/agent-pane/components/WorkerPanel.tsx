// WorkerPanel (X8 Stage 3) — minimal worker UI on the SDK/agent-pane route.
//
// Mirrors the pty route's worker surface (claude-pane.ts: β progress strip +
// γ tasks panel) but on the structured SDK event stream rather than raw pty
// output. One compact row per live worker session shows its lifecycle state
// and a one-line summary; expanding a row reveals its transcript and — the
// reason this stage exists — surfaces any pending tool-approval prompts so a
// worker's canUseTool no longer hangs (workers ran skip=true before because
// there was nowhere to answer). Approvals route back via the worker's own
// sessionId.

import { useState } from "react";
import {
  useWorkerStore,
  workerSummary,
  workerUiState,
  type WorkerSlice,
  type WorkerUiState,
} from "../worker-store";
import { MessageBubble } from "./MessageBubble";
import { ApprovalCard } from "./ApprovalBanner";

const STATE_ICON: Record<WorkerUiState, string> = {
  running: "⟳",
  "needs-approval": "!",
  done: "✓",
  failed: "✗",
};

function WorkerRow({ slice }: { slice: WorkerSlice }) {
  const [expanded, setExpanded] = useState(false);
  const dismissWorker = useWorkerStore((s) => s.dismissWorker);
  const ui = workerUiState(slice);
  const finished = ui === "done" || ui === "failed";

  return (
    <li className="worker-row" data-state={ui}>
      <div className="worker-row__head">
        <span className="worker-row__icon" aria-hidden="true">
          {STATE_ICON[ui]}
        </span>
        <button
          type="button"
          className="worker-row__label"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          title="Show this worker's transcript"
        >
          <span className="worker-row__name">{slice.label}</span>
          <span className="worker-row__summary">{workerSummary(slice)}</span>
        </button>
        {finished && (
          <button
            type="button"
            className="worker-row__dismiss"
            onClick={() => dismissWorker(slice.sessionId)}
            aria-label={`Dismiss ${slice.label}`}
            title="Dismiss"
          >
            ×
          </button>
        )}
      </div>

      {/* Pending approvals always surface (even when collapsed) — they need
          action regardless of whether the user has opened the transcript. */}
      {slice.pendingApprovalIds.length > 0 && (
        <div className="worker-row__approvals">
          {slice.pendingApprovalIds.map((id) => {
            const req = slice.pendingApprovals[id];
            return req ? (
              <ApprovalCard
                key={id}
                request={req}
                sessionId={slice.sessionId}
              />
            ) : null;
          })}
        </div>
      )}

      {expanded && (
        <div className="worker-row__transcript">
          {slice.messageIds.length === 0 && slice.activityIds.length === 0 ? (
            <div className="worker-row__empty">No output yet.</div>
          ) : (
            slice.messageIds.map((mid) => {
              const m = slice.messages[mid];
              return m ? <MessageBubble key={mid} message={m} /> : null;
            })
          )}
        </div>
      )}
    </li>
  );
}

export function WorkerPanel() {
  const workerIds = useWorkerStore((s) => s.workerIds);
  const workers = useWorkerStore((s) => s.workers);

  if (workerIds.length === 0) return null;

  return (
    <section className="worker-panel" aria-label="Worker sessions">
      <div className="worker-panel__title">Workers</div>
      <ul className="worker-panel__list">
        {workerIds.map((id) => {
          const slice = workers[id];
          return slice ? <WorkerRow key={id} slice={slice} /> : null;
        })}
      </ul>
    </section>
  );
}
