// Approval card surfaced above the composer when canUseTool fires.
// Modeled on t3's ComposerPendingApprovalPanel (apps/web/src/components/
// chat/ChatComposer.tsx) but simpler — single-button approve/deny rather
// than t3's permission-rule suggestions, which the SDK only invokes when
// the user explicitly chooses "always allow."

import { useState } from "react";
import { useStore } from "../store";
import { agentViewer } from "../ipc-client";
import type { PermissionRequest } from "@shared/agent-pane/types";

function previewInput(input: Record<string, unknown>): string | null {
  // Same heuristic as adapter.ts summarizeToolUse — pick the most
  // human-relevant field for the headline.
  for (const k of ["command", "description", "path", "file_path", "query", "url"]) {
    const v = input[k];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 240 ? v.slice(0, 237) + "..." : v;
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return null;
  }
}

function ApprovalCard({ request }: { request: PermissionRequest }) {
  const [showDetails, setShowDetails] = useState(false);
  const headline =
    request.title ??
    `Claude wants to use ${request.displayName ?? request.toolName}`;
  const preview = previewInput(request.input);

  const onAllow = (): void => {
    void agentViewer.approveTool(request.toolUseId, true);
  };
  const onDeny = (): void => {
    void agentViewer.approveTool(request.toolUseId, false);
  };

  return (
    <div className="approval">
      <div className="approval__heading">{headline}</div>
      {request.description && (
        <div className="approval__desc">{request.description}</div>
      )}
      {preview && (
        <pre className="approval__preview">{preview}</pre>
      )}
      {request.decisionReason && (
        <div className="approval__reason">{request.decisionReason}</div>
      )}
      <div className="approval__actions">
        <button
          type="button"
          className="approval__btn approval__btn--deny"
          onClick={onDeny}
        >
          deny
        </button>
        <button
          type="button"
          className="approval__btn approval__btn--allow"
          onClick={onAllow}
        >
          allow
        </button>
        <button
          type="button"
          className="approval__btn approval__btn--ghost"
          onClick={() => setShowDetails((s) => !s)}
        >
          {showDetails ? "hide details" : "details"}
        </button>
      </div>
      {showDetails && (
        <pre className="approval__details">
          {JSON.stringify(
            {
              toolName: request.toolName,
              input: request.input,
              blockedPath: request.blockedPath,
              toolUseId: request.toolUseId,
            },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
}

export function ApprovalBanner() {
  const ids = useStore((s) => s.pendingApprovalIds);
  const approvals = useStore((s) => s.pendingApprovals);

  if (ids.length === 0) return null;

  return (
    <div className="approval-banner">
      {ids.map((id) => {
        const req = approvals[id];
        return req ? <ApprovalCard key={id} request={req} /> : null;
      })}
    </div>
  );
}
