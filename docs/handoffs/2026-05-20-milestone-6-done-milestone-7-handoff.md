---
type: handoff
status: milestone #6 shipped. next up — see "Suggested next session" for milestone #7 options.
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: build day 5 — left-drawer file tree + Cmd+P palette + external handoff
predecessors:
  - docs/handoffs/2026-05-20-milestone-5-done-milestone-6-handoff.md
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§3 left drawer in full —
    §3.1 root, §3.2 tree contents, §3.3 launch behavior, §3.4 external
    handoff, §3.5 quick-open palette)
---

# Milestone #6 done — left-drawer file tree, quick-open palette, external handoff

## What landed this session

Full §3 — the empty-shell left drawer is now a working file tree, Cmd+P
opens a fuzzy palette over the root's PDFs, and external processes can
hand documents to the app via a CLI shim or `reviewpdf://` URL.

**End-to-end shape — what the user sees:**

- Left drawer has a folder icon (open folder…) and an eye icon (show
  hidden). Open Folder… replaces the placeholder with the chosen folder's
  contents; the title bar shows the folder name and hovering reveals the
  full path. Folders are 📁, files use a kind-specific icon (📄 PDF, 📝
  MD, 📃 DOCX, · other) and non-PDFs are dimmed and inert.
- Clicking a folder toggles its expansion (chevron flips ▸/▾). Clicking
  a PDF opens it in the middle pane — same loadPdf flow as the Open…
  button, so drafts persistence + §5.2 banners + dark-mode all just work.
  The active row is highlighted (blue accent) so the user can see which
  file maps to the open document.
- Hidden by default: `.git/`, `node_modules/`, `__pycache__/`, `.venv/`,
  `dist/`, `build/`, dotfiles. The 👁 toggle reveals them (italic +
  dimmed text) without losing the dimming on non-PDFs.
- `Cmd+P` opens a centered modal palette. Typing fuzzy-matches against
  every PDF reachable under the current root (path, with basename
  bolded); `↑/↓` walks results, `Enter` opens, `Esc` or click-outside
  dismisses. Matched characters are highlighted in the accent color.
- On quit, the renderer saves `~/Library/Application
  Support/Electron/state.json` with `{ root, last_opened_doc,
  expanded_dirs, show_hidden }`. On next launch, the tree restores to
  its prior shape and the last document re-opens.
- External handoff: `desktop/bin/review-pdf-app open <path>` (or any
  positional `.pdf` arg, or `reviewpdf://open?path=...`) launches the
  app and opens the doc. If the app is already running, the
  single-instance handler focuses the existing window and pivots the
  middle pane — current doc's draft state is preserved by the existing
  loadPdf flow (§10.3).

## Issues closed

| ID        | Title                                                              |
|-----------|--------------------------------------------------------------------|
| rev-rga   | desktop: M6 §3.1–§3.3 left-drawer file tree                        |
| rev-qgo   | desktop: M6 §3.3 launch behavior + state persistence               |
| rev-r3g   | desktop: M6 §3.5 quick-open palette (Cmd+P)                        |
| rev-ehg   | desktop: M6 §3.4 external handoff (CLI + URL scheme + single-inst) |

## Implementation notes

### Tree (§3.1–§3.3) — `desktop/renderer/tree.ts` + new IPC

A new module (`tree.ts`) owns the left drawer's UI; the renderer (`index.ts`)
owns the glue and persistence. The split exists because the tree is purely
presentation — it doesn't know about app state, PDF opening, or persistence;
the host wires those via two callbacks (`onOpenFile`, `onStateChange`).

- **Lazy folder loading.** `fs:listDir` returns one directory at a time;
  the tree caches results so a collapse + re-expand doesn't re-read.
  This keeps opening $HOME or a multi-GB repo from stalling — only the
  directories the user actually opens hit the disk. An inflight-load
  map dedupes double-clicks on the same folder.
- **Folder-first sort.** Within a directory, folders come before files,
  then alphabetic case-insensitive. Matches Finder/VS Code defaults
  rather than raw inode order.
