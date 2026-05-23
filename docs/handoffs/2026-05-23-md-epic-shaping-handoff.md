# Markdown review (rev-mf3) — shape this before scoping

Date: 2026-05-23
Audience: whoever picks up `rev-mf3` after the current dist-and-test cycle settles
Status: beads filed, NO scoping doc written yet, NO code written

## Context — why this matters

`rev-143` is the parent epic to make the reviewer accept non-PDF formats. User asked
for the work order to be `.md` → `.html` → `.docx`. Each is filed as its own
child epic (rev-mf3, rev-2h6, rev-6k6) because the rendering, anchoring, and edit
semantics differ substantially between formats.

`.md` is the load-bearing one. It's the format the user works in most, and the
design decisions there cascade into the other two:

- The `FileViewer` abstraction that `.md` needs is reused by `.html` and (via
  mammoth.js) by `.docx`.
- The drafts sidecar schema extension (adding `anchor.kind='md-line-range'`
  alongside the existing PDF glyph-rect anchor) sets the polymorphism pattern
  for the other two formats' anchor kinds.
- The "edit view vs preview view" UX precedent — if any — is established here.

## What's different about .md

PDF review is a fundamentally one-way modality: the document is immutable, the
user marks it up, the marks are sidecar JSON. `.md` is the opposite: the user
expects to **edit the document itself**, and Obsidian sets that expectation
hard.

User's directive (verbatim, 2026-05-23):

> let's replicate obsidian's way of handling it so there is both an edit view
> and preview view - perhaps with .md we are able to edit directly in the
> upper middle pane - so the behavior is slightly different.

That phrase **"the behavior is slightly different"** is the whole reason this
needs to be shaped, not just specced. The PDF reviewer is built around an
immutable middle pane. Editing breaks several assumptions:

1. Highlights / comments anchored to PDF glyph coords don't translate to a
   character-offset world where edits shift the substrate under the anchor.
2. The saved-indicator state machine (currently: "draft" → "bundled" for PDF
   review) needs a new dimension: was the source modified independently of
   comment activity?
3. The file-tree's "open file" path assumes read-only display. An edit-on-open
   flow needs to surface unsaved-state, conflict-with-on-disk-change, etc.

## The six open questions — these decide everything downstream

Captured in `rev-mf3` description, copied here so a future session doesn't have
to dig:

### 1. Source / preview interaction model

