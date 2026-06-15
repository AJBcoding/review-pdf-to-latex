import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_INVOKE } from '@shared/ipc';
import type {
  BundleWriteRequest,
  DraftsFile,
  ResultsEvent,
  SubmitAbandonRequest,
  SubmitPromoteRequest,
  SubmitSlingRequest,
} from '@shared/comments';
import type {
  AppStateFile,
  FileChangeEvent,
} from '@shared/files';
import type {
  FreshStartParams,
  PtyDataEvent,
  PtyExitEvent,
  PtyStartParams,
  WorkerDataEvent,
  WorkerExitEvent,
  WorkerProgressEvent,
  WorkerStartParams,
} from '@shared/pty';

// Expose a minimal, typed IPC surface to the renderer.
// Anything the renderer can call must be declared here — this is the security boundary.
const electronAPI: ElectronAPI = {
  ping: (message: string) => ipcRenderer.invoke(IPC_INVOKE.ping, message),
  engineVersion: () => ipcRenderer.invoke(IPC_INVOKE.engineVersion),
  pdfHealth: (pdfPath: string) => ipcRenderer.invoke(IPC_INVOKE.pdfHealth, pdfPath),
  readPdfBytes: (pdfPath: string) => ipcRenderer.invoke(IPC_INVOKE.readPdfBytes, pdfPath),
  openPdfDialog: () => ipcRenderer.invoke(IPC_INVOKE.openPdfDialog),
  readDrafts: (pdfPath: string, sha256: string) =>
    ipcRenderer.invoke(IPC_INVOKE.readDrafts, pdfPath, sha256),
  writeDrafts: (pdfPath: string, sha256: string, file: DraftsFile) =>
    ipcRenderer.invoke(IPC_INVOKE.writeDrafts, pdfPath, sha256, file),
  onDraftsFlushRequest: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string) => cb(id);
    ipcRenderer.on('drafts:flushRequest', listener);
    return () => { ipcRenderer.off('drafts:flushRequest', listener); };
  },
  sendDraftsFlushAck: (id: string) => { ipcRenderer.send('drafts:flushAck', id); },

  openFolderDialog: () => ipcRenderer.invoke(IPC_INVOKE.openFolderDialog),
  listDir: (path: string) => ipcRenderer.invoke(IPC_INVOKE.listDir, path),
  pathExists: (path: string) => ipcRenderer.invoke(IPC_INVOKE.pathExists, path),
  readAppState: () => ipcRenderer.invoke(IPC_INVOKE.readAppState),
  writeAppState: (state: AppStateFile) => ipcRenderer.invoke(IPC_INVOKE.writeAppState, state),
  indexPdfs: (root: string) => ipcRenderer.invoke(IPC_INVOKE.indexPdfs, root),

  writeFileText: (filePath: string, content: string) =>
    ipcRenderer.invoke(IPC_INVOKE.writeFileText, filePath, content),
  watchFile: (filePath: string) => ipcRenderer.invoke(IPC_INVOKE.watchFile, filePath),
  unwatchFile: () => ipcRenderer.invoke(IPC_INVOKE.unwatchFile),
  onFileChange: (cb) => {
    const listener = (_e: IpcRendererEvent, event: FileChangeEvent) => cb(event);
    ipcRenderer.on('file:change', listener);
    return () => { ipcRenderer.off('file:change', listener); };
  },
  suppressFileWatch: () => { ipcRenderer.send('fs:suppressFileWatch'); },

  onOpenExternalFile: (cb) => {
    const listener = (_e: IpcRendererEvent, event: { path: string; from: string | null }) => cb(event);
    ipcRenderer.on('app:openExternalFile', listener);
    // Tell main we're ready to receive the buffered cold-launch queue.
    ipcRenderer.send('app:externalOpenReady');
    return () => { ipcRenderer.off('app:openExternalFile', listener); };
  },

  watchResultsStart: (pdfPath: string, sha256: string) =>
    ipcRenderer.invoke(IPC_INVOKE.watchResultsStart, pdfPath, sha256),
  watchResultsStop: () => ipcRenderer.invoke(IPC_INVOKE.watchResultsStop),
  onResultsEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: ResultsEvent) => cb(event);
    ipcRenderer.on('results:event', listener);
    return () => { ipcRenderer.off('results:event', listener); };
  },

  writeBundle: (request: BundleWriteRequest) => ipcRenderer.invoke(IPC_INVOKE.writeBundle, request),

  // §10.1 Submit flow (rev-1md.4)
  submitPromote: (request: SubmitPromoteRequest) =>
    ipcRenderer.invoke(IPC_INVOKE.submitPromote, request),
  submitSling: (request: SubmitSlingRequest) =>
    ipcRenderer.invoke(IPC_INVOKE.submitSling, request),
  submitAbandonRound: (request: SubmitAbandonRequest) =>
    ipcRenderer.invoke(IPC_INVOKE.submitAbandonRound, request),

  // ─── §9.2 embedded Claude pane (rev-1md.2) ─────────────────────────────
  probeReviewer: () => ipcRenderer.invoke(IPC_INVOKE.probeReviewer),
  startPty: (params: PtyStartParams) => ipcRenderer.invoke(IPC_INVOKE.startPty, params),
  sendPtyInput: (data: string) => { ipcRenderer.send('pty:input', data); },
  resizePty: (cols: number, rows: number) => { ipcRenderer.send('pty:resize', cols, rows); },
  killPty: () => ipcRenderer.invoke(IPC_INVOKE.killPty),
  onPtyData: (cb) => {
    const listener = (_e: IpcRendererEvent, event: PtyDataEvent) => cb(event);
    ipcRenderer.on('pty:onData', listener);
    return () => { ipcRenderer.off('pty:onData', listener); };
  },
  onPtyExit: (cb) => {
    const listener = (_e: IpcRendererEvent, event: PtyExitEvent) => cb(event);
    ipcRenderer.on('pty:onExit', listener);
    return () => { ipcRenderer.off('pty:onExit', listener); };
  },

  // ─── §9.2.6 toolbar / worker ptys (rev-1md.3) ─────────────────────────
  startWorkerPty: (params: WorkerStartParams) => ipcRenderer.invoke(IPC_INVOKE.startWorkerPty, params),
  workerPtyInput: (workerId: string, data: string) => {
    ipcRenderer.send('pty:workerInput', workerId, data);
  },
  resizeWorkerPty: (workerId: string, cols: number, rows: number) => {
    ipcRenderer.send('pty:workerResize', workerId, cols, rows);
  },
  killWorkerPty: (workerId: string) => ipcRenderer.invoke(IPC_INVOKE.killWorkerPty, workerId),
  onWorkerPtyData: (cb) => {
    const listener = (_e: IpcRendererEvent, event: WorkerDataEvent) => cb(event);
    ipcRenderer.on('pty:onWorkerData', listener);
    return () => { ipcRenderer.off('pty:onWorkerData', listener); };
  },
  onWorkerPtyExit: (cb) => {
    const listener = (_e: IpcRendererEvent, event: WorkerExitEvent) => cb(event);
    ipcRenderer.on('pty:onWorkerExit', listener);
    return () => { ipcRenderer.off('pty:onWorkerExit', listener); };
  },
  onWorkerPtyProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, event: WorkerProgressEvent) => cb(event);
    ipcRenderer.on('pty:onWorkerProgress', listener);
    return () => { ipcRenderer.off('pty:onWorkerProgress', listener); };
  },
  freshStartPty: (params: FreshStartParams) => ipcRenderer.invoke(IPC_INVOKE.freshStartPty, params),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Project 4 / M-int-2 — React agent-pane bridge. Mirrors agent-viewer's
