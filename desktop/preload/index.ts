import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppStateFile,
  BundleWriteRequest,
  DraftsFile,
  ElectronAPI,
  FreshStartParams,
  PtyDataEvent,
  PtyExitEvent,
  PtyStartParams,
  ResultsEvent,
  SubmitAbandonRequest,
  SubmitPromoteRequest,
  SubmitSlingRequest,
  WorkerDataEvent,
  WorkerExitEvent,
  WorkerProgressEvent,
  WorkerStartParams,
} from '@shared/types';

// Expose a minimal, typed IPC surface to the renderer.
// Anything the renderer can call must be declared here — this is the security boundary.
const electronAPI: ElectronAPI = {
  ping: (message: string) => ipcRenderer.invoke('ping', message),
  engineVersion: () => ipcRenderer.invoke('engine:version'),
  pdfHealth: (pdfPath: string) => ipcRenderer.invoke('engine:pdfHealth', pdfPath),
  readPdfBytes: (pdfPath: string) => ipcRenderer.invoke('fs:readPdfBytes', pdfPath),
  openPdfDialog: () => ipcRenderer.invoke('dialog:openPdf'),
  readDrafts: (pdfPath: string, sha256: string) =>
    ipcRenderer.invoke('drafts:read', pdfPath, sha256),
  writeDrafts: (pdfPath: string, sha256: string, file: DraftsFile) =>
    ipcRenderer.invoke('drafts:write', pdfPath, sha256, file),
  onDraftsFlushRequest: (cb) => {
    const listener = (_e: IpcRendererEvent, id: string) => cb(id);
    ipcRenderer.on('drafts:flushRequest', listener);
    return () => { ipcRenderer.off('drafts:flushRequest', listener); };
  },
  sendDraftsFlushAck: (id: string) => { ipcRenderer.send('drafts:flushAck', id); },

  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  listDir: (path: string) => ipcRenderer.invoke('fs:listDir', path),
  pathExists: (path: string) => ipcRenderer.invoke('fs:pathExists', path),
  readAppState: () => ipcRenderer.invoke('appState:read'),
  writeAppState: (state: AppStateFile) => ipcRenderer.invoke('appState:write', state),
  indexPdfs: (root: string) => ipcRenderer.invoke('fs:indexPdfs', root),
  onOpenExternalFile: (cb) => {
    const listener = (_e: IpcRendererEvent, event: { path: string; from: string | null }) => cb(event);
    ipcRenderer.on('app:openExternalFile', listener);
    // Tell main we're ready to receive the buffered cold-launch queue.
    ipcRenderer.send('app:externalOpenReady');
    return () => { ipcRenderer.off('app:openExternalFile', listener); };
  },

  watchResultsStart: (pdfPath: string, sha256: string) =>
    ipcRenderer.invoke('results:watchStart', pdfPath, sha256),
  watchResultsStop: () => ipcRenderer.invoke('results:watchStop'),
  onResultsEvent: (cb) => {
    const listener = (_e: IpcRendererEvent, event: ResultsEvent) => cb(event);
    ipcRenderer.on('results:event', listener);
    return () => { ipcRenderer.off('results:event', listener); };
  },

  writeBundle: (request: BundleWriteRequest) => ipcRenderer.invoke('bundle:write', request),

  // §10.1 Submit flow (rev-1md.4)
  submitPromote: (request: SubmitPromoteRequest) =>
    ipcRenderer.invoke('submit:promote', request),
  submitSling: (request: SubmitSlingRequest) =>
    ipcRenderer.invoke('submit:sling', request),
  submitAbandonRound: (request: SubmitAbandonRequest) =>
    ipcRenderer.invoke('submit:abandonRound', request),

  // ─── §9.2 embedded Claude pane (rev-1md.2) ─────────────────────────────
  probeReviewer: () => ipcRenderer.invoke('pty:probeReviewer'),
  startPty: (params: PtyStartParams) => ipcRenderer.invoke('pty:start', params),
  sendPtyInput: (data: string) => { ipcRenderer.send('pty:input', data); },
  resizePty: (cols: number, rows: number) => { ipcRenderer.send('pty:resize', cols, rows); },
  killPty: () => ipcRenderer.invoke('pty:kill'),
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
  startWorkerPty: (params: WorkerStartParams) => ipcRenderer.invoke('pty:startWorker', params),
  workerPtyInput: (workerId: string, data: string) => {
    ipcRenderer.send('pty:workerInput', workerId, data);
  },
  resizeWorkerPty: (workerId: string, cols: number, rows: number) => {
    ipcRenderer.send('pty:workerResize', workerId, cols, rows);
  },
  killWorkerPty: (workerId: string) => ipcRenderer.invoke('pty:killWorker', workerId),
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
  freshStartPty: (params: FreshStartParams) => ipcRenderer.invoke('pty:freshStart', params),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// Project 4 / M-int-2 — React agent-pane bridge. Mirrors agent-viewer's
// preload surface (window.agentViewer). The renderer's ipc-client.ts under
// renderer/agent-pane/ calls into this. Untouched by the legacy claude-pty
// flow; only used when the localStorage feature flag is on.
import type { BackendEvent } from '@shared/agent-pane/types';

const agentViewerApi = {
  send: (text: string, model?: string): Promise<void> =>
    ipcRenderer.invoke('agent:send', { text, model }),

  interrupt: (): Promise<void> => ipcRenderer.invoke('agent:interrupt'),

  setModel: (modelId: string): Promise<void> =>
    ipcRenderer.invoke('agent:setModel', { modelId }),

  approveTool: (
    toolUseId: string,
    allow: boolean,
    denyReason?: string,
  ): Promise<void> =>
    ipcRenderer.invoke('agent:approveTool', { toolUseId, allow, denyReason }),

  newSession: (): Promise<void> => ipcRenderer.invoke('agent:newSession'),

  close: (): Promise<void> => ipcRenderer.invoke('agent:close'),

  getSavedSessionId: (): Promise<string | null> =>
    ipcRenderer.invoke('agent:getSavedSessionId'),

  /** Project 4 / M-int-3 — notify the agent that the user pivoted to a
   *  new document. Debounced 500ms in main. */
  notifyDocSwitch: (payload: {
    path: string;
    pages: number;
    comments: number;
  }): Promise<void> => ipcRenderer.invoke('agent:notifyDocSwitch', payload),

  onEvent: (handler: (event: BackendEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, event: BackendEvent): void =>
      handler(event);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },
};

contextBridge.exposeInMainWorld('agentViewer', agentViewerApi);

export type AgentViewerApi = typeof agentViewerApi;
