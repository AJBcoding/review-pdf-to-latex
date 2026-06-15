import { useEffect } from "react";
import { StatusBar } from "./components/StatusBar";
import { StatusFooter } from "./components/StatusFooter";
import { MessagesTimeline } from "./components/MessagesTimeline";
import { ChatComposer } from "./components/ChatComposer";
import { ApprovalBanner } from "./components/ApprovalBanner";
import { ContextMeter } from "./components/ContextMeter";
import { WorkerPanel } from "./components/WorkerPanel";
import { agentViewer } from "./ipc-client";
import { useStore } from "./store";
import { useWorkerStore } from "./worker-store";
import { CONV_SESSION_ID } from "@shared/agent-pane/types";

export function App() {
  const apply = useStore((s) => s.apply);
  const pushUserMessage = useStore((s) => s.pushUserMessage);
  const applyWorkerEvent = useWorkerStore((s) => s.applyWorkerEvent);

  // Subscribe to backend events as soon as the app mounts so we don't miss
  // the system.init that arrives shortly after the first user send.
  //
  // Project 4 / M-int-4a: events carry an optional sessionId. The conv pane
  // shows the conversational session; X8 Stage 3 routes worker session events
  // to the WorkerPanel (via the worker store) so worker sessions surface their
  // state + tool approvals instead of being dropped.
  useEffect(() => {
    return agentViewer.onEvent((event) => {
      const sessionId = event.sessionId ?? CONV_SESSION_ID;
      if (sessionId === CONV_SESSION_ID) {
        apply(event);
      } else {
        applyWorkerEvent(sessionId, event);
      }
    });
  }, [apply, applyWorkerEvent]);

  const onSubmit = (text: string): void => {
    // Optimistically render the user message before the SDK echoes it back.
    // (The SDK does not echo user-side stream-json input by default; we
    // depend on local state for it.)
    pushUserMessage(text);
    // Thread the user's currently-selected model so a fresh session starts
    // with the right one. Read from the store directly (not via a hook) so
    // we don't have to re-render this component on selectedModel changes.
    const model = useStore.getState().selectedModel;
    void agentViewer.send(text, model);
  };

  return (
    <div className="app">
      <StatusBar />
      <MessagesTimeline />
      <WorkerPanel />
      <ContextMeter />
      <ApprovalBanner />
      <ChatComposer onSubmit={onSubmit} />
      <StatusFooter />
    </div>
  );
}
