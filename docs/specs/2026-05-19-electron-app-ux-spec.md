---
type: spec
status: draft (post-brainstorming-pass 2026-05-19; awaiting AJB final review)
date: 2026-05-19
author: Anthony Byrnes (dictated); organized by Claude (Opus 4.7, 1M context); gaps resolved via /superpowers:brainstorming
scope: Electron app UX — review/comment/redraft workflow for PDF + Markdown (Word later)
supersedes-fragments-of:
  - docs/specs/2026-05-16-review-pdf-to-latex-design.md  §10 (sidecar UX is now obsolete per electron pivot)
predecessors:
  - docs/handoffs/2026-05-17-electron-pivot-handoff.md  (§4 layout L1/L2/L3 picks are answered here)
  - docs/handoffs/2026-05-18-ux-research-and-bug-screenshots-handoff.md
related-research:
  - docs/research/2026-05-16-existing-tools-survey/SCREENSHOTS.md  (patterns harvested from 18 candidates)
  - docs/research/2026-05-17-ready-bugs-ux/  (live captures of the three pre-pivot ready bugs)
---

# Electron app UX spec

## 1. North star

A desktop app for reviewing documents — adding comments, redrafts, and structural notes — then handing those off to an AI agent to apply. The user (AJB primarily) drives review; the AI is a second-class citizen in the layout (an embedded chat surface in a corner), not the focus. Three document types in scope: **PDF** (primary), **Markdown** (rendered, not source-edit view), and **Word** (later — treat as PDF-like for now).

This spec answers the open layout question from the [Electron pivot handoff](../handoffs/2026-05-17-electron-pivot-handoff.md) §4. It does **not** answer §1 (Python bundling), §2 (rebuild scope), §3 (repo strategy), or §5 (Gas City integration). Those are flagged in §13 below.

## 2. Layout — three-pane

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ left drawer       │ middle pane                       │ right drawer        │
│ (file tree)       │ (document + bottom input pane)    │ (comments + Claude) │
│                   │                                   │                     │
│  📂 Project A     │  ┌─────────────────────────────┐  │  ┌───────────────┐  │
│   📄 doc-1.pdf    │  │                             │  │  │ Comments      │  │
│   📄 doc-2.pdf    │  │     [document viewer]       │  │  │ (in doc       │  │
│   📂 subfolder    │  │                             │  │  │  order)       │  │
│     📄 notes.md   │  │                             │  │  │               │  │
│  📂 Project B     │  │                             │  │  │ • p4 highlight│  │
│   📄 spec.md      │  │     [tool palette]          │  │  │ • p4 redraft  │  │
│                   │  ├─────────────────────────────┤  │  │ • p7 comment  │  │
│                   │  │ comment / redraft input     │  │  │ • p9 highlight│  │
│                   │  │ (Comment | Redraft toggle)  │  │  │   ...         │  │
│                   │  │                             │  │  ├───────────────┤  │
│                   │  └─────────────────────────────┘  │  │ embedded      │  │
│                   │                                   │  │ Claude (~1/3) │  │
│                   │                                   │  └───────────────┘  │
└───────────────────┴───────────────────────────────────┴─────────────────────┘
```

This is "L4" — a hybrid evolution of the L1/L3 sketches in the pivot handoff. Differences from the prior sketches: the middle pane has its own bottom input sub-pane, the right pane splits 2/3 comments + 1/3 Claude, and there's a dedicated file-tree drawer on the left.

## 3. Left drawer — file tree

A general-purpose file viewer scoped to a single root folder — opens any repo or directory. v1 opens one document at a time in the middle pane.

### 3.1 Root model

Obsidian-opens-a-repo-root: the user opens a folder; the tree shows that folder's contents, with nested subdirectories expanding inline. To switch roots, "Open Folder…" replaces the tree. The §2 ASCII ("Project A", "Project B") is illustrative of a parent folder with two project subdirs — not a multi-root workspace concept.

### 3.2 What the tree shows

- All files in the root are visible.
- PDF / MD (and later Word) files open in the middle pane on click. Other files are dimmed in the tree — they exist, they're inert to this app.
- Hidden by default: `.git/`, `node_modules/`, `__pycache__/`, `.venv/`, `dist/`, `build/`, and dotfiles. A "show hidden" toggle in the drawer header reveals them. (For v1 this is a hardcoded ignore list; a `.reviewignore` file is a future extension.)

### 3.3 Launch behavior

App config remembers root + last-opened doc + tree-expansion state (stored at `~/Library/Application Support/<app>/state.json` on macOS). On launch:
- If the remembered root still exists → reopen tree, reopen last doc.
- If not → empty tree + "Open Folder…" prompt.

### 3.4 External handoff (CLI + URL scheme)

Other processes — most commonly a Claude session in Gas Town — can hand a specific document to the app:

- **CLI shim:** `review-pdf-app open <path>` (bundled with the app).
- **URL scheme:** `reviewpdf://open?path=/abs/path/to/file.pdf`.

Single-instance is enforced via Electron's `app.requestSingleInstanceLock()` + `second-instance` event. If the app is not running, the handoff launches it and opens the doc. If the app is running, the existing window focuses and the middle pane pivots to the requested doc (the current doc's draft state is preserved per §10.3 — no work lost).

v1 arg surface is just `path`. The shim accepts trailing `key=value` pairs and reserves the namespace for future args (`--page N`, `--comment-id X`, `--anchor "..."`); v1 ignores unrecognized keys with a warning.

### 3.5 Quick-open palette (Cmd+P)

`Cmd+P` opens a modal fuzzy-match palette across all openable files in the root (PDF / MD / Word). Type a partial name; arrow keys + Enter selects; opens in the middle pane. Limited to openable file types — non-supported files in the tree are filtered out of the palette even though they're visible in the tree.

Recents and pinned sections are intentionally **not** v1. Add when AJB feels their absence.

## 4. Middle pane — document viewer + bottom input

### 4.1 Document viewer (top section)

Renders the open document. Per-doc-type behavior in §5, §6, §7.

