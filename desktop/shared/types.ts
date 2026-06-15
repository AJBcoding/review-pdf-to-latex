// Types shared between Electron main, preload, and renderer.
// Keep this surface minimal — add types here only when both sides genuinely need them.
//
// This file is a barrel: the actual definitions live in five concern modules,
// split along the seams of the original god-file (rev-x3). Import from the
// concern module directly for new code; this re-export preserves the
// historical `@shared/types` surface for existing importers.
//
//   engine   — `review-pdf` subprocess + PDF read/health I/O
//   comments — §8 review domain: comments, drafts, submit/results, bundles
//   files    — §3 file tree, app state, file write/watch
//   pty      — §9.2 embedded-Claude pty surface
//   ipc      — the `ElectronAPI` bridge contract + `window.electronAPI` global

export * from './engine';
export * from './comments';
export * from './files';
export * from './pty';
export * from './ipc';