- **Hidden filtering.** The §3.2 ignore list (`.git`, `node_modules`,
  `__pycache__`, `.venv`, `dist`, `build`, dotfiles) is applied at the
  edge by main (each entry carries an `isHidden` flag), so the tree
  doesn't need to know the list. Toggle just changes the filter
  predicate — entries are still in the cache, no re-read.
- **Symlinks.** `readdir({ withFileTypes: true })` doesn't follow
  symlinks and `Dirent.isDirectory()` returns false for them. v1 treats
  them as inert files — they show in the tree but don't expand. Good
  enough; tracking a symlink loop dance can wait until someone hits it.
- **Depth via padding-left.** No nested `<ul>` — the whole tree is a
  flat list with inline `padding-left: ${depth * 14 + 6}px`. Cheaper to
  re-render on expand/collapse than tearing down nested elements, and
  the visual is identical for the cases we care about.

### State persistence (§3.3) — `appState:read/write` + atomic rename

- File lives at `app.getPath('userData')/state.json`, same write pattern
  as drafts: write to `state.json.<rand>.tmp`, then `rename()` over the
  target. A crash mid-write can't corrupt the boot record.
- Renderer debounces saves 250ms (matches drafts cadence) — `setRoot`,
  every expand/collapse, the show-hidden toggle, and `loadPdf` all
  call `scheduleAppStateSave()` and ride the same timer. No flush
  handshake on quit because state writes are idempotent: the most
  recent intent always wins, and a dropped final write at most loses
  the cursor position, not data the user typed.
- **`schema_version` defensive read.** If state.json has a future
  version we don't know how to interpret, we treat it as "not found"
  and start fresh, instead of crashing the boot path. Lets us bump
  the schema later without bricking old installs.
- **Last-doc cross-root.** The remembered `last_opened_doc` doesn't
  have to live under the remembered root — external handoff or
  pre-tree usage may have opened something outside. We just check the
  file still exists before re-opening; the tree's active-row highlight
  no-ops if the path doesn't match a visible row.

### Quick-open palette (§3.5) — `desktop/renderer/palette.ts` + `fs:indexPdfs`

- **Eager index.** When the root opens (or on relaunch), main walks
  the entire root recursively, skipping the hidden-dir list, and
  returns every `.pdf` it finds. Soft cap at 20 000 hits so a
  mis-pointed root (`/`, `$HOME`) doesn't OOM. Each hit carries its
  absolute path + basename + relPath (forward-slash normalized).
- **Subsequence fuzzy match.** Per-keystroke linear scan; scoring
  rewards basename hits, consecutive runs, word-boundary starts
  (after `/`, `-`, `_`, `.`, ` `), case match, and tight spans. The
  basename is repeated bolded on the left of each row so the visual
  scan lands on file names first. For v1's expected scale (low
  thousands of files), this is microseconds per keystroke — if it
  ever shows up in a profile, swap to a precomputed trigram index
  or push the scan to a worker.
- **No filesystem watching.** Index is built once when the root
  opens. Adding or removing files while the app is up doesn't
  reflect until the next root change. Filed `rev-s0b`.

### External handoff (§3.4) — single-instance + protocol + CLI shim

- **Single-instance.** `app.requestSingleInstanceLock()` returns
  false in secondaries; they `app.quit()` immediately. The primary
  picks up the `second-instance` event with the secondary's argv,
  parses it via `extractPathFromArgv`, and queues the path through
  `queueExternalOpen` (same buffer path cold launches use).
- **URL scheme.** `setAsDefaultProtocolClient('reviewpdf')` runs at
  module load (must be before `whenReady`). `open-url` (macOS) and
  `open-file` (macOS) handlers both feed the same queue.
- **Cold-launch buffering.** External-open requests can arrive before
  the renderer has wired its handler — initial argv, an `open-url`
  fired during boot, an early `second-instance` event. We buffer
  them in `pendingExternalOpens` and flush once the renderer signals
  it's ready via `app:externalOpenReady` (sent from the preload when
  `onOpenExternalFile` is wired). Without this, the very first
  external invocation on a cold boot would race against renderer
  init and get dropped.