Common to all doc types:
- **Magnification.** PDF: zoom in/out. MD/Word: text-size increase/decrease. (PDF can't change text size — but zoom covers it.)
- **Dark/light toggle.** Native for MD. Open question whether feasible for PDF + Word (probably renders to canvas with inverted color matrix; needs spike). Toggle should live in the same place across doc types.

### 4.2 Tool palette (between viewer and input)

Small icons, not big buttons. At minimum:

| Icon | Action | Notes |
|------|--------|-------|
| 💬 Comment | Add a comment (no text change requested) | The "fix this, here's why" path |
| ✏️ Redraft | Highlighted text → bottom input pre-populated for editing | The "swap this sentence for this one" path |
| 🌊 Surface | Escalate this section to a chat-driven brainstorm with Claude | The "this needs a rethink" path (see §11) |

(The dictation listed "Comment / Redraft / Redraft / Surface" — second Redraft is taken as a typo and dropped. AJB to confirm whether something else belongs there, e.g., Strikethrough as a top-level tool vs. a sub-mode of Redraft.)

### 4.3 Bottom input sub-pane (below viewer)

A single input area at the bottom of the middle pane, **always present**. This is the universal place to type any comment or redraft, instead of typing in the right margin (Word/Acrobat model). Mode is set by a toggle/prefix-button at the input.

Behavior:
- **Highlight + Comment tool** → input gets focus; user types comment; Enter submits.
- **Highlight + Redraft tool** → highlighted text is **populated into the input** as the starting point for editing. User edits in place, OR clicks "✗ Clear" (upper-right) for a blank field. Enter submits — the edited text becomes the redraft payload attached to the comment.
- **Friction reductions:**
  - Plain Enter submits (not Cmd+Enter, unlike Word/Acrobat).
  - Shift+Enter for soft return inside the input.
  - After submit, the active tool **stays active** so the next highlight-and-comment cycle is one fluid motion. (In Acrobat the user has to re-grab the comment tool after each comment; this kills throughput.)
- **No half-typed persisted state.** Comments are persisted to the draft file (§10.3) only on Enter. The input buffer is in-memory until then — close the app mid-typing and you lose the buffer, not a comment.

## 5. PDF-specific behavior

### 5.1 Tools available on PDF

- **Highlight + comment.** Highlight a region, comment is captured against it. (v1 PDF tool.)
- **Strikethrough** and **standalone comment** are deferred to v2 (see open-questions table). M7 ships highlights-only; the strikethrough/standalone gestures and tool-palette surface are not yet implemented. v1 users anchor every comment to a text selection — AJB's review-against-source workflow supports this.

### 5.2 Highlight must capture underlying text (load-bearing)

Yesterday's COTA run surfaced a class of bug: the highlight layer lives **on top of** the PDF and is not directly bound to the text glyphs underneath. When the PDF was corrupted, highlights drifted off the words. Worse: the AI had to *guess* what the underlying words were from the highlight region's coordinates.

**Requirement:** when the user highlights, the app must extract the underlying text immediately and attach **both the region AND the text** to the comment payload. The AI receives a structured payload like:

```json
{
  "page": 4,
  "region": {"x": 72, "y": 540, "w": 410, "h": 18},
  "highlighted_text": "COTA enrollment grew substantially over the past five years",
  "comment": "tighten this — drop 'substantially'",
  "redraft": null
}
```

This directly addresses the root cause behind ready-bug `rev-9m5`/`rev-fv6` (sticky-note ↔ highlight ↔ text mismatch) — see [bug screenshots](../research/2026-05-17-ready-bugs-ux/).

**Implementation primitive:** PDF.js's `TextLayer` rendered over the canvas, with native browser text selection (drag-to-select snaps to actual glyphs). This was validated by the [PDF text-layer spike](../research/2026-05-20-pdf-text-layer-spike/README.md) on 2026-05-20. The captured payload's `region` falls out of `Range.getClientRects()` — no geometric intersection math required, which is what made `§13.11` (coordinate accuracy) tractable.

**Behavior on damaged PDFs.** The spike confirmed that broken PDFs are a real and recurring failure shape (the `rev-fv6` COTA file: 137 stream errors, 8 of 10 pages render blank, missing ToUnicode maps cause ligature loss). The app must handle them explicitly:

1. **PDF-health pre-flight at load time.** The renderer calls `review-pdf pdf-health <path>` (see [design spec §8](../specs/2026-05-16-review-pdf-to-latex-design.md#8-cli-surface)) on every loaded PDF and surfaces a non-blocking banner when problems are detected. Example:
   > "⚠ This PDF appears partially damaged: pages 3–10 contain no readable text. Likely cause: the file was re-saved or annotated by a tool that corrupted its content streams. **Recommended:** rebuild the PDF from source. You can still review pages 1–2."

2. **Inline quality warning at highlight time.** If the captured text matches a ligature-replacement heuristic (`veri ed`, `e cient`, `con dence`, …), the comment card shows a small "⚠ captured text may be incomplete" badge, and the payload carries `"text_quality": "degraded"`.

3. **Region always captured, even when text capture returns empty.** On blank/unreadable pages, the user can still drag-select a region in the renderer's fallback "region-select" mode. The payload becomes `{"region": {...}, "highlighted_text": "", "text_unavailable": true}` — the agent gets coordinates plus surrounding-page context, and may ask the user for clarification.

4. **No OCR fallback in v1.** The v1 audience (AJB + python419) reviews their own LaTeX projects; when a PDF is broken, rebuilding from `.tex` source is faster than OCR. Tesseract.js as a region-OCR fallback is deferred until a non-developer user hits this.

The full reasoning, test methodology, and decision rationale are in the [spike README](../research/2026-05-20-pdf-text-layer-spike/README.md).

### 5.3 Save behavior

- **Save As** with version bump: `report-1.0.pdf` → `report-1.1.pdf`, optionally with initials: `report-1.1 (AJB edits).pdf`.
- Save back to the **source file's directory**.
- **Never overwrites the original.** v1.0 is sacred.
- The save event is also the handoff event: it's what hands the structured comment payload over to the AI for the next-round redraft (see §9, §10).

## 6. Markdown-specific behavior

### 6.1 Rendered, not source

MD opens in **polished view** (the rendered HTML output), not the raw `.md` editor view. Text-size increase/decrease works here. Dark mode is native (white text on dark background).

### 6.2 Inline notes — replaces bracket-comment hack

In yesterday's workflow AJB had to bracket-comment inline in `.md` files (`[[note to agent: ...]]`) to leave instructions for the next AI pass. The Electron app should make this first-class.

Required behaviors:
- **Click-into-position** — insert a note at a point (before a chart, before a table, between paragraphs).
- **Highlight + comment** — same as PDF: select text, comment attaches to that range.
- Each comment is typed as either **agent-note** (instruction for the AI) or **user-note** (note for self / future collaborator). Color-coded in the right drawer.

### 6.3 Comment syntax persisted in the .md

When the document is saved back (§10.1), inline notes are persisted as **HTML comments**:

```markdown
Some paragraph here.

<!-- agent-note id=abc123 L1: tighten this sentence -->

Next paragraph.
```

For longer notes (especially L3 Surface threads), block form:

```markdown
<!-- agent-note id=def456 L3
This needs a rethink — the framing assumes X but the data shows Y.
[further user notes...]
-->
```

Why HTML comments:
- Invisible in the rendered output (§6.1 is the canonical view).
- Inline locality preserved physically — the note lives between the paragraphs it refers to; no anchor-string-matching required.
- Doesn't collide with Obsidian's `[[...]]` wikilink namespace.
- Survives copy-paste and email; the `.md` carries the notes with it.
- Agents (Claude, GPT, anyone) already treat HTML comments as instructions in markdown.

The `id=` field is a UUID that links the inline anchor back to the full payload in `.review-state/drafts/<doc-version>.json` (engagement level, `derived_from` chain, status, redraft, etc.). The inline comment carries only a short summary + level; the JSON carries the rest.

### 6.4 Bottom input: kept, not replaced by in-place edit

For consistency across doc types, MD uses the bottom input pane (§4.3) — the same Comment / Redraft / Surface workflow as PDF. In-place edit of the rendered MD is **not** v1; defer until a use case emerges.

## 7. Word-specific behavior

Out of scope for v1 detail. Treat as PDF-like (highlight + comment + redraft, captures underlying text). Confirm if/when Word becomes a real workflow.

## 8. Comment data model

Each comment has:

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | UUID |
| `doc_id` | string | path-relative-to-root, or stable ID |
| `doc_version` | string | **sha256 of the source-file bytes** — keys the draft to a specific file. Not to be confused with the user-facing source-file version (`-1.0`/`-1.1` in filenames, §10.6) or with the bundle date prefix (§10.4). |
| `anchor` | object | doc-type-specific: PDF region+text, MD char-range or position, etc. |
| `highlighted_text` | string | always captured when a highlight exists |
| `comment` | string | the user's note (instruction, observation, question) |
| `redraft` | string\|null | new text to swap in, if user provided one |
| `redraft_suggestion` | string\|null | agent's proposed redraft from live-redraft (§10.2) — distinct from user's `redraft` |
| `engagement_level` | enum | `comment` (L1) / `redraft` (L2) / `surface` (L3) — see §11 |
| `author` | string | "AJB" v1; multi-user later |
| `kind` | enum | `agent-note` / `user-note` (MD); `comment` / `strikethrough` (PDF) |
| `status` | enum | `open` / `submitted` / `applied` / `deferred` / `needs-followup` / `rejected` / `build_failed` — see §8.5 |
| `submitted_at` | timestamp\|null | set when comment is promoted into a submit file |
| `derived_from` | comment_id\|null | links a re-raised v1.1 comment back to its v1.0 origin |
| `pdf_annotation_id` | string\|null | for PDF docs only — links this comment to the corresponding annotation in the rendered bundle PDF (§10.4) |
| `created_at` | timestamp | |

Two workflows the model needs to support cleanly:
1. **Pure comment** — "This statistic is screwy, look it up or delete it." `redraft` is null; AI decides what to do.
2. **Direct redraft** — "Swap this sentence for this new sentence." `redraft` is set; AI applies it verbatim on the next round.

### 8.5 Lifecycle

```
        ┌──────┐    Submit    ┌───────────┐    rig processes      ┌─────────────────────┐
created │ open │  ─────────→  │ submitted │  ──────────────────→  │ applied             │
   ───→ │      │              │           │                       │ deferred            │
        └──────┘              └───────────┘                       │ needs-followup      │
            ▲                                                     │ rejected            │
            │                                                     │ build_failed        │
            │                                                     └─────────────────────┘
            │                  for deferred + needs-followup:             │
            └─── new comment in v1.1 draft, derived_from = original ←─────┘
```

Rules:
- **`open`**: default state on creation. Mutable: edit text, change level (§11), change redraft, delete.
- **`submitted`**: set when the comment is promoted into a submit file (§10.3). Immutable from this point — frozen for audit.
- **`applied` / `deferred` / `needs-followup` / `rejected` / `build_failed`**: terminal states written by the rig into the results file (§10.3). The app reflects these into the live draft via the results-file watcher (§10.1 step 5 / §10.3).
- **`build_failed`**: introduced in the round-based flow. Set when an edit applied cleanly but the post-apply LaTeX build failed; the rig reverts the edit and marks this status, preserving the build-error message in `agent_note`. Re-raises into the next round's draft (see Round-trip re-raise below) — the user's intent was good, only the engine failed, so the comment deserves another pass rather than being silently archived.
- **Round-trip re-raise**: when v1.1's draft is seeded (§10.1 step 5), `deferred` + `needs-followup` + `build_failed` items are *copied* into the new draft as fresh `open` comments, with `derived_from: <original_id>` linking back. `applied` and `rejected` are archived only. v1.0's archived comment retains its terminal status; the v1.1 fresh comment starts the cycle over.

The `derived_from` chain lets the right drawer (§9.1) render "re-raised from v1.0" badges for L3 Surface items that span multiple rounds.

## 9. Right drawer — comments + embedded Claude

### 9.1 Top ⅔ — comment stream in document order

- Comments listed in the order they appear in the document, **not chronologically**.
- Inserting a comment at the top of the doc nests it into the right position in the list — scrolling the comments drawer mirrors scrolling the doc.
- Color-coded by `kind`: agent-note vs user-note. Distinct color for `redraft` vs `comment`.
- **Filter chips** at the top of this section:
  - by kind: "All / Agent notes / User notes"
  - by status (§8.5): "All / Open / Submitted / Applied / Deferred / Needs-followup / Rejected / Build failed"
  - by level (§11): "All / L1 / L2 / L3"

  Defaults to "All" on each axis. Multi-select within an axis (e.g., "Open + Needs-followup" both shown).
- Re-raised items (with `derived_from` set) get a badge ("from v1.0") and link to the original in the archived submit file.

### 9.2 Bottom ⅓ — embedded Claude

Always-present assistant surface for ad-hoc questions, ad-hoc research, and (in the standalone case) Submit processing. Implemented as `xterm.js` + `node-pty` hosting a `claude` CLI session. Submit handoff in the rig case (§10.1) does NOT go through this pane — it slings to the originating rig via gt mail; this pane is purely for ad-hoc use and the standalone-Submit fallback.

#### 9.2.1 Pty model — two roles

- **Conversational pty** (one global per app instance, persistent). Always-on; survives doc switches. Doc-aware via the doc-switch line (§9.2.4). Hosts the always-on Assistant tab and any ad-hoc chat.
- **Worker ptys** (ephemeral, per-task). Spawned on demand for heavy tasks the user invokes from the toolbar (§9.2.6) — Create Context, Sling, Fresh Start. Each runs to completion (or until user closes) without blocking the conversational pty. Multiple in flight is fine.

The conversational pty is never used for Submit; Submit always slings to a rig (rig case) or to the global Reviewer rig (standalone case, §10.5).

#### 9.2.2 Lifecycle

- **Spawn:** lazy. Conversational pty starts on first PDF/MD open (not on app launch), so users who just browse files don't pay a Claude-process cost. The ~1–2s boot is hidden behind their doc-opening flow.
- **Death:** killed on app quit (SIGTERM with SIGKILL fallback). On spontaneous crash, the pane shows `Claude session ended. [Restart]` and the restart re-applies the priming message.
- **Scrollback persistence:** none across app restarts in v1 (deferred).
- **Binary discovery:** `claude` resolved from `PATH` on spawn. If absent, the pane shows install instructions instead of a terminal.

#### 9.2.3 Skill priming

On spawn (and on every restart), the app injects a one-line priming message into stdin so the session knows to use the `review-pdf-to-latex` skill:

```
Use the review-pdf-to-latex skill for any /review-pdf commands.
```

Visible in scrollback so the user can audit. Wired into the spawn routine itself so crash-recovery re-primes automatically.

Pre-flight check during impl: if `claude --skill review-pdf-to-latex` (or equivalent) is supported by the current Claude Code CLI, swap to that — strictly cleaner (no token cost, no scrollback noise). The priming-message path is the fallback that works regardless.

#### 9.2.4 Doc-switch notification

When the user switches docs (tree click, Cmd+P, external open, etc.), the app injects a single bracketed line into the conversational pty:

```
[Now viewing: report-b.pdf — /Users/anthonybyrnes/.../reports/cota/report-b.pdf (24 pages, 8 comments)]
```

Rules:
- Format: bracketed system-message style with basename + absolute path + page count + comment count
- **Debounced 500ms** — rapid tree navigation (clicking 5 files in a row) only fires the final notification
- **Suppressed on initial pane spawn** — the priming message already establishes initial context

#### 9.2.5 Reviewer rig (gas-town integration)

When gas-town integration is enabled (auto-detected on `gt` binary presence; user-toggleable in Settings), the embedded session runs as a **global Reviewer rig** — its own gas-town identity, not a sub-rig of the user's existing crew. Identity: `reviewer/<you>`. Single global rig per user; one inbox aggregates work from every project where gas-town is enabled.

When gas-town is disabled or undetected, the embedded session is a plain Claude pty without rig identity. The Sling toolbar button (§9.2.6) is greyed out in this case, with a click-to-explain popover ("Enable gas-town integration in Settings to sling to other rigs").

The Reviewer rig is also the destination when standalone Submit picks "Reviewer (local)" (§10.5).

Risk to record: the global Reviewer's audit trail mixes work across all projects. Cross-project memory is the upside; cross-project privacy bleed is the cost. Solo use makes this fine; reconsider if the app gains multi-user scope.

#### 9.2.6 Toolbar — three icon buttons

Above the conversational pty. All three open a small modal for the user to type a prompt + optional context tweaks before invoking. Icons are placeholders to be picked from candidate emoji sets — see bd `rev-ul7`.

| Button | Action | Notes |
|---|---|---|
| **🆕 Create Context** | Bundle current context (doc path, current page, active selection, surrounding section heading, nearby comments) + user prompt; spawn a fresh worker pty pre-primed with the bundle. Two modes the user picks in the modal: **single-shot** (interactive conversation) or **Ralph loop** (agent iterates N times). | Worker pty appears as a tab in the right drawer bottom (up to 3 tabs); overflow goes to the tasks panel (§9.2.7) only. |
| **🪃 Sling** | Bundle current context (same shape as Create Context) + destination; sling via `gt mail` to: mayor, a specific rig, a specific crew. | Requires gas-town enabled. Otherwise greyed with explanatory popover. |
| **🔄 Fresh Start** | Bundle a handoff summary of what's been done in the conversational pane + what matters next; kill the conversational pty, respawn, inject the handoff as the priming message. | Works regardless of gas-town. Reuses the `/handoff` skill pattern. |

#### 9.2.7 Worker visibility (β + γ combined)

Two complementary surfaces show what worker ptys are doing:

- **Inline progress strip (β)** — a thin band above the conversational pty. Empty when no workers are active; otherwise one row per active worker: `⟳ Submit — applying redraft 4 of 12 (§3.1) [log]`. The `[log]` link expands the worker's full stdout in a focused panel; collapse with another click. On completion, the row briefly shows `✓ … [log]` then fades.
- **Tasks panel (γ)** — opened via an icon in the strip or a small badge in the right drawer header. Lists running + recently-completed + failed jobs with `[log]` and `[↻ retry]` per row. Persists job history beyond the strip's brief fade.

Tabs and γ panel relationship for Create Context spawns:
- First 3 spawns get tabs in the right-drawer bottom (alongside the pinned "Assistant" tab for the conversational pty)
- 4th+ spawn appears as a row in γ only (no tab)
- Closing a tab kills the worker (and removes from γ)
- Closing a γ row kills the worker
- No tab↔panel promotion/demotion gestures in v1

Per-step progress text on the strip (e.g., "applied 4 of 12") requires the rig-side skill to emit structured progress markers. If absent, both the strip and γ degrade gracefully to `⟳ <task> running [log]` with raw stdout behind the log link.

#### 9.2.8 Input model

Standard terminal — typing + Enter sends. User can interrupt with Ctrl+C. App-injected slash commands (only used in standalone Submit, §10.5) and user-typed input interleave naturally; nothing is blocked during agent processing.

#### 9.2.9 Theme + working directory

- Theme matches app dark/light mode
- Working directory at spawn = source dir of the currently-open PDF (so relative paths resolve)
- Subsequent doc switches do *not* `cd` the pty — the Reviewer/standalone-Submit flow uses absolute paths from the submit-file / bundle, not the pty's cwd

#### 9.2.10 v2 deferrals (explicitly out of scope for first ship)

- **Tool-call collapsing** per the cloud-desktop / T3 pattern. v1 shows raw pty scrollback; structured-collapse UI requires parsing Claude's tool-call markers from the pty stream — its own feature
- **Scrollback persistence across app restarts**
- **Per-PDF session scoping** (one pty per doc) — global is v1 default
- **Tab↔panel promotion/demotion gestures**
- **Visual ping / "fake save" on Cmd+S** — Cmd+S writes the bundle (§10.4); the "Saved" indicator in the title bar provides reassurance for the autosaving drafts

### 9.3 Live-redraft display rules (interaction between §9.1 and §9.2)

The two-section split (comments-stream + Claude pane) creates an integration question: when a single-comment live redraft (§10.2) happens, where does the AI's response land?

**Rule**: the comment carries the answer; the pane carries the thinking.

- The comment card in the stream shows: original highlighted text, user's `comment` + `redraft` (if user-authored), and — once the agent has responded — `redraft_suggestion`. An "Accept as redraft" affordance on the card copies `redraft_suggestion → redraft`, making the agent's text the authoritative redraft for the next batch.
- The Claude pane (§9.2) shows the agent's reasoning, tool calls (collapsible), and any conversational back-and-forth. Linear scrollback; no per-comment threading (the pty doesn't support it natively).
- The comment card carries a small "✨ replied in Claude" badge with a timestamp; clicking the badge focuses the Claude pane.

This preserves the §1 framing — AI's deliverables attach to the work item; AI's chatter stays in its corner.

## 10. Save / submit / commit flow

There are two distinct save semantics:

### 10.1 Round-based Submit — sling the bundle back to the rig

The Electron app is a review tool inside a longer workflow. The primary launch pattern is: user is working in a crew rig that generated a document, invokes a `/review` skill on the rig side which opens the Electron app preloaded with the doc + origin info (§10.5), reviews in the app, hits Submit, and **the actual work happens back in the originating rig** — not in the embedded Claude pane.

Submit is a *handoff*, not an in-app processing pass. The Electron app's job ends at "package the bundle and sling it." The rig's `/review-pdf process` skill does the mechanical work, runs builds, escalates L3 items conversationally, and writes results back into `.review-state/`.

The user works through comments. When ready: clicks Submit (`Cmd+Return`). The app:

1. **Promotes the draft to a submit file.** All comments in `status: open` on the current doc-version are moved into `.review-state/submit-<timestamp>.json` (frozen, immutable). The matching entries in the live draft (`.review-state/drafts/<sha256>.json`) are updated to `status: submitted, submitted_at: <now>` and remain there as a local record of what was sent. The submit file is the authoritative audit copy; the draft entry is the "what the UI shows for already-sent items" copy.

2. **Writes the review bundle** to the source dir if not already current. Bundle = PDF + JSON sidecar with matching basenames, dated; see §10.4 for full contract. Cmd+S writes this same bundle without firing Submit, so often the bundle is already on disk by the time Submit runs; Submit just confirms it's up to date.

3. **Slings the bundle to the target rig** via `gt mail`. Verbatim invocation:

   ```bash
   gt mail send "<origin_rig>/" \
     --type task --priority 1 --permanent \
     --subject "review-pdf submit · <base>-<source_version> · <bundle_id>" \
     --stdin <<'BODY'
   {
     "schema_version": 1,
     "kind": "review-pdf.submit",
     "app_version": "0.x.y",
     "bundle_id": "<bundle_id>",
     "submit_id": "<submit_id>",
     "origin_rig": "<origin_rig>",
     "destination_rig": "<destination_rig>",
     "source_doc": "<abs path>",
     "submit_file": "<abs path>",
     "bundle_pdf": "<abs path>",
     "bundle_json": "<abs path>",
     "expected_skill": "/review-pdf process",
     "submitted_at": "<iso8601>"
   }
   BODY
   ```

   Notes on the envelope:
   - **Body is a JSON string** (gt mail has no attachment surface; body is one string). Use `--stdin` to avoid shell-quoting bugs on paths with spaces (bundle filenames contain them).
   - **All artifacts are absolute paths**; rig + app share a filesystem (gt assumption), so paths are the cheap transport — no inlined PDF bytes.
   - **Address is the broadcast `<rig>/` form**, not skill-specific. `gt mail` routes to agents, not skills; the rig session decides whether to run `/review-pdf process` based on `expected_skill` + subject prefix.
   - `--type task --priority 1` reflects "required processing, user actively waiting." `--permanent` ensures the round is recoverable if the rig session restarts before pickup.

   Target rig selection:
   - **Rig case** (most common): originating rig recorded via `--from <rig-id>` CLI flag at launch (§10.5). Submit goes there.
   - **Standalone case** (no origin recorded): a destination picker opens (§10.5); user picks Reviewer (local) or another rig.

4. **App enters the `sent_unconfirmed` state and tracks delivery.** A state machine drives the user-visible banners and disables re-submit until the round resolves:

   | State | Transition out | UI |
   |---|---|---|
   | `idle` | `submit-click` → `pending_send` | Title-bar "Saved" indicator only |
   | `pending_send` | `gt-exit-0` → `sent_unconfirmed`; `gt-exit-≠0` → `send_failed`; 30s deadline → `send_failed` | Spinner pill: "Slinging to `<rig>`…"; Cmd+Return hard-locked at IPC boundary |
   | `sent_unconfirmed` | results file appears → `acknowledged`; 10min elapsed → timeout-banner overlay (still `sent_unconfirmed`) | Pill: "Submitted to `<rig>` — awaiting pickup" |
   | `sent_unconfirmed` + timeout | user clicks Re-sling → `pending_send` | Pill + sibling banner: "Still waiting (10 min). [Re-sling] [Show gt mail status]" |
   | `acknowledged` | first `results[]` entry → `processing` | Banner: "Round in progress — 0 of M comments processed" |
   | `processing` | `round_status: complete` → `complete`; `round_status: failed` → `complete-failed` | Banner: "Round in progress — N of M comments processed" (live counter) |
   | `complete` | 5s auto-clear → `idle` | Toast: "Round complete — N applied, M failed. [View results]" |
   | `complete-failed` | user dismisses → `idle` | Persistent banner: "Round failed — see results" |
   | `send_failed` | user clicks Retry → `pending_send` | Persistent error banner with **verbatim gt stderr** + [Retry] |

   **Ack mechanism is implicit.** The rig writes `.review-state/results-<bundle_id>.json` incrementally per Gap 3; its *existence* with `round_status: in_progress` + `results: []` is the acknowledgement, the first appended entry is the heartbeat. No separate ack file. This matches §10.3's existing contract; nothing new on the rig side.

   The user manually switches to the originating rig terminal to continue conversational work (or, if standalone-via-Reviewer, the embedded pane). The Electron app does *not* poll for completion; results arrive via the file watcher (§10.3) and reflect into the UI whenever they land (live if the app is open) or on next doc open (if the app was closed).

5. **Rig processes the bundle.** Rig session starts fresh-context, picks up the handoff, runs `/review-pdf process <submit-file>`. The skill:
   - Reads the submit file and bundle JSON
   - Prompts: easy work first (L1+L2), or surface first (L3)? — smart default of easy-first; user can override
   - For each L1/L2 mechanical edit: apply → build → on build failure, revert and mark `build_failed` with the error in `agent_note`; continue with next comment (per-comment retry-then-skip)
   - For L3 items: pause, ask the user conversationally (sequential in document order; user can skip ahead; mid-L3 interrupt is graceful — completed items keep their disposition, remaining marked `deferred`, partial `results-<ts>.json` written, `round_status: in_progress`)
   - At round end: prompts user for version bump (§10.6) — minor (default) / major / custom
   - Writes new versioned source file (e.g., `report-1.1.pdf` via LaTeX build, or `notes-1.1.md` for MD)
   - Finalizes `results-<ts>.json` with `round_status: complete` and `new_source_path`
   - Single git commit summarizing the round (per §10.6)

6. **App reflects results + enforces concurrent-round lock.** The renderer's file watcher on `.review-state/` (§10.3) picks up the results file as it's written (incrementally per Gap 3 resume mechanism, finalized at round end). The renderer:
   - Updates statuses on matching comments in the live draft → cards re-bucket in the right drawer (§9.1)
   - On `round_status: in_progress` (live), shows: "Round in progress — N of M comments processed"
   - On `round_status: complete`, shows "Round complete — N applied, M failed [view results]" briefly; new versioned source file becomes available in the tree
   - Seeds a fresh draft keyed on the new file's sha256: `deferred` + `needs-followup` + `build_failed` items become fresh `open` comments with `derived_from: <original_id>` (§8.5); `applied` / `rejected` are archived only

   **Concurrent-round Submit lock.** Submit is enabled iff no `results-*.json` for the current `doc_version` carries `round_status: in_progress` AND the in-memory state is in `{idle, complete, send_failed, timeout}`. Cmd+Return is hard-disabled at the IPC boundary in `pending_send`/`sent_unconfirmed` — not just visually — with a belt-and-braces 200ms IPC debounce.

   **On doc open**, the renderer scans `.review-state/` for `results-*.json` matching the current `submit_id`/`doc_version`:
   - **Fresh in-progress** (mtime ≤ 7 days, `round_status: in_progress`) → replace Submit button with the "Resume round in progress" banner; Cmd+Return becomes "focus the rig" rather than fire a new sling. Banner carries `[Abandon round]` secondary action.
   - **Stale in-progress** (mtime > 7 days, `round_status: in_progress`) → different banner: "Previous round didn't finish (started `<date>`, N of M processed) — [Resume] [Abandon and start fresh]." No auto-resume; explicit user choice. A week-old `in_progress` almost certainly means the rig session was abandoned.

   **Abandon semantics.** Renames `results-<ts>.json` → `results-<ts>.abandoned.json`. The `.abandoned` suffix is a soft tombstone: the rig's resume guard ignores it, the app's in-memory state flips to `idle`, Submit re-enables. The file is *not deleted* — partial results may include real L3 dispositions the user wants to consult.

#### 10.1.1 Why this shape (load-bearing reasoning)

- **Originating rig has the natural project context.** It knows the LaTeX source, has the engine on PATH, is already in the project's working tree. The Electron app would have to recreate all of this to process Submit internally.
- **Embedded Claude pane stays purely conversational.** Submit doesn't take it over; ad-hoc chat keeps working during Submit.
- **L3 escalation is natural in the rig.** The user is already in a conversational session with the rig after Submit; pausing on L3 items is just talking with the rig, not a UI hand-off.
- **Standalone case isn't second-class.** The same flow works with Reviewer as target — see §10.5.

### 10.2 Live redraft (single-comment)

For a single comment, the user can request immediate AI action without waiting for the batch. Useful when a redraft suggestion is wanted *during* review, not after.

Behavior:
- A "Redraft now" affordance on the comment card slings a single-comment redraft request to the originating rig (rig case) or to the Reviewer rig (standalone case) — same transport as §10.1 Submit, scoped to one comment. Payload: a synthetic submit file containing just this comment plus `mode: "live-redraft"`.
- The rig session runs `/review-pdf redraft <comment_id>` (a thin wrapper over `/review-pdf process` that processes a single-item bundle in non-mutating mode — no file edits, no build, no commit; the rig proposes a redraft and writes it back into the comment's `redraft_suggestion: <text>` field in the live draft).
- The Electron app's results-file watcher (§10.3) picks up the redraft and renders it inline in the comment card; the user can click "Accept as redraft" to copy `redraft_suggestion → redraft`.
- The source document itself is not modified until the round-based Submit (§10.1).
- If gas-town is disabled and there is no originating rig, "Redraft now" is greyed out with the same explanatory popover as Sling (§9.2.5).

### 10.3 Filesystem contracts

The app and the rig communicate through files under two locations: `.review-state/` (gitignored workspace) and the source directory itself (the bundle, gitable).

| Path | Lifetime | Writer | Reader |
|------|----------|--------|--------|
| `.review-state/drafts/<doc_version>.json` | Live; mutates on every comment edit (debounced 250ms). `doc_version` = sha256 of the source-file bytes (§8) | App | App |
| `.review-state/submit-<timestamp>.json` | Frozen at submit; permanent audit record | App | Rig (consumes); app (renders archived state) |
| `.review-state/results-<timestamp>.json` | Mutates as the rig processes (per-comment atomic append); `round_status` flips `in_progress` → `complete` / `failed` at end | Rig | App (file watcher; reflects status; seeds next draft) |
| `<source-dir>/<date> <base>-<v> (AJB edits).pdf` | Frozen at Cmd+S or Submit; rewritten on next Cmd+S/Submit (same name → overwrites) | App | Anyone (human-portable, gitable) — see §10.4 |
| `<source-dir>/<date> <base>-<v> (AJB edits).json` | Frozen at Cmd+S or Submit (same cadence as bundle PDF) | App | App (round-trip restore), rig, any other tool — see §10.4 |
| `<source-dir>/<base>-<v_new>.{pdf,md,tex}` | Written by rig at round end (§10.6) | Rig | App, user, downstream tools |

All `.review-state/` files are JSON, human-readable, `cat`-debuggable. `.review-state/` is `.gitignore`d by default — local workspace files, not source-of-truth. Bundle and new versioned source files live in the source dir and are *meant* to be committed.

The renderer watches `.review-state/` via `fs.watch` (same watcher infrastructure as the file tree, bd `rev-s0b`). New / changed `results-*.json` files trigger UI status updates in real time. On doc open, the renderer also scans `.review-state/` for any pre-existing results files referencing the current doc and applies their statuses.

Submit file schema (illustrative):

```json
{
  "submit_id": "20260519-143200",
  "doc_id": "report-1.0.pdf",
  "doc_version": "abc123def456...",
  "source_file_version": "1.0",
  "submitted_at": "2026-05-19T14:32:00Z",
  "origin_rig": "report-engine/anthony",
  "bundle_pdf": "/abs/path/2026-05-19 report-1.0 (AJB edits).pdf",
  "bundle_json": "/abs/path/2026-05-19 report-1.0 (AJB edits).json",
  "comments": [
    {
      "id": "abc123",
      "anchor": {"page": 4, "region": {"x": 72, "y": 540, "w": 410, "h": 18}},
      "highlighted_text": "COTA enrollment grew substantially",
      "comment": "tighten this — drop 'substantially'",
      "redraft": null,
      "engagement_level": "L2",
      "kind": "comment",
      "derived_from": null,
      "pdf_annotation_id": "annot-7"
    }
  ]
}
```

Results file schema (rig writes incrementally per Gap 3 resume mechanism):

```json
{
  "submit_id": "20260519-143200",
  "results_id": "20260519-145812",
  "round_status": "in_progress",
  "started_at": "2026-05-19T14:35:00Z",
  "completed_at": null,
  "new_source_path": null,
  "version_chosen": null,
  "results": [
    {
      "id": "abc123",
      "status": "applied",
      "new_anchor": null,
      "agent_note": "Removed 'substantially'; tightened to 12 words."
    },
    {
      "id": "def456",
      "status": "build_failed",
      "new_anchor": null,
      "agent_note": "Apply succeeded but pdflatex errored: Undefined control sequence \\cmd at line 142. Reverted."
    },
    {
      "id": "ghi789",
      "status": "needs-followup",
      "new_anchor": null,
      "agent_note": "This isn't a typo — it's a thesis problem. Suggest re-filing at L3."
    }
  ]
}
```

When the round completes, the rig flips `round_status` to `complete`, fills `completed_at`, `new_source_path` (the path of the new versioned source file), and `version_chosen` (e.g., `"1.1"`).

Status enum: `applied` / `deferred` / `needs-followup` / `rejected` / `build_failed`. A `status: rejected` entry requires a `reason` field. A `new_anchor` is set when the redraft moved text and the comment's logical position changed. `build_failed` entries include the build error excerpt in `agent_note`.

Interrupted rounds (rig crash, terminal closed, etc.) leave `round_status: in_progress` with partial `results[]`. The app surfaces a "resume?" banner on next doc open (§10.1 step 6). The rig's `/review-pdf process` command, when re-invoked against the same submit file, reads the existing results file and skips comments already with a terminal status.

### 10.4 The review bundle — a deliverable two-file artifact

A review session of a PDF/MD produces a **bundle**: two files with matching basenames in the source directory.

```
2026-05-20 report-1.0 (AJB edits).pdf
2026-05-20 report-1.0 (AJB edits).json
```

Filename grammar: `YYYY-MM-DD <base>-<source_version> (AJB edits).{pdf,json}` where:
- `YYYY-MM-DD` is today's date at the moment of writing (Cmd+S or Submit). Multiple writes on the same date overwrite the same file. The first write on a new date produces a new dated bundle — yesterday's stays as audit trail (rule (a) from Gap 1)
- `<base>` and `<source_version>` are parsed from the source filename per §10.6
- The `(AJB edits)` suffix is literal in v1 (single-author). Multi-author handling deferred

#### When the bundle is written

- **Cmd+S** = Export Bundle. Writes the bundle to the source dir without firing Submit. No agent handoff. PDF is re-rendered from the current draft state; JSON is a frozen snapshot of the current draft (with status promoted to `submitted` only when written by Submit, not by Cmd+S — Cmd+S preserves `open` status)
- **Cmd+Return** = Submit. Writes (or refreshes) the bundle, then slings it to the target rig per §10.1
- **No "save" gesture beyond these.** Draft autosave continues silently to `.review-state/drafts/<sha256>.json` on every keystroke. A persistent "Saved" indicator in the title bar (mirrors Google Docs / Notion) provides reassurance for the autosaving drafts; "Saving…" briefly during the 250ms debounce window

#### Why both files

| File | Role | Read by | What it carries |
|---|---|---|---|
| **PDF** | Human-portable rendered view | Anyone with a PDF reader (Preview, Acrobat, iPad) | PDF-native annotations: highlights, strikethroughs, sticky-note comments. Color-coded by engagement level. Comment text in popups. No structured metadata (L1/L2/L3, redraft text, status, history) — that's the JSON's job |
| **JSON** | Structured source of truth | App (round-trip restore), rig (`/review-pdf process`), any other tool | Full fidelity: all comment fields per §8, sha256 references to source + rendered PDF, session metadata, version, app version |

The PDF is the rendered view of the JSON. With the source PDF + the bundle JSON, the app fully restores the session. The bundle PDF is a one-way derivative for portability.

#### Bundle JSON schema (sketch)

```jsonc
{
  "schema_version": 1,
  "bundle_id": "20260520-192300",
  "created_at": "2026-05-20T19:23:00Z",
  "app_version": "0.x.y",
  "author": "AJB",
  "source": {
    "filename": "report-1.0.pdf",
    "absolute_path": "/abs/path/report-1.0.pdf",
    "sha256": "abc123...",
    "source_file_version": "1.0",
    "page_count": 24
  },
  "rendered_pdf": {
    "filename": "2026-05-20 report-1.0 (AJB edits).pdf",
    "sha256": "def456..."
  },
  "comments": [ /* full §8 schema */ ]
}
```

#### PDF rendering rules (rendered_pdf side)

- Use a PDF-mutation library (e.g., `pdf-lib`) to layer annotations onto a copy of the source PDF — never modify source
- **Highlight** annotations for selected regions; popup carries the user's `comment` text. v1 emits Highlight only; Strikethrough and Sticky-note annotation paths are deferred to v2, tracking §5.1's tool deferral.
- Annotation `author` field = bundle's `author`
- Color-coded by engagement level (e.g., L1 yellow, L2 blue, L3 red — exact palette TBD; consistent with right-drawer card colors)
- Redraft text included in the popup, prefixed `[redraft] <new text>`

#### Bundle discovery on load

When the user opens a PDF, the app checks the source dir for matching `(AJB edits).{pdf,json}` files. The bundle is keyed to the source's `<base>-<source_version>` (parsed per §10.6), **not** to its sha256 — so opening `report-1.0.pdf` finds bundles for `report-1.0` regardless of how many were written across multiple days.

- **Multiple dated bundles for the same source version** (e.g., yesterday's and today's): the most recent date prefix wins; older bundles remain on disk as audit trail but are not auto-restored. Lexicographic sort on the `YYYY-MM-DD` prefix is the tiebreaker (date format is sortable by design).
- **Sidecar JSON present** → fully restore session (statuses, history, derived_from chain).
- **Sidecar JSON missing, PDF-only bundle present** → degraded restore: read PDF annotations only; engagement levels missing → user re-classifies, redraft text missing → only popup text is recoverable.
- **Neither present** → fresh review.

The draft (`.review-state/drafts/<sha256>.json`) is checked first regardless; if present, it's the authoritative working state. The bundle is a deliverable snapshot, not the source of truth for in-progress work.

**Post-bump behavior is "fresh review, intentionally."** When the rig writes a new versioned source file (e.g., `report-1.1.pdf` per §10.6), opening that file finds no bundle keyed to `report-1.1` — and that's correct. The v1.1 file represents the rig's post-apply state; a fresh review against it produces a new dated bundle keyed to `-1.1`. The v1.0 bundle stays put as audit trail. Re-raised comments (`deferred` + `needs-followup` + `build_failed`, per §8.5) arrive via the seeded draft for v1.1, not via the bundle.

### 10.5 Standalone Submit and the destination picker

When the Electron app is launched without an originating rig (no `--from <rig-id>` flag — see §10.5.1), Submit doesn't have a default target. The user picks via a dropdown that opens at Submit time:

```
Send to: [▾]
  ⤷  📨 Reviewer (local) — talk only, no source edits
      ⛏️  rig: report-engine/anthony — full processing
      ⛏️  rig: cota-impact/anthony — full processing
      ⚙️  Pick another rig…
```

Destinations are sorted: Reviewer (local) first, then most-recently-used rigs, then the "pick another" expander. The picker remembers its last choice per doc — same doc, same default destination on re-submit. Secondary text sets capability expectations explicitly.

#### 10.5.1 Origin discovery

The Electron app determines its originating rig at launch via the CLI flag:

```bash
review-pdf-app open <path> --from <rig-id>
```

The rig-side `/review` skill (TBD; filed as M7 implementation work) is what calls this CLI form. Skill knows its own rig identity (it's running in it) and passes it through cleanly.

When `--from` is absent (user opens the app directly, or via Cmd+P from a doc with no rig context), origin is unset. Submit uses the picker.

#### 10.5.2 Capability matrix per destination

| Destination | Has source access | Has LaTeX engine | Can apply L1/L2 | Can discuss L3 | Produces |
|---|---|---|---|---|---|
| **Originating rig** | ✅ | ✅ | ✅ | ✅ | New versioned source + results JSON + git commit |
| **Reviewer (local)** | ❌ | ❌ | ❌ | ✅ | Results JSON (L3 dispositions + agent notes); no source mutation |
| **Other picked rig** | depends | depends | depends | ✅ | Whatever that rig can do |

In standalone-via-Reviewer:
- L1 / L2 items get `status: needs-followup` with `agent_note: "no source access in this rig; route through originating rig to apply"`
- L3 items get full conversational treatment in the embedded pane (§9.2); results include `agent_note` capturing the discussion outcome
- No new versioned source file written; bundle (§10.4) remains the only artifact
- User can later open the same PDF from a rig with source access, see the unresolved L1/L2 statuses (via the results file watcher / status reflection), and route them through then

#### 10.5.3 Gas-town gating

If gas-town integration is disabled or `gt` is not on PATH, the picker shows only the "Reviewer (local)" option (which itself requires gas-town to actually function as a Reviewer rig — without gas-town, Reviewer falls back to a plain pty that can only L3-discuss; L1/L2 still go to `needs-followup`). The "pick another rig" option is greyed out with the popover from §9.2.5.

LaTeX-specific clarification: LaTeX engine processing is only meaningful when the target rig has the engine on PATH AND has the source tree. In practice, that's the rig case.

**Standalone-via-Reviewer never touches LaTeX — enforced, not by convention.** Two gates:

1. **Skill-level gate.** The rig-side `/review-pdf process` skill (§13.18, post-split) probes its own rig identity (via `gt`) AND reads the submit-file's `destination_rig`. If either says `reviewer-local` or the rig identity starts with `reviewer/`, the skill takes a no-mutate branch: L1/L2 → `status: needs-followup` with the §10.5.2 agent_note, L3 → full conversational treatment, no `apply`/`build`/`revert`/commit/version-bump invoked.
2. **Engine-level gate (belt-and-braces).** The engine's `apply`, `build`, and `revert` atomic subcommands refuse to run when `$GT_RIG` starts with `reviewer/`, with a clear refusal message citing §10.5.2. A user who tries to invoke the engine binary directly from a Reviewer pty hits this and stops cleanly.

PATH-level scrubbing is intentionally not used; the guard lives at the capability/skill boundary, matching the §10.5.2 contract surface. The pty itself is not sandboxed — a user can still manually edit files inside the Reviewer pty if they explicitly choose to (and ad-hoc Claude conversations there can edit files at the user's request). What's enforced is the *automated pipeline boundary*: no Submit-driven flow touches LaTeX in a Reviewer destination.

### 10.6 Source-file version bumping

This applies only when a rig writes a new versioned source file (rig case). Standalone has no source mutation; this section is moot for standalone.

#### Version parsing regex

```
^(.+?)-(\d+)\.(\d+)\.(pdf|md|tex)$
```

Matches: `report-1.0.pdf`, `notes-2.13.md`, `cota-impact-3.0.tex`. Captures: `<base>`, `<major>`, `<minor>`.

Does **not** match unusual conventions (`report-v1.pdf`, `report-final.pdf`, `report_2026.pdf`) — these are treated as having no version.

#### Bump behavior

At round end, the rig prompts the user:

```
Bump to: [1.1 (minor, default)] / [2.0 (major)] / [custom: ___]
```

- **Default (Enter, empty, "minor")** — bump minor by 1: `1.0 → 1.1`, `1.13 → 1.14`
- **major** — bump major, reset minor: `1.7 → 2.0`
- **custom** — free entry validated against `\d+\.\d+` (allows `3.1`, `1.10`, `2.5`; rejects `v2-final`, `snapshot`)
- **Input filename had no version match** — treated as implicit `v1.0`; default new version is `1.1`. Custom and major options still available

#### Collision handling

If the target new filename already exists in the source dir, the rig bumps again until free (`report-1.1.pdf` exists → try `-1.2`, then `-1.3`, etc.) and notifies the user in the round-end summary. Prevents accidental overwrites; preserves prior round outputs.

#### Single commit at round end

The rig produces one git commit per round (regardless of how many comments were applied). Commit message shape:

```
review-pdf: round <bundle-id> — N applied, M failed

Doc: <source-pdf-path>
Bundle: <bundle-pdf-path>
Results: .review-state/results-<ts>.json
Version: <previous> → <new>

Applied (N):
- <id1>: <short comment text>
- <id2>: ...

Failed (M):
- <idX>: <short comment text> (build error: ...)
- <idY>: ...

🤖 Generated by review-pdf-to-latex (round <bundle-id>)
```

Commit fires only when `round_status: complete`. Interrupted rounds leave the working tree dirty with `round_status: in_progress`; resume re-enters the rig session against the same submit file, completes processing, then commits.

Major version bumps deliberately stay out of the Submit-side UI in v1 (no Electron-side toggle next to Submit). The rig-prompt placement keeps the choice where the actual file is being written.

## 11. Three engagement levels

A single typology applied across PDF and MD:

| Level | Tool | Description | AI involvement |
|-------|------|-------------|----------------|
| L1 — Comment | 💬 Comment | "Just change/delete this." Deterministic. Could almost be a script. | Apply directly, no questions |
| L2 — Redraft | ✏️ Redraft | "Fix this, or give me 3 options." Bounded research. | Generates options; user picks |
| L3 — Surface | 🌊 Surface | "This needs a rethink." Open-ended brainstorm. | Rig pauses on L3 items during round processing and discusses conversationally (sequential in document order; see §10.1 step 5). Rig case: in the originating rig session. Standalone case: in the embedded Reviewer pane (§9.2 / §10.5) |

The data model carries `engagement_level` so the AI knows which mode to enter for each comment in the payload.

### 11.1 Picking the level

The active tool in §4.2 *is* the engagement level at creation — one click, one level, no extra picker:

- 💬 Comment → L1
- ✏️ Redraft → L2
- 🌊 Surface → L3

The `redraft: string | null` field is **independent** of level. An L2 redraft with no user-supplied text means "you pick how, give me options" (per the §11 table); an L2 with user-supplied text means "swap this exact text in."

### 11.2 Changing the level

Engagement level is **mutable pre-submit**. The level chip on each comment card (right drawer, §9.1) is clickable — pick a new level any time before Submit. After Submit, the level is frozen for audit alongside the rest of the comment state.

### 11.3 The rig does not reclassify

If the rig disagrees with a comment's level (e.g., a v1.0 L1 looks like a structural problem to the rig), it returns `status: needs-followup` with an `agent_note` explaining why. It does **not** rewrite the level in the results file. The user remains the sole authority on intent; the rig can advise but not override.

**Capability-driven `needs-followup` is also status-only, not reclassification.** When a destination rig lacks the capabilities to act on a level (e.g., Reviewer-local per §10.5.2 has no source access and so cannot apply L1/L2), the rig returns `needs-followup` with an `agent_note` describing the missing capability. The `engagement_level` is unchanged; only the status carries the signal. This keeps §11.3's rule whole — the rig is reporting "I can't act on this here," not asserting "this is the wrong level."

A common pattern this produces: a v1.0 L1 returns `needs-followup`; the seeded v1.1 draft contains a fresh `open` comment with `derived_from` pointing back. The user reads the rig's note in the right drawer (status filter "Needs-followup"), decides whether to re-file at L3, edits the level on the v1.1 comment, and Submits again.

## 12. Out of scope for v1

- Multi-user / real-time collaboration.
- Comment threads / replies (single-level comments only).
- Word-doc detail (treat as PDF-like; defer until needed).
- Auto-update mechanism for the Electron app (manual reinstall is fine for AJB + python419).
- Gas City embedding (per electron pivot handoff §5).

## 13. Open questions (decisions still needed)

### 13.5 — Carried over from the pivot handoff (still open)

Status of items carried from the [Electron pivot handoff](../handoffs/2026-05-17-electron-pivot-handoff.md) §1–§3, §5–§6:

1. **§13.1 Python engine bundling — RESOLVED → PATH-discovery for v1.** Details in §13.1 below.
2. **§13.2 First-scope cut — RESOLVED → ground-up renderer.** Details in §13.2 below.
3. **§13.3 Repo strategy — RESOLVED → same repo, `desktop/` subdirectory.** Details in §13.3 below.
4. **§13.4 Electron vs Tauri vs Wails — RESOLVED → Electron.** Details in §13.4 below.
5. **Spec §10 of the 2026-05-16 design spec rewrite — RESOLVED (2026-05-20).** §10 of the design spec was rewritten in place: the obsolete sidecar/Jinja-viewer prose was removed, the engine-side action-semantics table (the status-transition matrix that `set-status` validates against) was preserved under §10.3, each subsection now points at the corresponding part of this spec, and the design spec's header was updated to mark it "partially superseded by 2026-05-19." Other §10 cross-references in the design spec still resolve cleanly (§10.3 table is intact; §10.5/§10.6 land on supersession notices that direct readers to the Electron architecture). The §1 summary line and the §11.3 perf-warning placement were also updated for internal consistency.

### 13.1 — Python engine bundling — RESOLVED → PATH-discovery for v1

**Decision:** v1 uses **PATH-discovery**. The Electron main process spawns `review-pdf` (the pyproject-declared script entrypoint at `[project.scripts] review-pdf = "review_pdf_to_latex.cli:main"`) and assumes it is resolvable on the user's `PATH`.

**The three framing options:**

| | A. PATH-discovery | B. pyinstaller | C. Bundled wheel + interpreter |
|---|---|---|---|
| What ships | Just the Electron app; user has `review-pdf` installed | Single self-contained binary, no Python needed | App + Python interpreter + wheel |
| User prerequisite | `pip install -e .` (or equivalent) | None | None |
| Engine iteration loop | Edit Python → save → next spawn picks it up | Edit Python → rebuild binary → repackage app → reinstall | Edit Python → rebuild wheel → repackage app |
| App size impact | +0 MB (engine is separate) | +30–80 MB | +50–120 MB (interpreter + stdlib + wheel) |
| Code-signing complexity | Just the Electron app | App + pyinstaller binary (separate Mach-O signing on macOS) | App + interpreter + native extensions |
| Cross-platform variance | None (whatever Python the user has) | Per-platform pyinstaller builds | Per-platform interpreter bundling |
| Distribution-ready | No (developer-only) | Yes | Yes |

**Why PATH-discovery for v1:**

1. **The audience already has it installed.** v1 ships to AJB + python419. Both are developers with the repo cloned and `pip install -e .` already in their environment. There is no install-friction problem to solve.
2. **Iteration speed dominates v1.** The engine and the UI will co-evolve daily during build. PATH-discovery means engine changes are picked up on the next subprocess spawn — no rebuild, no repackage, no reinstall. Pyinstaller cuts that loop from seconds to minutes; for an early build where we'll change the engine alongside every UI flow, that's hours per day lost.
3. **No code-signing tax during build.** macOS code-signing pyinstaller binaries is a known sinkhole (separate Mach-O signing, notarization, the works). Skipping it until distribution is real saves real time.
4. **Reversibility.** The Electron main process talks to the engine through one function — `spawnEngine(args)`. Swapping PATH-discovery for pyinstaller later is a single-file change. Picking PATH-discovery now does not lock out pyinstaller for v2 distribution.

**What PATH-discovery looks like concretely:**

The main process resolves the engine in this order:
1. User override from app settings (e.g., `~/Library/Application Support/review-pdf-electron/config.json` → `enginePath`)
2. `review-pdf` on `PATH` (the default, works for `pip install -e .` and any active venv)
3. Common venv locations as a fallback: repo-local `.venv/bin/review-pdf`, `~/.venvs/review-pdf-to-latex/bin/review-pdf`
4. Error UI: "Python engine not found. Set the engine path in Settings or run `pip install -e .` in the repo." — modal at first launch, non-blocking banner on subsequent launches.

At startup, the main process calls `review-pdf --version` and compares against an expected-version range baked into the Electron app. If the engine is older than the UI expects, show a non-blocking banner — common during co-evolution and not worth blocking on.

**When the case would flip:**

- **Public/internal distribution beyond AJB + python419.** First time a non-developer needs to run this, PATH-discovery breaks. Pyinstaller (Option A from the handoff) is the upgrade path. Plan for it; don't build it now.
- **CI/automated runs in environments without the Python install.** Not v1.

**Risk to record:** the engine and the Electron app are now in a co-version-dependent relationship without a hard linkage. The version-check banner is the safety rail. If the banner gets ignored or the version range is wrong, we'll see "feature missing" or "engine errored" bugs that trace to version drift, not real bugs. Worth being honest about in `bd` triage.

### 13.2 — First-scope cut — RESOLVED → ground-up renderer

**Decision:** v1 builds the renderer **ground-up** in the new Electron app. The existing Jinja viewer (`src/review_pdf_to_latex/templates/frame.html`, `annotation.html`) is retired as a UI artifact, not ported.

**The two framing options:**

| | A. Minimal wrapper | B. Ground-up renderer |
|---|---|---|
| First-paint effort | Lowest — Electron shell loads existing Jinja viewer as renderer content | Higher — build the four-pane layout (§2) from scratch |
| Resulting layout | Old single-pane PDF + sidecar HTML | Spec layout: file tree + doc viewer + bottom input + comment stream + Claude pane |
| Co-existence cost | Every new pane and tool must wedge into Jinja templates; halfway state for weeks | None — single coherent codebase from day one |
| Embedded Claude pane (§9.2) | Hard — current viewer has no pane for it; would require Jinja surgery | Native — designed in from the start |
| Save format / engine reuse | Same in both — the engine is untouched in either path |
| Estimated effort to feature-parity with spec | Minimal-wrapper is faster to *something running*, but ~2–3× slower to *spec-matching* once the new layout work starts | Slower start, faster finish; coherent throughout |

**Why ground-up wins:**

1. **The spec describes a different app.** §2 lays out four panes (file tree / doc viewer / bottom input / right drawer with comment stream + Claude pane). The existing Jinja viewer is single-pane PDF + sidecar HTML for comments. They are not the same app with different paint. Wrapping the old viewer and "progressively rebuilding" it means months of living in a halfway state where every new feature has to coexist with the old layout.
2. **The valuable artifacts are the engine and the patterns, not the templates.** What we keep: the Python engine (untouched — extract, apply, terminal, cli), the save format (the JSON comment shape), the PDF.js setup learnings, the xterm.js terminal integration logic. What we discard: Jinja templates as layout, the WebSocket-based sidecar bridge (Electron IPC replaces it), the HTTP-server hosting model (Electron loads files directly), the "open in browser" UX. The discards are layout glue; the keeps are domain logic.
3. **Pivot handoff §3 leaned minimal-wrapper for speed; this spec earns the ground-up call.** The handoff was written when the new UX was unspecified. The 17 decisions captured in §3–§11 of this spec define a layout the Jinja viewer cannot host without being completely rewritten anyway. Once that's true, "wrapper" is just "rewrite with extra steps."
4. **Halfway states cost trust.** Living in a six-week limbo where the file-tree pane works but the comment stream still uses Jinja and the Claude pane is a placeholder is the kind of thing that makes a v1 feel never-shipped. Ground-up means every shipped milestone is a coherent app, even if feature-incomplete.

**What ground-up keeps from the existing codebase:**

- **Python engine modules** — `cli.py`, `extract.py`, `apply.py`, `terminal.py` continue to exist and ship unchanged. Electron talks to them via subprocess (§13.1).
- **PDF.js setup** — whatever's been learned about wiring PDF.js for our save formats moves over conceptually, even if the renderer code is rewritten.
- **xterm.js** (already in-tree at `src/review_pdf_to_latex/templates/static/`) — the JS bundle moves to the Electron renderer. The pty driver moves from Python (`terminal.py`) to node-pty in the main process per §13.4. xterm.js itself ports directly.
- **Save format conventions** — the comment JSON shape (§6.2, §10) is the engine's contract. The renderer reads/writes it; the engine consumes it. Stable.
- **The three pre-pivot bugs** (`rev-3pm`, `rev-cav`, `rev-2mq`) — close as superseded once the rebuild is underway; they live in the abandoned sidecar architecture per §14.

**What ground-up discards:**

- **Jinja templates** (`frame.html`, `annotation.html`) — not ported. The layout they describe is not the spec layout.
- **HTTP-serve hosting** (`server.py` in serve mode) — Electron renderer loads files directly from disk via the main process; no localhost. `server.py` may stay as a useful headless serve mode for tests / Gas City embedding (§13 of the pivot handoff), but it stops being the path the user runs.
- **WebSocket sidecar bridge** — Electron IPC replaces it.
- **"Open in browser" UX** — the app is the surface; no browser tab dependency.

**When the case would flip (recorded for future-you):**

- **If the existing Jinja viewer's layout were close to the spec layout.** It isn't; this is the load-bearing reason ground-up wins.
- **If we were under a hard deadline to demo *something* this week.** We're not; v1 is paced to AJB + python419.
- **If the renderer framework choice were itself uncertain enough to want to defer.** It's not — the renderer can start with vanilla TS + components and migrate to a framework if/when needed (renderer framework is explicitly not load-bearing per the §13.4 stack note).

**Risk to record:** ground-up takes longer to first-paint. Estimate the §2 layout shell at ~1–2 weeks of focused work before any pane has its real content (file tree wiring, doc viewer skeleton, bottom-input stub, right-drawer skeleton, Claude pane placeholder, IPC plumbing to main). If that empty-shell milestone slips badly, revisit the call — but expect the slip to be a sign of an undersized estimate, not a sign that minimal-wrapper would have been faster overall.

### 13.3 — Repo strategy — RESOLVED → same repo, `desktop/` subdirectory

**Decision:** v1 lives in **this repo**, under a top-level `desktop/` directory. The Python engine and the Electron app share one git history, one issue tracker (`bd`), and one release process. Split into a separate repo when — not before — the conditions in "When to split" below are met.

**The two framing options:**

| | A. Same repo, `desktop/` subdir | B. New repo (`review-pdf-to-latex-app` or similar) |
|---|---|---|
| Git history | One — every cross-cutting change is one commit | Two — coordinated changes are two PRs in two repos |
| Engine + app version coupling | Same commit hash; trivially in sync | Pinned versions; surface area for drift |
| Issue tracking | One `bd` instance, one inbox | Split or duplicated across repos |
| CI | One repo, scoped per-path (Python tests vs Electron build) | Two pipelines, two configs |
| Refactor friction | Low — engine API change + app caller change in one commit | High — engine PR → release → bump app dependency → app PR |
| Onboarding for engine-only users | More noise (the app is also in the tree) | Cleaner — engine repo is just the engine |
| Distribution coupling | Engine and app ship together (good for v1 audience) | Engine `pip install`-able independently (good for public engine) |
| Repo size | Larger (Electron deps, build artifacts) | Each stays smaller |
| Solo-dev ceremony | Single — one place for branches, hooks, settings | Doubled — every config exists in both |

**Why same repo for v1:**

1. **Solo dev + co-evolving halves.** AJB is the only contributor for now. The engine and the app will change together daily during build (a new app pane needs a new engine endpoint; a new save-format field needs both halves to read it). Two repos doubles the ceremony — branches, PRs, CI runs, version bumps — for the same person doing both jobs. Same repo lets a single commit span both halves with no version-pinning dance.
2. **The version-check banner from §13.1 becomes trivial.** When engine and app live at the same commit hash, "what version of the engine does this app expect" has one answer. Split repos require a real version protocol (semver pin, compatibility matrix, banner-aware ranges) — meaningful work that earns its cost only at distribution.
3. **bd tracks the work as one project.** This repo already has `bd` set up. Splitting bd across two repos either means cross-repo links (clunky) or a third meta-repo for tracking (overhead). One repo, one tracker.
4. **Refactors stay coordinated.** When the engine's comment JSON shape changes (§6.2, §10), the app's reader changes in the same PR. No "engine ships v0.2, app pinned to v0.1, bug reports are ambiguous about which version" failure mode.
5. **The pivot handoff already recommended this** (§3 of the pivot handoff, "Option A — same repo, `desktop/` subdirectory"). This spec confirms rather than reverses.

**What `desktop/` looks like concretely:**

```
review-pdf-to-latex/
├── pyproject.toml              # engine (unchanged)
├── src/review_pdf_to_latex/    # engine (unchanged)
├── tests/                       # engine tests (unchanged)
├── docs/                        # specs, handoffs (unchanged)
├── .beads/                      # bd issue tracker (unchanged)
├── desktop/
│   ├── package.json             # Electron + renderer deps
│   ├── tsconfig.json
│   ├── main/                    # Electron main process
│   ├── preload/                 # preload scripts
│   ├── renderer/                # renderer (file tree, doc viewer, comment stream, Claude pane)
│   ├── shared/                  # types shared main ↔ renderer
│   ├── tests/                   # app-side tests
│   └── build/                   # gitignored: dist/, out/, node_modules/
└── .gitignore                   # extended for desktop/ build artifacts
```

**CI & tooling notes:**

- Engine and app CI are separately scoped via path filters — pushes touching `src/**` or `tests/**` run Python CI; pushes touching `desktop/**` run app CI. Pushes touching both run both. (Implementation deferred until CI exists.)
- `desktop/node_modules/`, `desktop/dist/`, `desktop/out/`, and any packaged binaries are gitignored.
- The engine continues to be installable via `pip install -e .` from the repo root. The app's PATH-discovery (§13.1) finds it normally.
- Cross-cutting work uses a single branch and a single commit. No requirement that engine and app changes live in separate commits — at v1 audience scale, the bisect benefit doesn't justify the ceremony. A loose convention (one commit per logical change, regardless of which half it touches) is enough.

**When to split (recorded for v2+):**

- **Non-AJB/non-python419 users want the engine without the app.** If anyone installs `review-pdf` via pip without ever opening the Electron app, the engine is earning independent identity. Split.
- **A non-AJB contributor joins the app side.** Engine internals become noise for them; the app deserves its own repo.
- **Release cadences diverge meaningfully.** Engine shipping weekly while app ships quarterly (or vice versa) makes one-repo coordination an active drag.
- **Public distribution starts.** The engine becomes a PyPI package; the app becomes a release-channel binary. Different release surfaces = different repos.
- **`desktop/` outgrows the repo's coherence.** If `desktop/` ends up larger than the engine and dominates the repo's identity, the repo is no longer "the engine"; split into engine + app where each is itself.

None of these apply to v1.

**Risk to record:** monorepo coherence depends on discipline. As a solo dev, it's easy to land a commit that's actually three changes across both halves, then have a hard time bisecting six months later. Mitigation: keep commits scoped (one logical change per commit, even if it spans both halves), write commit messages that name both halves explicitly when they're touched (e.g., `engine + app: bump comment schema to v3`), and lean on `bd` for the per-task scoping that commits alone won't enforce.

### 13.4 — Electron vs Tauri vs Wails — RESOLVED → Electron

**Decision:** v1 ships on **Electron**.

**The three framing options:**

| | Electron | Tauri | Wails |
|---|---|---|---|
| Backend language | Node.js (JS/TS) | Rust | Go |
| Renderer | Bundled Chromium | System webview (WKWebView / WebView2 / WebKitGTK) | System webview (same) |
| Binary size | 80–200 MB | 5–30 MB | 8–25 MB |
| Cross-platform render consistency | Identical (one Chromium) | Three different webviews | Three different webviews |
| Native module ecosystem | npm (node-pty, sqlite, native crypto) | Rust crates | Go stdlib + community |
| pty / terminal stack | `node-pty` + xterm.js, standard pattern | `portable-pty` + custom IPC | `creack/pty` + custom IPC |
| Subprocess spawn (Python engine) | `child_process.spawn` — trivial | Rust `Command` or `tauri sidecar` | Go `os/exec` — trivial |
| Auto-update | Squirrel / `electron-updater`, battle-tested | `tauri-plugin-updater`, younger | Not built in |
| Mobile (iOS/Android) | No | Yes (Tauri 2) | No |
| Security model | Process isolation + preload sandbox | Capability scoping, sandbox-by-default | Minimal |
| Maturity / community | Largest (VS Code, Slack, Figma, etc.) | Mid (Spacedrive et al.) | Smallest |

**Why Electron wins for this app:**

1. **The renderer carries the load-bearing risk.** §13.10 / §13.11 hinge on PDF.js text-layer extraction working reliably under rotated pages, tight quads, and the corrupted-PDF case from `rev-fv6`. Chromium is the widest known-good surface for PDF.js. WKWebView (Tauri/Wails on macOS) lags Chromium by months on web APIs and has documented PDF rendering quirks — running a load-bearing spike on a moving target adds confound where we don't want it.
2. **The native-module pull is real.** `node-pty` + `xterm.js` is the canonical embedded-terminal stack for the Claude pane (§9.2). xterm.js is already in-tree (`src/review_pdf_to_latex/templates/static/`). Electron keeps that work straightforward: node-pty in main, xterm.js in renderer, IPC between them. Tauri/Wails throw out the node-pty half and require building a custom Rust/Go pty↔webview bridge.
3. **v1's audience is two people.** Electron's 100 MB-on-disk and 200 MB-of-RAM downsides matter at consumer distribution scale. They don't matter for AJB + python419. The case for Tauri's size advantage cashes out at distribution — which v1 explicitly defers (§12).
4. **Build velocity.** Electron is one-language (JS/TS) end-to-end and AJB already works in JS-land. Tauri adds a Rust learning cost; Wails adds Go and a smaller community to find answers in. For an internal v1, the fastest path to a working app is the right path.
5. **Python engine spawn is trivially mature in Electron.** `child_process.spawn("review-pdf", [...])` works on day one. Same is true in Wails (`os/exec`). Tauri's sidecar pattern is workable but adds ceremony. Combined with the renderer and pty wins, the Python-spawn neutrality doesn't move the needle.

**When the case would flip (worth recording for v2):**

- **Public distribution at scale.** If we ever want to put this in front of a download-curious audience, install size and cold-start become real. Tauri's 5–30 MB beats Electron's 80–200 MB meaningfully there.
- **Mobile.** If we want iOS/Android from the same codebase, only Tauri 2 offers it.
- **Security-scoped deployment.** Enterprise or sandboxed-environment shipping benefits from Tauri's capability model.
- **Rust expertise on the team.** If the project ever gets a contributor who lives in Rust, Tauri's appeal goes up.

None of these apply to v1; all are worth re-checking if/when we cross into v2 distribution.

**Risk to record:** an Electron→Tauri port in v2 has real cost — rewriting node-pty integration as a Rust pty bridge, re-plumbing the Python engine as a Tauri sidecar, packaging changes, and (most painfully) re-testing PDF.js against three webview engines. The renderer code itself (React/Vue/Svelte/vanilla, whatever §13.x picks) carries over cleanly; only the main-process plumbing is at stake. **We're picking Electron for its v1 fit, not pretending it's the right end-state.**

**Concrete stack v1 will ship on:**

- Electron (latest stable at build start)
- Renderer framework: TBD (one of: React 19, Svelte 5, vanilla TS). Decide during prototype; not load-bearing.
- `node-pty` (main process) + `xterm.js` (renderer) for the Claude pane
- PDF.js (renderer) for PDF view + text-layer extraction
- `child_process.spawn` for the Python engine — pairs with §13.1 PATH-discovery for prototype
- `electron-builder` or `electron-forge` for packaging (defer pick until first package needed)
- Auto-update deferred per §12

### 13.6 — Dark mode for PDF + Word (still open, spike)

Feasibility spike — render to canvas with color matrix invert? PDF.js plugin?

### 13.7 — MD inline-note syntax — RESOLVED → see §6.3

HTML comments (`<!-- agent-note id=<uuid> L<1|2|3>: ... -->`). Block form for long notes.

### 13.8 — MD bottom input vs in-place edit — RESOLVED → see §6.4

Bottom input retained for consistency across doc types. In-place edit of rendered MD is not v1; defer.

### 13.9 — Tool palette 4th slot (still open)

What fills the slot alongside Comment / Redraft / Surface? Strikethrough? Sticky-note? Decide during prototype based on usage gaps.

### 13.10 — PDF underlying-text extraction reliability — RESOLVED (2026-05-20)

**Decision:** PDF.js text-layer extraction is reliable on well-formed PDFs. On malformed PDFs it degrades gracefully (blank render, zero text-content items, clear warning). The app handles the degraded path via a load-time pre-flight health check, an inline quality warning at highlight time, and "region-only" capture when text capture fails. No OCR fallback in v1. Full reasoning in [`docs/research/2026-05-20-pdf-text-layer-spike/README.md`](../research/2026-05-20-pdf-text-layer-spike/README.md); implementation requirements added to §5.2 above and to the engine CLI as `review-pdf pdf-health`.

The five documented failure modes — image-only / partially-corrupted / missing-ToUnicode / encrypted / unparseable — and the app's response to each are recorded in the spike README's "Failure modes summary" table.

### 13.11 — Highlight → text capture coordinate accuracy — RESOLVED (2026-05-20)

**Decision:** non-issue under text-layer selection. When the user drags to select text, the selection IS the characters PDF.js extracted; bounding rects come straight from `Range.getClientRects()`. No rectangle-intersection math, no coordinate drift. Coordinate accuracy is only a question in the fallback "region-select" mode (image-only PDFs), and that mode is by design imprecise — the user is pointing at a region, not at specific text. Spike validation in [`docs/research/2026-05-20-pdf-text-layer-spike/README.md`](../research/2026-05-20-pdf-text-layer-spike/README.md).

### 13.12 — Search inside doc / search across comments (new, deferred to v2)

`Cmd+F` for text search inside the current document is not v1. `Cmd+Shift+F` for search across all comments (across docs) is also not v1. Add when AJB feels the absence on a real review.

### 13.13 — Submit transport — RESOLVED (2026-05-20) → sling to originating rig via gt mail

**Decision:** Submit slings the bundle to the originating rig via `gt mail`; the rig's `/review-pdf process` skill does the mechanical work. The Electron app stays idle after Submit; results reflect via the `.review-state/` file watcher. Standalone case (no originating rig) opens a destination picker (§10.5). The embedded Claude pane (§9.2) is purely conversational and is *not* used for Submit processing — except in the standalone-via-Reviewer fallback where the Reviewer pane discusses L3 items locally.

Considered alternatives: (A) pty-injection into the embedded pane — requires §9.2 to be a hard dep of Submit; (B) one-shot subprocess + file watcher inside the Electron app — collapses rig case into Electron-internal processing, loses the rig's natural project context. Both rejected; sling-to-rig matches the broader workflow shape (Electron is a tool inside the rig's flow, not a replacement for it).

Full contract in §10.1 + §10.5.

### 13.14 — Review bundle artifact shape — RESOLVED (2026-05-20) → two-file PDF + JSON pair, dated

**Decision:** The deliverable artifact of a review session is a **bundle**: a dated PDF + JSON sidecar with matching basenames in the source dir. PDF carries PDF-native annotations for portability; JSON carries the full structured fidelity (engagement levels, redrafts, statuses, history). Cmd+S writes the bundle; Cmd+Return writes the bundle and Submits.

Considered alternatives: (single PDF with embedded annotations only) — loses redraft text, engagement levels, derived_from chain; (single JSON) — not portable to humans without the app; (single PDF + JSON in PDF metadata stream) — tooling complexity.

Full contract in §10.4. Filename grammar uses date prefix per rule (a): today's date at write time, multiple per active day accumulate as audit trail.

### 13.15 — Embedded Claude pane (§9.2) design — RESOLVED (2026-05-20)

**Decision:** The §9.2 paragraph was insufficient ("spike how cloud-desktop and T3 present input/output and steal the pattern"). Full design pass landed: global conversational pty + ephemeral worker ptys; lazy spawn; skill priming via injected first-message (with pre-flight to switch to `--skill` CLI flag if supported); doc-switch line `[Now viewing: ...]`; three toolbar buttons (Create Context / Sling / Fresh Start); β + γ visibility for worker progress; Reviewer rig as gas-town identity (auto-detected on `gt` presence, global rig `reviewer/<you>`, sling allowed to other rigs/crews/mayor).

Full contract in §9.2.

### 13.16 — L3 escalation venue — RESOLVED (2026-05-20)

**Decision:** L3 (Surface) items are escalated conversationally in the rig session, not in the Electron app's UI. Rig case → originating rig. Standalone case → Reviewer pane (§9.2). Sequential in document order; user can skip ahead; mid-L3 interrupt is graceful (completed items keep their disposition, remaining marked `deferred`, partial results file written).

Earlier framing (Tasks-panel L3 work items in Electron) was rejected in favor of this — keeps L3 in the natural conversational mode of whatever rig is processing the round.

Full contract in §10.1 step 5 + §11.

### 13.17 — Source-file version bumping — RESOLVED (2026-05-20)

**Decision:** Rig prompts at round end for minor (default) / major / custom bump. Regex `^(.+?)-(\d+)\.(\d+)\.(pdf|md|tex)$` parses input version; no match → treated as implicit v1.0. Collision = bump-until-free. Custom validated against `\d+\.\d+`. Standalone Submit has no source mutation; this is moot for standalone.

Full contract in §10.6.

### 13.18 — `/review` and `/review-pdf process` skill contracts (NEW, OPEN)

The full skill text for both — `/review` (rig-side launcher that opens the Electron app with `--from <rig-id>`) and `/review-pdf process` (rig-side processor that orchestrates the round) — needs to be authored as part of M7 implementation work. This spec sketches the behavior in §10.1 and §10.5 but does not pin every prompt and error path.

The existing `~/.claude/skills/review-pdf-to-latex/SKILL.md` is the 4-phase legacy that needs to be rewritten for the round-based flow. Tracked by bd `rev-y0r`.

### 13.19 — PDF bundle annotation color palette (NEW, OPEN)

§10.4 calls for color-coding the rendered bundle PDF's annotations by engagement level (L1 yellow / L2 blue / L3 red as a strawman). Exact palette TBD; should match the right-drawer card colors for visual consistency. Pick during implementation alongside the toolbar-icon picking (bd `rev-ul7`).

### 13.20 — Reviewer rig audit-trail isolation (NEW, OPEN, deferred to multi-user scope)

The global Reviewer rig (`reviewer/<you>`) mixes work across all projects. For solo use this is fine and cross-project memory is a feature. If the app gains multi-user scope, this becomes a privacy/audit concern — a "Reviewer-meta" rig pattern with per-project sub-rigs may be needed. Flagged here; not v1.

## 14. Next steps (proposed)

In order:

1. **AJB reviews this spec.** Confirm: layout shape, three-engagement-levels framing, bottom-pane-is-universal-input idea, save-versioning scheme, decision ledger in §3–§11 + §15. Reject/edit anything wrong.
2. **Pre-build picks complete.** §13.1 bundling → PATH-discovery; §13.2 first-scope → ground-up; §13.3 repo → same repo, `desktop/`; §13.4 tech stack → Electron. §13.5 docs cleanup is done (2026-05-20). Remaining §13 items are spikes only (§13.6, §13.10, §13.11) and v2 deferrals (§13.9, §13.12); none are pre-build blockers.
3. ~~**Spike #1 — PDF highlight + text capture.** Single-page PDF.js prototype that proves we can highlight a region and reliably get the underlying text out, including the corrupted-PDF case from yesterday. Validates the load-bearing §5.2 requirement before committing the full app.~~ **Done 2026-05-20.** §5.2 confirmed achievable; §13.10 and §13.11 resolved. See [`docs/research/2026-05-20-pdf-text-layer-spike/README.md`](../research/2026-05-20-pdf-text-layer-spike/README.md).
4. **Spike #2 — Dark mode for PDF.** Quick canvas-invert test to know whether §4.1's "dark/light toggle for all doc types" is real or fantasy.
5. **Visual mockup.** ASCII in §2 is enough to discuss; before building, sketch the actual UI in Figma or hand-drawn — color, typography, comment-card design (steal from Sudowrite/Spellbook per [SCREENSHOTS.md](../research/2026-05-16-existing-tools-survey/SCREENSHOTS.md) "patterns worth noting").
6. ~~**Rewrite the obsolete spec §10** of `docs/specs/2026-05-16-review-pdf-to-latex-design.md` so the engine spec doesn't contradict this one.~~ Done 2026-05-20 — see §13.5 above.
7. **File bd issues** for the prototype work once steps 1–4 are answered. Will be coarse-grained at first (one per pane, one per doc type, one per spike), refined as build progresses.

The three pre-pivot ready bugs (rev-3pm, rev-cav, rev-2mq) should be re-scoped or closed-as-superseded once the rebuild direction is locked — they live in the abandoned sidecar architecture.

## 15. Keyboard

v1 keyboard bindings. Philosophy: cover the common navigation and submission moves with keys; defer command-palette / find-in-doc until felt absence.

| Key | Action | Context |
|-----|--------|---------|
| `Cmd+P` | Quick-open file palette (§3.5) | Any focus |
| `Cmd+S` | Export Bundle (§10.4) — write PDF + JSON sidecar; no agent handoff | Any focus |
| `Cmd+Return` | Submit (§10.1) — write bundle + sling to target rig (or open destination picker, §10.5) | Any focus |
| `Enter` | Submit current comment (§4.3) | Bottom input focused |
| `Shift+Enter` | Soft return inside input (§4.3) | Bottom input focused |
| `Esc` | Clear input / cancel active tool | Bottom input focused |
| `Cmd+1` / `Cmd+2` / `Cmd+3` | Activate Comment / Redraft / Surface tool (§4.2, §11) | Any focus |
| `j` / `k` | Next / prev comment in the stream (§9.1) | Right-drawer comment stream focused |
| `Enter` | Jump middle pane to selected comment's anchor | Right-drawer comment stream focused |
| `Cmd+\` | Toggle left drawer (file tree) | Any focus |
| `Cmd+J` | Toggle Claude pane (§9.2) | Any focus |
| `Cmd+=` / `Cmd+-` | Zoom / text size in / out (§4.1) | Doc viewer focused |
| `Cmd+Shift+D` | Toggle dark/light mode (§4.1) | Any focus |

Focus discipline notes:
- `j` / `k` only fire when the comment stream has focus — not while typing in the bottom input. A clicked comment moves focus; arrow keys / tab also rotate focus.
- `Esc` clears the input buffer but does not delete persisted comments. Buffer-until-Enter (§4.3) means an `Esc`-cleared input loses only the buffer, not committed work.

Deferred for v1 (worth flagging for future):
- `Cmd+Shift+P` — generic command palette. Skip until there are commands without dedicated keys.
- `Cmd+F` — find in current doc. See §13.12.
- `Cmd+Shift+F` — search across all comments. See §13.12.
