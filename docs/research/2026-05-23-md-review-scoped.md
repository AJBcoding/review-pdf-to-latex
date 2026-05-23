# Markdown review (rev-mf3) — scoped + decided

Date: 2026-05-23
Supersedes the six-open-questions framing in `docs/handoffs/2026-05-23-md-epic-shaping-handoff.md`. Conversation with overseer 2026-05-23 resolved all six.

## TL;DR

Build a `MarkdownViewer` that drops into the middle pane behind a new `FileViewer` abstraction. Live-preview editing (Obsidian-style) backed by CodeMirror 6 with `@codemirror/lang-markdown` decorations that hide syntax marks off-cursor-line. Debounced save (~500ms). Comments anchor via a hybrid scheme: CM6 char-offset live-mapped during a session via `ChangeSet.mapPos()`, persisted as fuzzy prefix/suffix/quoted-text snippets that survive edits and restarts. Sidecar identity migrates from sha256 to path-mirroring + content-fingerprint fallback for rename recovery — this fold-in fixes rev-a2f's PDF reopen invariant as a side effect.

Sized at ~1.5 weeks. The load-bearing work is M-md-0 (FileViewer abstraction + sidecar identity migration) — getting it right makes rev-2h6 (.html) and rev-6k6 (.docx) drop in cleanly.

## How we got here

The parent epic `rev-143` asks for non-PDF format support in priority order `.md` → `.html` → `.docx`. `.md` is load-bearing because three architectural decisions cascade from it:

1. The `FileViewer` abstraction it needs is reused by `.html` and (via mammoth.js) by `.docx`
2. The drafts sidecar schema extension for polymorphic anchors sets the pattern for the other two
3. The edit-vs-review UX precedent — if any — gets established here

PDF review is one-way: immutable document, sidecar comments. `.md` is the opposite — the user expects to edit. User directive (verbatim, 2026-05-23):

> let's replicate obsidian's way of handling it so there is both an edit view and preview view - perhaps with .md we are able to edit directly in the upper middle pane - so the behavior is slightly different.

The "behavior is slightly different" line is the whole reason this needed shaping. Editing breaks three assumptions the PDF reviewer was built on:

- Highlights anchored to glyph coords don't translate to character-offset world where edits shift the substrate
- The "draft → bundled" saved-indicator state machine has no dimension for "source was modified independently of comments"
- The file-tree's open-flow assumes read-only display; an edit-on-open flow needs unsaved-state and conflict-with-disk surfacing

## Resolved decisions

| # | Question | Decision |
|---|---|---|
| 1 | Source/preview interaction model | **Live preview** (Obsidian-default mode) via CM6 decorations that hide syntax marks off-cursor-line. Not toggle, not split. |
| 2 | Editor implementation | **CodeMirror 6** + `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown`, `@codemirror/commands`. ~100KB bundle hit accepted. |
| 3 | Comment anchoring | **Hybrid:** char-offset live-mapped via `ChangeSet.mapPos()` during edit sessions; persisted on disk as `{prefix: ~40ch, suffix: ~40ch, quoted_text, char_start_hint, char_end_hint}`. Fuzzy match on reopen. |
| 4 | Save semantics | **Debounced ~500ms idle.** Not every-keystroke (avoids fs churn that compounds the anchoring problem), not manual Cmd+S (loses work). |
| 5 | Modified-state + sidecar identity | **Track "doc modified" first-class** in file-tree row + bundle-export semantics + external-modification conflict modal. **Sidecar identity migrates from sha256 to path-mirroring + content-fingerprint fallback** (resolves question below). |
| 6 | Markdown-specific syntax (v1) | GFM basics (tables, task lists, strikethrough — `remark-gfm` already in deps); frontmatter (collapsible card presentation, finalize during M-md-1); `[[wikilinks]]` rendered as in-project links. **Deferred:** mermaid, footnotes, math, custom containers. |

### Q5 sub-decision — sidecar identity scheme

Current state: sidecar at `<dir-of-doc>/.review-state/drafts/<sha256>.json`. The sha256 keying was originally picked specifically so "copying or renaming the PDF doesn't lose the drafts" (`desktop/main/index.ts:40-44`). That property is load-bearing for PDFs and we must not regress it for .md.

For .md the sha256 changes on every save, breaking the lookup. Two paths were considered:

- **Frontmatter ID** (UUID written into doc) — survives renames, but mutates every file on first open. Conflicts with Obsidian/Jekyll/Hugo co-tenancy. Creates a git diff on opening a fresh file. **Rejected.**
- **Path-mirroring + content-fingerprint fallback** — sidecar keyed by document path; fingerprint stored *in the sidecar* (not the doc) for rename recovery. Zero source mutation. **Picked.**