- **CLI shim.** `desktop/bin/review-pdf-app` is a bash script. It
  resolves the desktop/ root regardless of where it's symlinked from,
  then either execs `$REVIEW_PDF_APP_BIN` (set by future packaging)
  or falls back to `npm run dev --` for unpackaged use. Distribution
  story is filed as `rev-xoc` — the shim already respects the env var,
  so post-packaging we just wire the install step to set it.
- **`extractPathFromArgv`.** One small parser handles all argv forms
  the spec recognizes: `open <path>`, positional `.pdf`,
  `reviewpdf://open?path=...`. v1 ignores unrecognized URL keys with
  a `console.warn` per spec §3.4 (the spec reserves the namespace
  for `--page N`, `--comment-id X`, `--anchor "..."`).

### Defensive: window-management

`createWindow` now records itself as `primaryWindow` and clears the slot
on `closed`. Without this, single-instance focus would try to call
methods on a destroyed window if the user closed and re-launched via
shim. The `closed` handler is `===` checked so future multi-window
support won't accidentally null out the wrong slot.

## State of the repo at handoff

- **Branch:** `main`, pushed to `origin/main`.
- **Quality gates:** `npm run typecheck` + `npm run build` clean.

## Verification done this session

Two Playwright/Electron scripts:

- `/tmp/verify-m6.js` — boots the app under a temp fixture root
  (`paper-a.pdf`, `paper-b.pdf`, `subdir/nested-c.pdf`, `.hidden-stuff/`,
  `node_modules/`) and exercises seven scenarios end-to-end:
  - **A** tree renders root contents; `.hidden-stuff` + `node_modules`
    filtered out by default
  - **B** clicking `paper-b.pdf` in the tree opens it in the viewer
    and marks the active row
  - **C** clicking `subdir` expands it; clicking `nested-c.pdf` opens it
  - **D** show-hidden toggle reveals `.hidden-stuff`, `aria-pressed`
    reflects state
  - **E** Cmd+P opens palette, typing "nested" matches nested-c.pdf,
    Enter opens
  - **F** `state.json` captured `root`, `last_opened_doc`, both expanded
    dirs (root + subdir), and `show_hidden: true`
  - **G** relaunch restores the tree title, re-opens nested-c.pdf,
    keeps subdir expanded, and show-hidden remains on
- `/tmp/verify-m6-cli.js` — boots with `--` style argv (positional
  `.pdf`, `open <path>`, `reviewpdf://open?path=...`) and verifies
  the cold-launch external-open queue flushes to the renderer correctly:
  - **H** positional `.pdf` argv opens the file
  - **I** `open <path>` argv form opens the file
  - **J** `reviewpdf://open?path=...` URL argv opens the file

All 10 scenarios PASS. Both scripts are ephemeral — regenerate by re-running.

## Known limitations / nits

- **`expanded_dirs` leak across root changes.** `setRoot` doesn't prune
  the `expanded` Set, so persisted state.json can accumulate paths from
  prior roots. They're inert (no DOM row to attach to) but the file
  grows over time. Filed `rev-sud`.
- **No filesystem watching.** Files added or removed by other processes
  while the app is up don't reflect in the tree or palette index until
  the user changes root or restarts. Filed `rev-s0b`.
- **MD / DOCX dimmed but inert.** The tree classifies them and shows
  them dimmed; clicking does nothing. MD viewer is the natural next
  step (spec §6). Filed `rev-x8j`.
- **CLI shim is dev-only.** Currently shells into `npm run dev --`.
  Real distribution wiring is filed as `rev-xoc` and waits on a
  packaging story.
- **Second-instance flow tested only via cold-launch argv.** Booting
  a true second Electron instance under Playwright would have the
  single-instance lock fight the test harness, so the in-session
  smoke covers the parsing + buffering path but not the literal
  `app.on('second-instance')` callback. Worth a manual smoke if
  multi-instance behavior shifts.
