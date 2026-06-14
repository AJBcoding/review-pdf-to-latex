// The preload-exposed IPC contract (`window.electronAPI`) shared between
// Electron main, preload, and renderer. This is the seam that ties the other
// four concern modules together; it was carved out of the former
// shared/types.ts god-file (roadmap X3). Keep this surface minimal — add a
// method here only when both main and renderer genuinely need it.

import type {
  EngineResult,
  PdfHealthResult,
  ReadPdfBytesResult,
  OpenPdfDialogResult,
} from './engine';
import type {
  DraftsFile,
  DraftsReadResult,
  DraftsWriteResult,
  BundleWriteRequest,
  BundleWriteResult,
  ResultsEvent,
  ResultsWatchStartResult,
  SubmitPromoteRequest,
  SubmitPromoteResult,
  SubmitSlingRequest,
  SubmitSlingResult,
  SubmitAbandonRequest,
  SubmitAbandonResult,
} from './comments';
import type {
  OpenFolderDialogResult,
  ListDirResult,
  PathExistsResult,
  AppStateFile,
  AppStateReadResult,
  AppStateWriteResult,
  IndexPdfsResult,
  WriteFileTextResult,
  FileChangeEvent,
} from './files';
import type {
  ReviewerProbe,
  PtyStartParams,
  PtyStartResult,
  PtyDataEvent,
  PtyExitEvent,
  WorkerStartParams,
  WorkerStartResult,
  WorkerDataEvent,
  WorkerExitEvent,
  WorkerProgressEvent,
  FreshStartParams,
  FreshStartResult,
} from './pty';

export interface ElectronAPI {
  // Smoke-test echo, retained from the empty-shell milestone.
  ping(message: string): Promise<string>;
  // Spawns `review-pdf --version` and returns a structured result.
  // Used by the renderer at startup to confirm the engine is reachable.
  engineVersion(): Promise<EngineResult>;
  // Spawns `review-pdf pdf-health --pdf <path> --json` and parses stdout
  // into a typed PdfHealthReport. The renderer calls this at PDF-load time
  // to drive the §5.2 load-time banner.
  pdfHealth(pdfPath: string): Promise<PdfHealthResult>;
  // Reads a PDF file from disk and returns its bytes. The renderer feeds
  // these to `pdfjsLib.getDocument({data})`. Paths are resolved relative
  // to the main process's cwd (the desktop/ dir during dev).
  readPdfBytes(pdfPath: string): Promise<ReadPdfBytesResult>;
  // Shows the native open-file dialog filtered to PDFs. Returns the picked
  // path, or null if the user canceled.
  openPdfDialog(): Promise<OpenPdfDialogResult>;
  // Reads `<dir-of-pdfPath>/.review-state/drafts/<sha256>.json`. A missing
  // file is the normal first-open case, not an error.
  readDrafts(pdfPath: string, sha256: string): Promise<DraftsReadResult>;
  // Writes the snapshot atomically (temp file + rename). Mkdir -p the
  // drafts dir first. Renderer debounces calls 250ms per spec §10.3.
  writeDrafts(pdfPath: string, sha256: string, file: DraftsFile): Promise<DraftsWriteResult>;
  // Flush handshake: main asks the renderer to drain its pending drafts
  // debounce before window close / app quit; renderer flushes, then acks
  // with the same id. Without this, a Cmd+Q within 250ms of a submit
  // loses the comment (debounce hasn't fired yet — see rev-cm6).
  // Returns an unsubscribe fn so callers can detach (the renderer wires
  // this once at boot and leaves it attached for the process lifetime).
  onDraftsFlushRequest(cb: (id: string) => void): () => void;
  sendDraftsFlushAck(id: string): void;

  // §3.1 — native folder picker. Sets the tree's root; previous root is
  // discarded (Obsidian model; not a multi-root workspace).
  openFolderDialog(): Promise<OpenFolderDialogResult>;
  // §3.2 — non-recursive directory listing. Folders are listed on-expand
  // so opening a large repo doesn't read the whole tree up front.
  listDir(path: string): Promise<ListDirResult>;
  // §3.3 — boot-time existence check for the remembered root. We don't
  // surface filesystem errors as crashes here; a missing root just falls
  // back to the empty-tree + "Open Folder…" prompt.
  pathExists(path: string): Promise<PathExistsResult>;
  // §3.3 — persisted app state (root + last doc + expansion set + show-hidden).
  // Snapshot semantics: main rewrites the whole file on each save, atomically.
  readAppState(): Promise<AppStateReadResult>;
  writeAppState(state: AppStateFile): Promise<AppStateWriteResult>;
  // §3.5 — recursive PDF index for Cmd+P. Eagerly walked under the current
  // root, honoring the hidden-by-default ignore list. No live filesystem
  // watching in v1; renderer can call this again on demand.
  indexPdfs(root: string): Promise<IndexPdfsResult>;

  // M-md-3 — write text content to disk (for .md save). Atomic via tmp+rename.
  writeFileText(filePath: string, content: string): Promise<WriteFileTextResult>;
  // M-md-3 — watch a file for external changes. Renderer calls this when
  // opening an editable .md; main pushes `file:change` events. Call
  // unwatchFile to stop (or it stops automatically on next watchFile call).
  watchFile(filePath: string): Promise<void>;
  unwatchFile(): Promise<void>;
  onFileChange(cb: (event: FileChangeEvent) => void): () => void;
  suppressFileWatch(): void;