**Sidecar shape:**
- Path: `<dir-of-doc>/.review-state/drafts/<basename>.json` (or hashed-path for deep nesting; finalize in M-md-0)
- Body adds: `doc_fingerprint: { title_from_frontmatter, first_500_chars_sha256, anchor_count, last_known_path }`

**Rename-recovery flow:**
1. User opens `notes/v2/spec.md` — lookup at `notes/v2/.review-state/drafts/spec.json` misses
2. Scan all sidecars under project root; compute current doc's fingerprint
3. If a sidecar's `doc_fingerprint.first_500_chars_sha256` matches → prompt: *"Found drafts for what looks like this file at `notes/v1/spec.md`. Relink?"*
4. On confirm: move sidecar to new path, update `last_known_path`. On decline: ignore.

**Side effect — fixes rev-a2f.** The PDF reopen invariant currently breaks when sha256-keyed sidecars are looked up after a PDF re-export changes bytes. Path-mirroring makes the PDF case work the same way: path is primary key, content-hash is a recovery hint. rev-a2f folds in as an M-md-0 sub-task.

## Architecture readiness

### Deps already present (from agent-pane port at 4da2263 and earlier)

- `react-markdown` ^10.1.0 — preview renderer
- `remark-gfm` ^4.0.1 — GFM extensions
- `shiki` ^4.1.0 — fenced code-block syntax highlight (reusable in preview)

### Deps to add

- `@codemirror/state`
- `@codemirror/view`
- `@codemirror/lang-markdown`
- `@codemirror/commands`
- `@codemirror/language` (for syntax highlighting integration)

Approximate added bundle: ~120KB minified. Pre-flight check before tester-handoff: confirm the .dmg size delta stays under +5MB.

### Files to touch (forecast)

- **New:** `desktop/renderer/md-viewer.ts` (or whole `desktop/renderer/md/` subdir)
- **New:** `desktop/shared/md/anchors.ts` — fuzzy-snippet anchor types + match logic
- **New:** `desktop/shared/file-viewer.ts` — `FileViewer` abstraction interface
- **New:** `desktop/main/sidecar-migration.ts` — one-shot startup migration sha256→path
- **Modify:** `desktop/main/index.ts:43-44` — `draftsPathFor` becomes path-based; add fingerprint write/read
- **Modify:** `desktop/main/index.ts:57` — classifier already routes `.md`/`.markdown`, currently dead-ends
- **Modify:** `desktop/renderer/tree.ts:329, 369` — remove is-dimmed for md, route to viewer
- **Modify:** `desktop/renderer/index.ts` — middle-pane setup picks viewer by classification
- **Extend:** `desktop/shared/types.ts` — `DraftsFile` schema gets polymorphic `anchor.kind` (`pdf-glyph-rect` | `md-fuzzy-snippet`)

## Milestones

### M-md-0 — `FileViewer` abstraction + sidecar identity migration
Foundation. No user-visible .md behavior yet, but everything downstream depends on this.

- Define `FileViewer` interface that `PdfViewer` and `MarkdownViewer` both implement
- Refactor middle-pane mount to pick viewer by classifier output
- Sidecar identity migration:
  - New `draftsPathFor(docPath)` — path-based
  - One-shot startup migration: walk `.review-state/drafts/`, for each `<sha256>.json` look up the matching doc by recomputing hashes, rewrite to `<basename>.json` with `doc_fingerprint` populated
  - Idempotent (safe to re-run; skip already-migrated)
- `DraftsFile` schema gets `anchor.kind` discriminator + `doc_fingerprint` field
- Fold rev-a2f into this milestone — close it as resolved-by-M-md-0
- **Acceptance:** PDFs still open with their drafts; renamed PDF opens with relink prompt; existing on-disk sidecars migrated on first launch; all 84 existing vitest tests still pass; new tests cover migration + rename-recovery

### M-md-1 — read-only `.md` preview
First user-visible .md support.

- `MarkdownViewer` mounted via `FileViewer` for `.md`/`.markdown`
- Preview uses `react-markdown` + `remark-gfm` + shiki for code blocks
- Frontmatter rendered as a collapsible card at the top (presentation finalized here)
- `[[wikilinks]]` resolved against project file index — clickable, navigate within tree
- File-tree no longer dims .md rows
- **Acceptance:** every .md in the demo set renders correctly; frontmatter card collapses; wikilink navigates; copy/paste of preview text works

### M-md-2 — CodeMirror 6 live-preview editor
The core editing UX.

- CM6 mounted in `MarkdownViewer` with `@codemirror/lang-markdown`
- Decorations hide syntax marks (`*`, `_`, `#`, `[`, `]`, `(`, `)`, fence backticks) on lines without the cursor
- Cursor on a line reveals the marks for that line only
- Code blocks stay fenced, no decoration removal
- No save yet (in-memory only this milestone)
- **Acceptance:** typing in middle pane feels like Obsidian; mark hiding is glitch-free during cursor movement; arrow keys/selection behave correctly

