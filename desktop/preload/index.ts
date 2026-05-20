import { contextBridge, ipcRenderer } from 'electron';
import type { DraftsFile, ElectronAPI } from '@shared/types';

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
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
