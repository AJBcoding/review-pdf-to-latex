// Work group card for t3-style display. Mirrors t3's WorkGroupSection
// (apps/web/src/components/chat/MessagesTimeline.tsx):
//   rounded-xl border border-border/45 bg-card/25 px-2 py-1.5
// — tiny uppercase header, icon-prefixed rows with truncated previews.

import { useState } from "react";
import {
  Terminal,
  Eye,
  SquarePen,
  Globe,
  Search,
  Wrench,
  Hammer,
  type LucideIcon,
} from "lucide-react";
import type { ActivityCategory, ThreadActivity } from "@shared/agent-pane/types";

/**
 * Map adapter-classified category to lucide icon. Mirrors t3's
 * workEntryIcon (MessagesTimeline.tsx:1062) which dispatches on
 * `requestKind`/`itemType` rather than tool-name string matching —
 * survives upstream tool renames.
 */
function iconForCategory(category: ActivityCategory | undefined): LucideIcon {
  switch (category) {
    case "command":
      return Terminal;
    case "file-read":
      return Eye;
    case "file-change":
      return SquarePen;
    case "web":
      return Globe;
    case "search":
      return Search;
    case "mcp":
      return Wrench;
    default:
      return Hammer;
  }
}

function getToolNameFromActivity(activity: ThreadActivity): string | undefined {
  const payload = activity.payload as
    | { name?: string; tool_use_id?: string }
    | undefined;
  return payload?.name;
}

function ActivityRow({ activity }: { activity: ThreadActivity }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = getToolNameFromActivity(activity);
  const Icon = iconForCategory(activity.category);
  const isCompleted = activity.kind === "tool.completed";
  const isError = activity.tone === "error";
  const heading = isCompleted
    ? "completed"
    : toolName ?? activity.kind;

  return (
    <div className={`wg-row ${isError ? "wg-row--error" : ""}`}>
      <button
        type="button"
        className="wg-row__main"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <Icon size={12} className="wg-row__icon" aria-hidden />
        <span className="wg-row__heading">{heading}</span>
        <span className="wg-row__preview">{activity.summary}</span>
      </button>
      {expanded && activity.payload !== undefined && (
        <pre className="wg-row__payload">
          {JSON.stringify(activity.payload, null, 2)}
        </pre>
      )}
    </div>
  );
}

interface Props {
  activities: ThreadActivity[];
}

export function WorkGroup({ activities }: Props) {
  if (activities.length === 0) return null;
  return (
    <div className="wg">
      <div className="wg__header">
        <span className="wg__label">work ({activities.length})</span>
      </div>
      <div className="wg__rows">
        {activities.map((a) => (
          <ActivityRow key={a.id} activity={a} />
        ))}
      </div>
    </div>
  );
}
