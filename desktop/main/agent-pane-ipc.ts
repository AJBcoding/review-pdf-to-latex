// Project 4 / M-int-2 — main-process IPC handlers for the React agent pane.
//
// Ported from agent-viewer's src/main/index.ts. Provides the 6 IPC methods
// the renderer's preload bridge (window.agentViewer) calls into, plus
// emits BackendEvents back to the renderer via "agent:event".
//
// Coexists with the legacy claude-pty IPC: the renderer chooses which path
// to use via the localStorage feature flag (see desktop/renderer/index.ts).
import { BrowserWindow, ipcMain } from 'electron';

import {
  clearSavedSessionId,
  loadSavedSessionId,
  saveSessionId,
} from './session-store.js';
import { startSession, type ClaudeSession } from './claude-backend.js';
import type { BackendEvent } from '@shared/agent-pane/types.js';

let session: ClaudeSession | null = null;
let mainWindowRef: BrowserWindow | null = null;

function emitToRenderer(event: BackendEvent): void {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('agent:event', event);
  }
}

function ensureSession(options?: {
  resume?: string | null;
  model?: string;
}): ClaudeSession {
  if (session) return session;
  const explicitResume = options?.resume;
  // explicit null = "no resume". undefined = "use saved".
  const resume =
    explicitResume === null
      ? undefined
      : (explicitResume ?? loadSavedSessionId() ?? undefined);
  session = startSession({
    emit: emitToRenderer,
    resume,
    onSessionId: saveSessionId,
    model: options?.model,
  });
  return session;
}

async function endSession(): Promise<void> {
  if (!session) return;
  await session.close();
  session = null;
}

/** Register the agent-pane IPC handlers. Safe to call once at app boot. */
export function registerAgentPaneIpc(mainWindow: BrowserWindow): void {
  mainWindowRef = mainWindow;

  ipcMain.handle(
    'agent:send',
    (_e, payload: { text: string; model?: string }) => {
      if (typeof payload?.text !== 'string') return;
      const s = ensureSession({
        model: typeof payload.model === 'string' ? payload.model : undefined,
      });
      s.send(payload.text);
    },
  );

  ipcMain.handle('agent:interrupt', async () => {
    if (session) await session.interrupt();
  });

  ipcMain.handle(
    'agent:setModel',
    async (_e, payload: { modelId: string }) => {
      if (!session) return;
      if (typeof payload?.modelId !== 'string') return;
      await session.setModel(payload.modelId);
    },
  );

  ipcMain.handle(
    'agent:approveTool',
    (
      _e,
      payload: { toolUseId: string; allow: boolean; denyReason?: string },
    ) => {
      if (!session) return;
      if (typeof payload?.toolUseId !== 'string') return;
      session.approve(
        payload.toolUseId,
        payload.allow === true,
        payload.denyReason,
      );
    },
  );

  ipcMain.handle('agent:newSession', async () => {
    await endSession();
    clearSavedSessionId();
  });

  ipcMain.handle('agent:close', async () => {
    await endSession();
  });

  ipcMain.handle('agent:getSavedSessionId', () => loadSavedSessionId());
}

/** Tear down the live session on app quit. */
export async function shutdownAgentPane(): Promise<void> {
  await endSession();
}
