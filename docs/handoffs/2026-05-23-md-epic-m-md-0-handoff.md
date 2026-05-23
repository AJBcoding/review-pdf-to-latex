# M-md-0 handoff: FileViewer abstraction + sidecar identity migration

Date: 2026-05-23
Bead: rev-mf3.1
Parent epic: rev-mf3 (Markdown review)
Scoping doc: `docs/research/2026-05-23-md-review-scoped.md`

## Context

This session resolved the 6 open questions for the .md review epic (rev-mf3) and wrote the scoping doc. Then swept 10 desktop bugs (rev-exa, 10/10 closed). All pushed.

M-md-0 is the load-bearing foundation — no user-visible .md behavior, but everything downstream (M-md-1 through M-md-5, plus rev-2h6 and rev-6k6) depends on the two things it delivers:

1. **FileViewer abstraction** — the middle pane currently hardcodes PdfViewer. This refactor makes it host either PdfViewer or MarkdownViewer (and later HtmlViewer, DocxViewer).
2. **Sidecar identity migration** — sidecars currently keyed by sha256 (breaks for .md where content changes on every edit). Migrate to path-mirroring with content-fingerprint fallback for rename recovery. This also fixes rev-a2f (PDF reopen bug, closed as folded-in).

## What to build (from the bead + scoping doc)

### Part 1: FileViewer interface

- New file: `desktop/shared/file-viewer.ts`
- Define a `FileViewer` interface with the surface area PdfViewer already provides (mount, unmount, page navigation, etc.)
- Make the existing `PdfViewer` in `desktop/renderer/index.ts` conform to it
- Refactor middle-pane mount in `desktop/renderer/index.ts` to pick viewer by classifier output from `desktop/main/index.ts:57`
- The classifier already handles `.md`/`.markdown` extensions but currently dead-ends at `tree.ts:329` (dimmed) and `:369` (skip)

### Part 2: Sidecar identity migration (sha256 → path-based)

**New `draftsPathFor`:**
- Current: `desktop/main/index.ts:43-44` — `<dir>/.review-state/drafts/<sha256>.json`
- New: `<dir>/.review-state/drafts/<basename>.json` (or hashed-path for deep nesting — decide during build)
- Update `drafts:read` and `drafts:write` IPC handlers to use path-based lookup

**Startup migration (`desktop/main/sidecar-migration.ts`):**
- Walk `.review-state/drafts/` for each known project root
- For each `<sha256>.json`: recompute doc hashes to find the matching doc, rewrite to `<basename>.json` with `doc_fingerprint` populated
- Idempotent — skip already-migrated (has `doc_fingerprint`)
- `doc_fingerprint` shape: `{ title_from_frontmatter, first_500_chars_sha256, anchor_count, last_known_path }`
- Call at app startup, before any doc is opened

**Rename-recovery flow:**
1. Open doc at path P → lookup sidecar at path → miss
2. Scan sidecar dir for `doc_fingerprint.first_500_chars_sha256` match
3. If match → prompt user: "Found drafts for this file at <old-path>. Relink?"
4. On confirm: move sidecar to new path, update `last_known_path`

### Part 3: Schema extension

- `desktop/shared/types.ts`: `DraftsFile` gets:
  - `anchor_kind` discriminator: `'pdf-glyph-rect' | 'md-fuzzy-snippet'`
  - `doc_fingerprint` field (optional, populated by migration + on every save)
- Keep backward-compat: existing sidecars without `anchor_kind` default to `'pdf-glyph-rect'`

## Important context from this session

- **rev-9sj fix (this session)**: added an in-memory `draftsCache` in `desktop/renderer/index.ts` keyed by `path\0sha256`. When you change `draftsPathFor` to path-based, update the cache key accordingly (drop the sha256 component, or keep it as a secondary dimension).
- **rev-x32 fix (this session)**: added `lastDocSwitch` and `buildDocPrimingLine()` in `desktop/main/agent-pane-ipc.ts` for session re-priming. These read from `flushDocSwitch` which calls `ensureSession()` — no interaction with sidecar code, but worth knowing the IPC topology.
- **rev-a2f is closed** as folded into this milestone. The root cause was sha256-keyed lookup failing when PDF bytes change (re-export). Path-based keying fixes it.

## Files to touch (forecast)

- **New:** `desktop/shared/file-viewer.ts`
- **New:** `desktop/main/sidecar-migration.ts`
- **Modify:** `desktop/main/index.ts` — `draftsPathFor`, `drafts:read`, `drafts:write`, classifier routing, startup migration call
- **Modify:** `desktop/renderer/index.ts` — middle-pane viewer dispatch, `draftsCache` key update
- **Modify:** `desktop/renderer/tree.ts:329, 369` — stop dimming .md, route to viewer
- **Modify:** `desktop/shared/types.ts` — `DraftsFile` schema extension

## Acceptance criteria (from bead)

- PDFs still open with their drafts after migration
- Renamed PDF opens with relink prompt via fingerprint match
- Existing on-disk sha256-keyed sidecars migrated on first launch
- All 84+ existing vitest tests still pass
- New tests cover: migration idempotency, rename-recovery flow, path-based lookup
- FileViewer interface defined and PdfViewer implements it

## Deps already in place

- `react-markdown` ^10.1.0, `remark-gfm` ^4.0.1, `shiki` ^4.1.0 — all in `desktop/package.json` (not needed for M-md-0, but confirms M-md-1 has no dep install)
- 84 vitest tests across 5 test files
- 468 Python tests (engine side, not touched by M-md-0)

## What NOT to build in M-md-0

- No MarkdownViewer implementation (that's M-md-1)
- No CodeMirror deps (that's M-md-2)
- No .md editing, saving, or comment anchoring
- No wikilink resolution
- The FileViewer interface should be defined, and PdfViewer should implement it, but MarkdownViewer is just a stub/placeholder

## Quality gates before closing

```bash
cd desktop && npx vitest run        # 84+ tests
npx tsc --noEmit -p tsconfig.json   # zero type errors
npm run build                       # clean production build
npm start                           # app launches, open a PDF, drafts load
```