- **No `app.whenReady` race on initial argv.** Single-instance lock
  + `setAsDefaultProtocolClient` + `open-url` listener register at
  module load, which is before `whenReady`. That's deliberate (cold
  URL must not be missed) but means if those calls ever fail loudly
  we'd see it in pre-ready log noise.

## Files touched this session

- `desktop/shared/types.ts` — new IPC types: `OpenFolderDialogResult`,
  `DirEntry`, `FileKind`, `ListDirResult`, `IndexedPdf`,
  `IndexPdfsResult`, `AppStateFile`, `AppStateReadResult`,
  `AppStateWriteResult`, `PathExistsResult`. Six new methods on
  `ElectronAPI` plus the `onOpenExternalFile` push channel.
- `desktop/main/index.ts` — single-instance + protocol setup,
  `extractPathFromArgv`, `queueExternalOpen`/`flushExternalOpens`,
  `primaryWindow` tracking. Six new IPC handlers (`dialog:openFolder`,
  `fs:listDir`, `fs:pathExists`, `appState:read`, `appState:write`,
  `fs:indexPdfs`). Hidden-dir set + `classifyFile` + `isHiddenName`
  helpers.
- `desktop/preload/index.ts` — bridges all six new methods plus the
  external-open ready signal.
- `desktop/renderer/index.html` — left-drawer tree shell with header
  controls + empty state; palette modal markup.
- `desktop/renderer/index.ts` — `bootLeftDrawerAndPalette`, app-state
  save/restore plumbing, the canonical `openFileFromTreeOrPalette`
  entry point, Cmd+P binding, `viewerHandlesRef` exposure to the new
  module. `__APP_READY` marker for verify scripts.
- `desktop/renderer/tree.ts` — new file. FileTree class.
- `desktop/renderer/palette.ts` — new file. QuickOpenPalette class +
  subsequence-fuzzy scorer.
- `desktop/renderer/styles.css` — tree styles (`.tree-header`,
  `.tree-row`, `.tree-chevron`, `.tree-icon`, `.tree-label`, active /
  hidden / dimmed states); palette styles (`.palette`, `.palette-card`,
  `.palette-input`, `.palette-list`, `.palette-row`, `.palette-hl`).
- `desktop/bin/review-pdf-app` — new file. Bash CLI shim.
- This doc.

## Suggested next session — milestone #7 options

**Option C — §10.1 submit → agent handoff.** The "save" half of §10
is done (drafts persistence); the "submit to agent" half is not. This
is where the review work would actually flow to the LaTeX engine.
Significant scope — needs the engine-side contract worked out too.
Estimate: multi-day, blocks on spec gaps in §10.1.

**Option D — §9.2 embedded Claude pane.** node-pty + xterm.js per
§13.4. High UX impact but heavy lift. Estimate: 2–3 days for a usable v1.

**Option E — §6 MD viewer + finish dimmed-tree story.** Render `.md`
files in the middle pane (`rev-x8j`). The tree already classifies and
shows them dimmed; this completes the "open anything the tree shows"
loop. Spec §6 has the design. Estimate: 1 day for a functional viewer,
2 if you want syntax highlighting + nav.

**Option F — knock out remaining M4/M5 P3s + new M6 nits.** rev-6nh
(standalone comments + click-to-anchor), rev-a1x (better persistence
error UI), rev-4qc (multi-page fixture + cross-page revealAnchor),
rev-4pr (backward-drag through bullets — PDF.js upstream), rev-sud
(expanded_dirs leak), rev-s0b (filesystem watching for tree/palette),
rev-xoc (CLI shim distribution). Smaller, spec-edge polish. Estimate:
half-day to a day depending on how many you pick up.

**My recommendation:** Option C. The app is now usable end-to-end for
authoring drafts — Open Folder → tree → click PDF → highlight → comment
→ save. The next thing that unlocks real value is getting those drafts
to actually reach the LaTeX engine. Option D is heavy for what it
delivers right now; Option E is small but doesn't change what the user
can _accomplish_ with the app.
