// Types shared between Electron main, preload, and renderer.
// Keep this surface minimal — add types here only when both sides genuinely need them.

export interface ElectronAPI {
  // First IPC handler; echoes back so we can verify the IPC bridge from the renderer.
  ping(message: string): Promise<string>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