  // §3.4 — main pushes the renderer a request to open a specific document
  // (from a CLI shim arg, second-instance argv, or reviewpdf:// URL).
  // Renderer pivots the middle pane to the doc; per §10.3 the prior doc's
  // draft state is preserved by the existing loadPdf flow.
  //
  // `from` carries the originating rig recorded via `review-pdf-app open
  // <path> --from <rig-id>` (§10.5.1). Null when invoked without the flag
  // (standalone case). The renderer persists this into AppState so subsequent
  // doc opens recover the origin even after restart.
  onOpenExternalFile(cb: (event: { path: string; from: string | null }) => void): () => void;

  // §10.1 step 6 + §10.3 — start watching `.review-state/` next to the
  // currently-open doc for new/changed results-*.json files. Renderer calls
  // this immediately after loadPdf completes (sha256 in hand). Switching
  // docs calls watchStop first, then watchStart against the new doc. Main
  // does an initial scan of pre-existing results files (the "resume?"
  // banner) before returning, so events for in-progress rounds will already
  // be flowing by the time this resolves.
  watchResultsStart(pdfPath: string, sha256: string): Promise<ResultsWatchStartResult>;
  watchResultsStop(): Promise<void>;
  onResultsEvent(cb: (event: ResultsEvent) => void): () => void;

  // §10.4 — write the dated bundle artifact (PDF + JSON sidecar) next to
  // the source PDF. Used by Cmd+S (Export Bundle) and as the first step of
  // Cmd+Return (Submit, rev-1md.4). Multiple writes on the same date
  // overwrite the same files; a new date produces a new dated bundle and
  // leaves yesterday's as audit trail.
  writeBundle(request: BundleWriteRequest): Promise<BundleWriteResult>;

  // ─── §10.1 Submit flow (rev-1md.4) ──────────────────────────────────────
  // Promote the live draft to a frozen submit-<ts>.json under .review-state/.
  // Returns the submit_id and per-comment status updates so the renderer can
  // mirror them onto its in-memory drafts (right-drawer flips to "submitted").
  submitPromote(request: SubmitPromoteRequest): Promise<SubmitPromoteResult>;
  // Spawn `gt mail send` with the rev-2k7 contract payload. Stdout/stderr
  // surface in the failure case so the renderer can show verbatim gt
  // diagnostics in the persistent error banner.
  submitSling(request: SubmitSlingRequest): Promise<SubmitSlingResult>;
  // §10.1 step 6 abandon: rename results-<ts>.json → results-<ts>.abandoned.json.
  // Soft tombstone — partial results are preserved, the rig's resume guard
  // ignores the .abandoned suffix, and the app's in-memory state flips to
  // idle so Submit re-enables.
  submitAbandonRound(request: SubmitAbandonRequest): Promise<SubmitAbandonResult>;

  // ─── §9.2 embedded Claude pane (rev-1md.2) ──────────────────────────────
  // Probe gas-town presence + identity. Cached on the main side; safe to call
  // freely. Drives the Sling button's enabled/disabled state (§9.2.5).
  probeReviewer(): Promise<ReviewerProbe>;
  // Spawn the conversational pty (lazy, on first PDF open). Idempotent — a
  // second call with a pty already alive returns `already_running: true`.
  // The renderer wires onPtyData / onPtyExit BEFORE calling start so no
  // initial bytes are dropped.
  startPty(params: PtyStartParams): Promise<PtyStartResult>;
  // Write to the pty's stdin (user keystrokes from xterm.js + app-injected
  // doc-switch lines). The newline character is the caller's responsibility.
  sendPtyInput(data: string): void;
  // Propagate xterm.js's geometry to the pty. Called on every fit().
  resizePty(cols: number, rows: number): void;
  // SIGTERM the pty (SIGKILL fallback after 1.5s). Used by Fresh Start
  // (rev-1md.3) and on app quit.
  killPty(): Promise<{ ok: true }>;
  // Data stream from main → renderer. Subscribe before calling startPty.
  // Returns an unsubscribe fn.
  onPtyData(cb: (event: PtyDataEvent) => void): () => void;
  // Exit notification — fires once per spawn generation. The renderer shows
  // "Claude session ended. [Restart]" per §9.2.2.
  onPtyExit(cb: (event: PtyExitEvent) => void): () => void;

  // ─── §9.2.6 toolbar / worker ptys (rev-1md.3) ──────────────────────────
  // Spawn a worker pty (Create Context or Sling). Each has its own claude
  // subprocess pre-primed with the context bundle. Main mints a workerId
  // the renderer uses for input/resize/kill. Subscribe to onWorker* BEFORE
  // calling so the priming output isn't dropped.
  startWorkerPty(params: WorkerStartParams): Promise<WorkerStartResult>;
  workerPtyInput(workerId: string, data: string): void;
  resizeWorkerPty(workerId: string, cols: number, rows: number): void;
  killWorkerPty(workerId: string): Promise<{ ok: true }>;
  onWorkerPtyData(cb: (event: WorkerDataEvent) => void): () => void;
  onWorkerPtyExit(cb: (event: WorkerExitEvent) => void): () => void;
  // §9.2.7 β/γ progress markers — main parses `[β]` lines out of worker
  // stdout before forwarding the rest. Channel is purely additive; absence
  // of markers degrades the strip to `⟳ <task> running [log]`.
  onWorkerPtyProgress(cb: (event: WorkerProgressEvent) => void): () => void;

  // §9.2.6 Fresh Start — kill the conversational pty and respawn with a
  // handoff summary as additional priming after the standard slash-command
  // activation. The renderer re-attaches its xterm.js terminal in place.
  freshStartPty(params: FreshStartParams): Promise<FreshStartResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