// preload surface (window.agentViewer). The renderer's ipc-client.ts under
// renderer/agent-pane/ calls into this. Untouched by the legacy claude-pty
// flow; only used when the localStorage feature flag is on.
import type { AgentViewerApi, BackendEvent } from '@shared/agent-pane/types';

const agentViewerApi: AgentViewerApi = {
  // All session-scoped methods accept an optional sessionId. Omit it (or
  // pass undefined) to target the canonical conversational session.
  send: (text: string, model?: string, sessionId?: string): Promise<void> =>
    ipcRenderer.invoke('agent:send', { text, model, sessionId }),

  interrupt: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke('agent:interrupt', { sessionId }),

  setModel: (modelId: string, sessionId?: string): Promise<void> =>
    ipcRenderer.invoke('agent:setModel', { modelId, sessionId }),

  approveTool: (
    toolUseId: string,
    allow: boolean,
    denyReason?: string,
    sessionId?: string,
  ): Promise<void> =>
    ipcRenderer.invoke('agent:approveTool', {
      toolUseId,
      allow,
      denyReason,
      sessionId,
    }),

  newSession: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke('agent:newSession', { sessionId }),

  close: (sessionId?: string): Promise<void> =>
    ipcRenderer.invoke('agent:close', { sessionId }),

  getSavedSessionId: (): Promise<string | null> =>
    ipcRenderer.invoke('agent:getSavedSessionId'),

  /** Project 4 / M-int-3 — notify the agent that the user pivoted to a
   *  new document. Debounced 500ms in main. Conv session only. */
  notifyDocSwitch: (payload: {
    path: string;
    pages: number;
    comments: number;
    sourceDir?: string;
  }): Promise<void> => ipcRenderer.invoke('agent:notifyDocSwitch', payload),

  /** Project 4 / M-int-5 — Fresh Start handoff for the conv session.
   *  Closes the current conv session, clears the saved resume id, starts
   *  a new conv session seeded with handoffText. */
  freshStart: (payload: {
    handoffText: string;
    model?: string;
    docSourceDir?: string;
  }): Promise<void> => ipcRenderer.invoke('agent:freshStart', payload),

  /** Project 4 / M-int-4a — spawn a worker session (Create Context /
   *  Sling) keyed by an arbitrary sessionId. Send the first prompt at
   *  spawn time. Events scope to the worker via the sessionId on
   *  BackendEvent so the renderer can route them. */
  spawnSession: (payload: {
    sessionId: string;
    prompt: string;
    model?: string;
    docSourceDir?: string;
  }): Promise<void> => ipcRenderer.invoke('agent:spawnSession', payload),

  listSessions: (): Promise<string[]> =>
    ipcRenderer.invoke('agent:listSessions'),

  onEvent: (handler: (event: BackendEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: BackendEvent): void =>
      handler(event);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
};

contextBridge.exposeInMainWorld('agentViewer', agentViewerApi);
