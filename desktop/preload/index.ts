import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC_INVOKE, type ElectronAPI } from '@shared/ipc';
import type {
  BundleWriteRequest,
  DraftsFile,
  ResultsEvent,
  SubmitAbandonRequest,
  SubmitPromoteRequest,
  SubmitSlingRequest,
  DocxCommentCreateRequest,
  DocxCommentEditRequest,
  DocxCommentDeleteRequest,
} from '@shared/comments';
import type {
  AppStateFile,
  FileChangeEvent,
} from '@shared/files';

// Expose a minimal, typed IPC surface to the renderer.
// Anything the renderer can call must be declared here — this is the security boundary.
const electronAPI: ElectronAPI = {
  ping: (message: string) => ipcRenderer.invoke(IPC_INVOKE.ping, message),
  engineVersion: () => ipcRenderer.invoke(IPC_INVOKE.engineVersion),
  pdfHealth: (pdfPath: string) => ipcRenderer.invoke(IPC_INVOKE.pdfHealth, pdfPath),
  readFileBytes: (docPath: string) => ipcRenderer.invoke(IPC_INVOKE.readFileBytes, docPath),
  openPdfDialog: () => ipcRenderer.invoke(IPC_INVOKE.openPdfDialog),
  readDrafts: (docPath: string) =>
    ipcRenderer.invoke(IPC_INVOKE.readDrafts, docPath),
  writeDrafts: (docPath: string, file: DraftsFile) =>
    ipcRenderer.invoke(IPC_INVOKE.writeDrafts, docPath, file),
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

  // ─── §9.2.5 reviewer-rig probe ─────────────────────────────────────────
  // X8 stage 4 (rev-enext.3): the only surviving member of the former pty
  // surface. Backs Sling gating (gt presence + identity) on the SDK route;
  // the handler now lives in agent-pane-ipc.ts.
  probeReviewer: () => ipcRenderer.invoke(IPC_INVOKE.probeReviewer),

  // ─── §5.3 / L5 native DOCX comments ────────────────────────────────────
  readDocxComments: (docPath: string, docVersion: string) =>
    ipcRenderer.invoke(IPC_INVOKE.readDocxComments, docPath, docVersion),
  createDocxComment: (request: DocxCommentCreateRequest) =>
    ipcRenderer.invoke(IPC_INVOKE.createDocxComment, request),
  editDocxComment: (request: DocxCommentEditRequest) =>
    ipcRenderer.invoke(IPC_INVOKE.editDocxComment, request),
  deleteDocxComment: (request: DocxCommentDeleteRequest) =>
    ipcRenderer.invoke(IPC_INVOKE.deleteDocxComment, request),
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
