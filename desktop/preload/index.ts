import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AppStateFile,
  BundleWriteRequest,
  DraftsFile,
  ElectronAPI,
  PtyDataEvent,
  PtyExitEvent,
  PtyStartParams,
  ResultsEvent,
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
    const listener = (_e: IpcRendererEvent, path: string) => cb(path);
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
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