### M-md-3 — debounced save + modified-state model
Persistence + state machine.

- Debounced 500ms-idle write to disk
- `documentModifiedById` store slice tracks per-file modified state (separate from `draftsModifiedById`)
- File-tree row indicator: dot/asterisk for source-modified, existing indicator for draft-comments
- Bundle export uses on-disk source at time of export + sidecar comments at time of export — snapshot semantics
- External-modification detection: file watcher on open .md files; if disk-mtime advances and we have unsaved changes → modal "File modified externally, reload (lose your changes) or keep (will overwrite)?"
- **Acceptance:** edit-pause-check-disk shows new contents; close-reopen restores edits; external rewrite triggers the modal; bundle reflects current state

### M-md-4 — comment anchoring (hybrid scheme)
Comments on `.md` regions.

- Selection-to-comment flow in `MarkdownViewer` mirrors PDF reviewer's
- On comment create: capture `{char_start, char_end, prefix: 40ch, suffix: 40ch, quoted_text}` + CM6 anchor for live-tracking
- During session: `ChangeSet.mapPos()` migrates anchors as user edits; comments stay attached
- On save: persisted as `md-fuzzy-snippet` anchors in the sidecar (alongside `pdf-glyph-rect` anchors for PDFs)
- On reopen: fuzzy-match anchors against current file content; orphaned anchors surfaced as "lost anchor" in comment list (still readable, no position)
- **Acceptance:** create comment → edit around it → comment stays attached; quit and reopen → comment re-anchors; delete the quoted text → comment shows as orphaned (not lost)

### M-md-5 — edit-vs-comment interaction polish
The agent-pane priming line, conflict cases, and the small UX nits surfaced by use.

- Agent-pane `[Now viewing: …]` priming reflects "user is editing X" vs "user is reviewing X" (the .md vs .pdf distinction)
- Multi-line selection behavior matches PDF reviewer (or diverges intentionally — call to make here)
- Save-on-blur as a safety net even with debounce in flight
- Undo/redo integration with CM6 history
- **Acceptance:** demo flow: open project → open .md → edit a paragraph → add a comment on a separate paragraph → quit → reopen → both the edit and the comment are there

## Out of scope (v1) — explicit deferrals

- Mermaid diagrams (file as a follow-up bead under rev-mf3)
- Footnotes, math (LaTeX), custom containers
- Vim/emacs keybindings (CM6 supports it, defer to user request)
- Multi-file outline view / table of contents pane
- Co-editing with external tools while file is open (we surface the conflict modal, we don't merge)
- `.md` → bundle export getting a special "edited document" provenance section in the PDF — file as a follow-up if exporters want it

## Open follow-ups to file as beads

- **PDF sidecar migration tooling** — if M-md-0's auto-migration misses cases, a manual `npm run migrate:sidecars` would help. File after M-md-0 if needed.
- **Sidecar fingerprint enrichment** — beyond `first_500_chars_sha256`, consider per-section fingerprints for partial-edit relink. Defer until rename-recovery accuracy proves insufficient in practice.
- **Frontmatter editor affordance** — currently we render frontmatter as a card; eventually a form-style editor would be nicer. M-md-6 candidate.
- **Bundle export semantics for edited docs** — should the bundle PDF include a diff between original-on-open and current? Defer; ask user after M-md-3 ships.

## Related state

- Parent epic: `rev-143` (review-non-pdf)
- Siblings: `rev-2h6` (.html, depends on M-md-0), `rev-6k6` (.docx, depends on rev-2h6)
- Folded in: `rev-a2f` (drafts not restoring on PDF reopen — resolved by M-md-0's sidecar identity migration)
- `desktop/shared/bundle.ts:35-36` anticipated polymorphic anchors — not load-bearing but indicates the design wasn't blind to this

## Gotchas carried forward (still relevant during build)

- **`.dmg` size budget** — CM6 adds ~120KB. Re-check `desktop/release/Review PDF-0.0.1-arm64.dmg` size delta before next tester handoff.
- **Agent-pane priming** — when active file is a `.md` being edited, the `[Now viewing: …]` line semantics shift. Resolved in M-md-5 but worth keeping in mind during M-md-2/3.
- **Migration idempotency** — startup migration runs every launch; must be cheap and safe to re-run. Skip sidecars that already have `doc_fingerprint`.
- **CM6 + React lifecycle** — CM6 manages its own DOM; integration with the existing renderer's vanilla DOM in `desktop/renderer/index.ts` needs care (we're not in React land here, which actually simplifies it — CM6 mounts to a plain element).
