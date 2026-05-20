import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI } from '@shared/types';

// Expose a minimal, typed IPC surface to the renderer.
// Anything the renderer can call must be declared here — this is the security boundary.
const electronAPI: ElectronAPI = {
  ping: (message: string) => ipcRenderer.invoke('ping', message),
  engineVersion: () => ipcRenderer.invoke('engine:version'),
  pdfHealth: (pdfPath: string) => ipcRenderer.invoke('engine:pdfHealth', pdfPath),
  readPdfBytes: (pdfPath: string) => ipcRenderer.invoke('fs:readPdfBytes', pdfPath),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