- **Toggle** (Obsidian default — Cmd+E swaps edit/preview)
- **Split** (source left, preview right — Typora's source mode does this)
- **Live preview** (Typora default — WYSIWYG-ish, markdown syntax disappears
  when the cursor isn't on the line)

User said "replicate obsidian's way of handling it so there is both an edit
view and preview view" — that points at toggle as the default. But Obsidian
*also* has a live-preview mode, so "obsidian's way" is ambiguous. Worth
asking.

### 2. Editor implementation

- **Native `<textarea>`** — zero deps, no syntax highlighting, no smart-indent
- **CodeMirror 6** — ~100KB, full editor, syntax highlight, gutters, vim mode
  available
- **Contenteditable** — fiddly cross-browser, but enables live-preview-style
  in-place styling

Recommendation in the bead body: CodeMirror 6 — but it's a real dep and a real
bundle hit. Worth a yes/no from the user before scoping.

### 3. Comment anchoring

- **Line-number-based** (e.g., `{ line: 42, col_start: 10, col_end: 25 }`) —
  simple, but a single line insertion above invalidates all downstream
  anchors
- **Character-offset** (start/end byte or char positions in the file) —
  similar problem, single edit shifts everything
- **AST-node-based** (anchor to "the 3rd paragraph inside section #foo") —
  most stable across edits, but requires parsing on every comment lookup and
  has its own breakage modes (renaming the heading orphans the anchor)

PDF anchoring is glyph-rect (stable forever, file is immutable). For .md the
trade-off is sharper because edits are expected. Worth a written-out scenario
walk-through with the user before locking in.

### 4. Save semantics

- **Every keystroke** (Obsidian default — data loss is impossible, fs churn is
  high)
- **Debounced** (e.g., 500ms idle — feels instant, far less churn)
- **Manual Cmd+S** (legacy, explicit, but you risk losing work)

Debounced is the obvious default. Worth confirming.

### 5. Modified-state model

If a user edits a .md file but doesn't add a comment, has the document changed
in a way the reviewer cares about?
- **Yes** — track "doc modified" separately, surface in the file-tree row or
  status bar, and the bundle export should reflect "current source + sidecar
  comments at time of last save"
- **No** — the document is whatever's on disk; comments float on top; editing
  is a passthrough we don't model

The bundle export semantics in particular need a call here.

### 6. Surfacing markdown-specific syntax

- `[[wikilinks]]` — render? navigate? leave as raw text?
- Frontmatter (YAML between leading `---`) — render as a card? hide? show
  syntax-highlighted?
- Footnotes, task lists, mermaid diagrams — supported through
  remark-gfm (already a dep) + possibly remark-mermaidjs?

Probably defer everything past basic markdown to a follow-up bead, but explicit
"not in v1" decisions make the scoping doc honest.

## Suggested next-session shape

1. **Conversation, not code first.** Walk the six questions with the user, get
   answers, get them recorded in a scoping doc at
   `docs/research/2026-05-NN-md-review-scoped.md` (mirrors the Project 3
   pattern).
2. **Provisional milestone arc** (from the bead, restated for context):
   - M-md-0: viewer abstraction — refactor middle pane to host either PdfViewer
     or a new MarkdownViewer
   - M-md-1: read-only preview using react-markdown + remark-gfm (deps already
     present from agent-pane port)
   - M-md-2: source edit view + the toggle (or split, or live-preview — per Q1)
   - M-md-3: save semantics (per Q4) + saved-indicator update
   - M-md-4: comment anchoring (per Q3)
   - M-md-5: edit-vs-comment interaction (per Q5)
3. **Run the architecture conversation FIRST.** M-md-0 is the load-bearing
   refactor — getting the FileViewer abstraction right makes rev-2h6 and
   rev-6k6 trivial; getting it wrong forces a second refactor. Worth a design
   doc with the user before any code.
4. **Don't ship until M-md-3 at minimum.** A preview-only build (M-md-1) is a
   tease — the user explicitly asked for the editable-in-middle-pane behavior.

## Existing deps that help

All present in `desktop/package.json` from the agent-pane port:

- `react-markdown` ^10.1.0 — preview renderer
- `remark-gfm` ^4.0.1 — tables, task lists, strikethrough
- `shiki` ^4.1.0 — fenced code block syntax highlighting

What needs adding (subject to Q2):

- `@codemirror/state`, `@codemirror/view`, `@codemirror/lang-markdown`,
  `@codemirror/commands` — if CodeMirror is the editor choice
- Possibly `unified` / `remark-parse` / `unist-util-visit` if anchoring goes
  AST-based (Q3)

## Files likely to be touched

- New: `desktop/renderer/md-viewer.ts` (or whole subdir if it grows)
- New: `desktop/shared/md/` for shared types and anchor logic
- Modify: `desktop/main/index.ts:57` classifier (already handles `.md` and
  `.markdown` but currently dead-ends — see `tree.ts:329/369`)
- Modify: `desktop/renderer/tree.ts:329` (remove is-dimmed for md) and `:369`
  (route md to the new viewer instead of skipping)
- Modify: `desktop/renderer/index.ts` middle-pane setup — needs FileViewer
  abstraction
- Extend: drafts schema in `desktop/shared/types.ts` to support multiple
  anchor kinds (currently it assumes PDF glyph rects)

## Related state in the tree

- `desktop/shared/bundle.ts:35-36` — comment that anticipated this: "the
  grammar [for non-PDF formats] is the [extensible part]." Not load-bearing
  but indicates the design wasn't blind to this.

## Cross-references

- Parent epic: `rev-143` (review-non-pdf)
- Siblings: `rev-2h6` (.html, depends on rev-mf3), `rev-6k6` (.docx, depends
  on rev-2h6)
- Adjacent: `rev-a2f` (drafts not restoring on PDF reopen — same drafts code
  path, worth fixing first if it bites during M-md-3)

## Gotchas worth carrying forward

- The drafts sidecar JSON is keyed by document **sha256**. If the user edits
  the .md, the sha256 changes on every save. Anchor recovery cannot rely on
  sha256 identity the way it does for PDF. This is the single biggest
  semantic difference, and it's already invalidating the cross-restart
  reopen invariant from rev-a2f. Resolve before writing M-md-4.
- The agent-pane already has a `[Now viewing: …]` priming line (M-int-3).
  When the active file is a .md being edited, what does the priming say?
  "the user's editing this document" is different from "the user's reviewing
  this document." Worth a thought.
- `electron-builder` config now lives in `desktop/package.json`. If the .md
  viewer adds heavy deps (CodeMirror), check the .dmg size budget hasn't
  exploded before the next tester handoff.
