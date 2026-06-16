// The IPC bridge surface: the `ElectronAPI` contract exposed on
// `window.electronAPI` via the preload bridge, wiring renderer calls to main.
// Every method's payload/result type lives in one of the concern modules
// (engine / comments / files / pty); this file only assembles them into the
// method surface and declares the global augmentation.

import type {
  EngineResult,
  PdfHealthResult,
  ReadFileBytesResult,
  OpenPdfDialogResult,
} from './engine';
import type {
  DraftsFile,
  DraftsReadResult,
  DraftsWriteResult,
  ResultsEvent,
  ResultsWatchStartResult,
  BundleWriteRequest,
  BundleWriteResult,
  SubmitPromoteRequest,
  SubmitPromoteResult,
  SubmitSlingRequest,
  SubmitSlingResult,
  SubmitAbandonRequest,
  SubmitAbandonResult,
  DocxCommentsReadResult,
  DocxCommentCreateRequest,
  DocxCommentEditRequest,
  DocxCommentDeleteRequest,
  DocxCommentWriteResult,
  PdfCommentsReadResult,
  PdfCommentCreateRequest,
  PdfCommentEditRequest,
  PdfCommentDeleteRequest,
  PdfCommentWriteResult,
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
import type { ReviewerProbe } from './pty';

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
  // Reads a document file from disk and returns its bytes. Format-agnostic —
  // PDF bytes feed `pdfjsLib.getDocument({data})`, md/html/docx decode in the
  // renderer. Paths are resolved relative to the main process's cwd (the
  // desktop/ dir during dev).
  readFileBytes(docPath: string): Promise<ReadFileBytesResult>;
  // Shows the native open-file dialog filtered to PDFs. Returns the picked
  // path, or null if the user canceled.
  openPdfDialog(): Promise<OpenPdfDialogResult>;
  // Reads `<dir-of-docPath>/.review-state/drafts/<basename>.json`. Sidecars
  // are path-keyed (not content-keyed), so no sha256 is needed to locate one.
  // A missing file is the normal first-open case, not an error.
  readDrafts(docPath: string): Promise<DraftsReadResult>;
  // Writes the snapshot atomically (temp file + rename). Mkdir -p the
  // drafts dir first. Renderer debounces calls 250ms per spec §10.3.
  writeDrafts(docPath: string, file: DraftsFile): Promise<DraftsWriteResult>;
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

  // ─── §9.2.5 reviewer-rig probe ──────────────────────────────────────────
  // Probe gas-town presence + identity. Cached on the main side; safe to call
  // freely. Drives the Sling button's enabled/disabled state (§9.2.5). The
  // only surviving member of the former pty surface — the conversational and
  // worker ptys were retired in X8 stage 4 (rev-enext.3) in favor of the SDK
  // agent pane (window.agentViewer); the handler lives in agent-pane-ipc.ts.
  probeReviewer(): Promise<ReviewerProbe>;

  // ─── §5.3 / L5 native DOCX comments ─────────────────────────────────────
  // The L5 docx-comments adapter (main) reads/writes a .docx's comments.xml +
  // document.xml range markers; the renderer reaches it through these channels.
  // Native-docx comments are a read-projection of the source file (like
  // native-pdf annotations) — surfaced as cards on open, re-derived every time,
  // never persisted to the drafts sidecar. Create/edit/delete mutate the .docx
  // atomically; the renderer re-opens the doc to refresh after a write.
  readDocxComments(docPath: string, docVersion: string): Promise<DocxCommentsReadResult>;
  createDocxComment(request: DocxCommentCreateRequest): Promise<DocxCommentWriteResult>;
  editDocxComment(request: DocxCommentEditRequest): Promise<DocxCommentWriteResult>;
  deleteDocxComment(request: DocxCommentDeleteRequest): Promise<DocxCommentWriteResult>;

  // ─── §5.1 / L4 native PDF comments ──────────────────────────────────────
  // The L4 pdf-comments adapter (main) reads/writes a PDF's markup annotations;
  // the renderer reaches it through these channels. Native-pdf comments are a
  // read-projection of the source PDF (surfaced as cards on open, re-derived
  // every time, never persisted to the drafts sidecar). Reading routes through
  // the same adapter as edit/delete so the card's `(page_index, annot_index)`
  // handle stays valid for a later write. Create/edit/delete mutate the PDF
  // atomically; the renderer re-opens the doc to refresh after a write.
  readPdfComments(docPath: string, docVersion: string): Promise<PdfCommentsReadResult>;
  createPdfComment(request: PdfCommentCreateRequest): Promise<PdfCommentWriteResult>;
  editPdfComment(request: PdfCommentEditRequest): Promise<PdfCommentWriteResult>;
  deletePdfComment(request: PdfCommentDeleteRequest): Promise<PdfCommentWriteResult>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

/**
 * Single source of truth mapping each invoke-style `ElectronAPI` method to its
 * `ipcRenderer.invoke` / `ipcMain.handle` channel string. Both bridges import
 * this — the preload to invoke, the main to register via `typedHandle` — so the
 * channel name can't drift between the two sides (it previously lived as bare
 * string literals duplicated across preload + main).
 *
 * Only the request/response (invoke) methods appear here. One-way `send`
 * methods (sendPtyInput, …) and main→renderer event subscriptions (onPtyData,
 * …) keep their own literal channels; they carry no result to type-check.
 *
 * `satisfies Partial<Record<keyof ElectronAPI, …>>` enforces that every key is
 * a real `ElectronAPI` method name — a typo'd key fails to compile.
 */
export const IPC_INVOKE = {
  ping: 'ping',
  engineVersion: 'engine:version',
  pdfHealth: 'engine:pdfHealth',
  readFileBytes: 'fs:readFileBytes',
  openPdfDialog: 'dialog:openPdf',
  readDrafts: 'drafts:read',
  writeDrafts: 'drafts:write',
  openFolderDialog: 'dialog:openFolder',
  listDir: 'fs:listDir',
  pathExists: 'fs:pathExists',
  readAppState: 'appState:read',
  writeAppState: 'appState:write',
  indexPdfs: 'fs:indexPdfs',
  writeFileText: 'fs:writeFileText',
  watchFile: 'fs:watchFile',
  unwatchFile: 'fs:unwatchFile',
  watchResultsStart: 'results:watchStart',
  watchResultsStop: 'results:watchStop',
  writeBundle: 'bundle:write',
  submitPromote: 'submit:promote',
  submitSling: 'submit:sling',
  submitAbandonRound: 'submit:abandonRound',
  probeReviewer: 'pty:probeReviewer',
  readDocxComments: 'docx:readComments',
  createDocxComment: 'docx:createComment',
  editDocxComment: 'docx:editComment',
  deleteDocxComment: 'docx:deleteComment',
  readPdfComments: 'pdf:readComments',
  createPdfComment: 'pdf:createComment',
  editPdfComment: 'pdf:editComment',
  deletePdfComment: 'pdf:deleteComment',
} as const satisfies Partial<Record<keyof ElectronAPI, string>>;

/** Invoke-style `ElectronAPI` method names — the keys of {@link IPC_INVOKE}. */
export type InvokeMethod = keyof typeof IPC_INVOKE;
