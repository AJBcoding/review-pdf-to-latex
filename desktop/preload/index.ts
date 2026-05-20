import { contextBridge, ipcRenderer } from 'electron';
import type { ElectronAPI } from '@shared/types';

// Expose a minimal, typed IPC surface to the renderer.
// Anything the renderer can call must be declared here — this is the security boundary.
const electronAPI: ElectronAPI = {
  ping: (message: string) => ipcRenderer.invoke('ping', message),
  engineVersion: () => ipcRenderer.invoke('engine:version'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
