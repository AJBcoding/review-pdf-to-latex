// Thin typed wrapper over the preload bridge. Renderer code imports from
// here, not from `window.agentViewer` directly — keeps types and call sites
// centralised so we can swap to a different transport later.

import type { AgentViewerApi } from "@shared/agent-pane/types";

declare global {
  interface Window {
    agentViewer?: AgentViewerApi;
  }
}

/**
 * True if the preload bridge is present. Renderer code that calls into IPC
 * should check this to avoid throwing on a busted preload load.
 */
export const ipcAvailable: boolean = Boolean(window.agentViewer);

const warnMissing = (name: string) =>
  console.error(
    `[ipc-client] agentViewer.${name}() called but preload bridge is not loaded.`,
  );

const stub: AgentViewerApi = {
  send: async () => warnMissing("send"),
  interrupt: async () => warnMissing("interrupt"),
  setModel: async () => warnMissing("setModel"),
  approveTool: async () => warnMissing("approveTool"),
  newSession: async () => warnMissing("newSession"),
  close: async () => {},
  getSavedSessionId: async () => null,
  notifyDocSwitch: async () => warnMissing("notifyDocSwitch"),
  freshStart: async () => warnMissing("freshStart"),
  spawnSession: async () => warnMissing("spawnSession"),
  listSessions: async () => {
    warnMissing("listSessions");
    return [];
  },
  onEvent: () => {
    warnMissing("onEvent");
    return () => {};
  },
};

export const agentViewer: AgentViewerApi = window.agentViewer ?? stub;

if (!ipcAvailable) {
  console.error(
    "[ipc-client] window.agentViewer is undefined. " +
      "Check the preload path in BrowserWindow.webPreferences.preload " +
      "(filename should match out/preload/<name> — electron-vite emits .mjs).",
  );
}
