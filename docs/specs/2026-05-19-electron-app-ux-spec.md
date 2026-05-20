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

- **Highlight + comment.** Highlight a region, comment is captured against it.
- **Strikethrough.** Delete-this signal.
- **Standalone comment.** Place a comment at a point without a highlight (margin-style note).

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
| `doc_version` | string | "1.0", "1.1", … — keys the comment to a specific saved version |
| `anchor` | object | doc-type-specific: PDF region+text, MD char-range or position, etc. |
| `highlighted_text` | string | always captured when a highlight exists |
| `comment` | string | the user's note (instruction, observation, question) |
| `redraft` | string\|null | new text to swap in, if user provided one |
| `redraft_suggestion` | string\|null | agent's proposed redraft from live-redraft (§10.2) — distinct from user's `redraft` |
| `engagement_level` | enum | `comment` (L1) / `redraft` (L2) / `surface` (L3) — see §11 |
| `author` | string | "AJB" v1; multi-user later |
| `kind` | enum | `agent-note` / `user-note` (MD); `comment` / `strikethrough` (PDF) |
| `status` | enum | `open` / `submitted` / `applied` / `deferred` / `needs-followup` / `rejected` — see §8.5 |
| `submitted_at` | timestamp\|null | set when comment is promoted into a submit file |
| `derived_from` | comment_id\|null | links a re-raised v1.1 comment back to its v1.0 origin |
| `created_at` | timestamp | |

Two workflows the model needs to support cleanly:
1. **Pure comment** — "This statistic is screwy, look it up or delete it." `redraft` is null; AI decides what to do.
2. **Direct redraft** — "Swap this sentence for this new sentence." `redraft` is set; AI applies it verbatim on the next round.

### 8.5 Lifecycle

```
        ┌──────┐    Submit    ┌───────────┐    agent processes    ┌─────────────────────┐
created │ open │  ─────────→  │ submitted │  ──────────────────→  │ applied             │
   ───→ │      │              │           │                       │ deferred            │
        └──────┘              └───────────┘                       │ needs-followup      │
            ▲                                                     │ rejected            │
            │                                                     └─────────────────────┘
            │                  for deferred + needs-followup:             │
            └─── new comment in v1.1 draft, derived_from = original ←─────┘
```

Rules:
- **`open`**: default state on creation. Mutable: edit text, change level (§11), change redraft, delete.
- **`submitted`**: set when the comment is promoted into a submit file (§10.3). Immutable from this point — frozen for audit.
- **`applied` / `deferred` / `needs-followup` / `rejected`**: terminal states written by the agent into the results file (§10.3). The app reflects these into the archived submit-file's copy of the comment.
- **Round-trip re-raise**: when v1.1's draft is seeded (§10.1 step 5), deferred + needs-followup items are *copied* into the new draft as fresh `open` comments, with `derived_from: <original_id>` linking back. v1.0's archived comment retains its terminal status; v1.1's fresh comment starts the cycle over.

The `derived_from` chain lets the right drawer (§9.1) render "re-raised from v1.0" badges for L3 Surface items that span multiple rounds.

## 9. Right drawer — comments + embedded Claude

### 9.1 Top ⅔ — comment stream in document order

- Comments listed in the order they appear in the document, **not chronologically**.
- Inserting a comment at the top of the doc nests it into the right position in the list — scrolling the comments drawer mirrors scrolling the doc.
- Color-coded by `kind`: agent-note vs user-note. Distinct color for `redraft` vs `comment`.
- **Filter chips** at the top of this section:
  - by kind: "All / Agent notes / User notes"
  - by status (§8.5): "All / Open / Submitted / Applied / Deferred / Needs-followup / Rejected"
  - by level (§11): "All / L1 / L2 / L3"

  Defaults to "All" on each axis. Multi-select within an axis (e.g., "Open + Needs-followup" both shown).
- Re-raised items (with `derived_from` set) get a badge ("from v1.0") and link to the original in the archived submit file.

### 9.2 Bottom ⅓ — embedded Claude

- Always-present chat surface for ad-hoc questions, Surface escalations (§11), and the AI's responses during a redraft pass.
- Styling reference: the cloud-desktop Claude experience (T3 / Windows-in-cloud-desktop). User messages visible; tool-call detail collapsed behind a toggle.
- Spike how those two surfaces present input/output and steal the pattern that fits this layout.

### 9.3 Live-redraft display rules (interaction between §9.1 and §9.2)

The two-section split (comments-stream + Claude pane) creates an integration question: when a single-comment live redraft (§10.2) happens, where does the AI's response land?

**Rule**: the comment carries the answer; the pane carries the thinking.

- The comment card in the stream shows: original highlighted text, user's `comment` + `redraft` (if user-authored), and — once the agent has responded — `redraft_suggestion`. An "Accept as redraft" affordance on the card copies `redraft_suggestion → redraft`, making the agent's text the authoritative redraft for the next batch.
- The Claude pane (§9.2) shows the agent's reasoning, tool calls (collapsible), and any conversational back-and-forth. Linear scrollback; no per-comment threading (the pty doesn't support it natively).
- The comment card carries a small "✨ replied in Claude" badge with a timestamp; clicking the badge focuses the Claude pane.

This preserves the §1 framing — AI's deliverables attach to the work item; AI's chatter stays in its corner.

## 10. Save / submit / commit flow

There are two distinct save semantics:

### 10.1 Round-based "Save As + hand off to AI"

The user works through comments. When ready: clicks a Submit button (`Cmd+S`). The app:

1. **Promotes the draft to a submit file.** All comments in `status: open` on the current doc-version are moved into `.review-state/submit-<timestamp>.json` (frozen, immutable). Each is also marked `status: submitted, submitted_at: <now>` in its archived copy.
2. **Writes the new versioned source file.** PDF: `report-1.0.pdf` → `report-1.1.pdf` (optionally `report-1.1 (AJB edits).pdf`) in the source dir. MD: `notes.md` → `notes-v1.1.md`, with HTML-comment anchors (§6.3) inlined. Original is sacred — never overwritten.
3. **Injects a process command into the embedded Claude pty.** The Electron main process writes one line into the running Claude pty (§9.2): `/review-pdf process .review-state/submit-<timestamp>.json`. The embedded Claude session has the `review-pdf-to-latex` skill loaded at launch; the slash command tells it which submit file to consume.
4. **Agent processes and writes a results file.** The agent applies redrafts, surfaces options for L2 items, opens chat for L3 (Surface) items, and writes `.review-state/results-<timestamp>.json` (§10.3) with per-comment `status` + optional `new_anchor`.
5. **App reflects results.** Statuses update on the archived submit-file's comments. The new versioned source file (now the agent's redrafted output) opens in the middle pane. A fresh v1.1 draft is seeded from results: deferred + needs-followup items become fresh `open` comments with `derived_from: <v1.0_id>` (§8.5).

### 10.2 Live redraft (single-comment)

For a single comment, the user can request immediate AI action without waiting for the batch. Useful when a redraft suggestion is wanted *during* review, not after.

Behavior:
- A "Redraft now" affordance on the comment card injects a per-comment slash-command into the embedded Claude pty: `/review-pdf redraft <comment_id>`.
- The agent reads the comment from the live draft file (`.review-state/drafts/<doc-version>.json`), proposes a redraft, and writes it back into the same comment as `redraft_suggestion: <text>`.
- The Claude pane (§9.2) shows the agent's reasoning in pty scrollback; the comment card (§9.3) shows the `redraft_suggestion` inline with an "Accept as redraft" button.
- The source document itself is not modified until the round-based save (§10.1).

### 10.3 Filesystem contracts

The app and the agent communicate through three file types under `.review-state/`:

| Path | Lifetime | Writer | Reader |
|------|----------|--------|--------|
| `.review-state/drafts/<doc-version>.json` | Live; mutates on every comment edit (debounced 250ms) | App | App, agent (live-redraft only) |
| `.review-state/submit-<timestamp>.json` | Frozen at submit; permanent audit record | App | Agent (consumes); app (renders archived state) |
| `.review-state/results-<timestamp>.json` | Frozen at agent completion; permanent audit record | Agent | App (reflects status; seeds next draft) |

All three are JSON, human-readable, `cat`-debuggable. `.review-state/` is `.gitignore`d by default — these are local workspace files, not source-of-truth — but visible to the user in their filesystem for inspection/recovery.

Submit file schema (illustrative):

```json
{
  "submit_id": "20260519-143200",
  "doc_id": "report-1.0.pdf",
  "doc_version": "1.0",
  "submitted_at": "2026-05-19T14:32:00Z",
  "comments": [
    {
      "id": "abc123",
      "anchor": {"page": 4, "region": {"x": 72, "y": 540, "w": 410, "h": 18}},
      "highlighted_text": "COTA enrollment grew substantially",
      "comment": "tighten this — drop 'substantially'",
      "redraft": null,
      "engagement_level": "L2",
      "kind": "comment",
      "derived_from": null
    }
  ]
}
```

Results file schema (mirrors submit; agent writes one entry per comment in the batch):

```json
{
  "submit_id": "20260519-143200",
  "results_id": "20260519-145812",
  "completed_at": "2026-05-19T14:58:12Z",
  "results": [
    {
      "id": "abc123",
      "status": "applied",
      "new_anchor": null,
      "agent_note": "Removed 'substantially'; tightened to 12 words."
    },
    {
      "id": "def456",
      "status": "needs-followup",
      "new_anchor": null,
      "agent_note": "This isn't a typo — it's a thesis problem. Suggest re-filing at L3."
    }
  ]
}
```

A `status: rejected` entry includes a required `reason` field. A `new_anchor` is set when the redraft moved text and the comment's logical position has changed.

## 11. Three engagement levels

A single typology applied across PDF and MD:

| Level | Tool | Description | AI involvement |
|-------|------|-------------|----------------|
| L1 — Comment | 💬 Comment | "Just change/delete this." Deterministic. Could almost be a script. | Apply directly, no questions |
| L2 — Redraft | ✏️ Redraft | "Fix this, or give me 3 options." Bounded research. | Generates options; user picks |
| L3 — Surface | 🌊 Surface | "This needs a rethink." Open-ended brainstorm. | Opens a chat in the embedded Claude pane; partners with user |

The data model carries `engagement_level` so the AI knows which mode to enter for each comment in the payload.

### 11.1 Picking the level

The active tool in §4.2 *is* the engagement level at creation — one click, one level, no extra picker:

- 💬 Comment → L1
- ✏️ Redraft → L2
- 🌊 Surface → L3

The `redraft: string | null` field is **independent** of level. An L2 redraft with no user-supplied text means "you pick how, give me options" (per the §11 table); an L2 with user-supplied text means "swap this exact text in."

### 11.2 Changing the level

Engagement level is **mutable pre-submit**. The level chip on each comment card (right drawer, §9.1) is clickable — pick a new level any time before Submit. After Submit, the level is frozen for audit alongside the rest of the comment state.

### 11.3 The agent does not reclassify

If the agent disagrees with a comment's level (e.g., a v1.0 L1 looks like a structural problem to the agent), it returns `status: needs-followup` with an `agent_note` explaining why. It does **not** rewrite the level in the results file. The user remains the sole authority on intent; the agent can advise but not override.

A common pattern this produces: a v1.0 L1 returns `needs-followup`; the seeded v1.1 draft contains a fresh `open` comment with `derived_from` pointing back. The user reads the agent's note in the right drawer (status filter "Needs-followup"), decides whether to re-file at L3, edits the level on the v1.1 comment, and Submits again.

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

### 13.10 — PDF underlying-text extraction reliability (still open, spike)

Test against corrupted/scanned/multi-column PDFs to confirm we can always recover the text behind a highlight. If we can't, fall back to OCR + a "needs_review" flag.

### 13.11 — Highlight → text capture library (still open, spike)

PDF.js exposes text-layer extraction; need to confirm coordinate accuracy matches a user-drawn region under all PDF coordinate systems (rotated pages, tight quads — see what `rev-fv6` ran into).

### 13.12 — Search inside doc / search across comments (new, deferred to v2)

`Cmd+F` for text search inside the current document is not v1. `Cmd+Shift+F` for search across all comments (across docs) is also not v1. Add when AJB feels the absence on a real review.

## 14. Next steps (proposed)

In order:

1. **AJB reviews this spec.** Confirm: layout shape, three-engagement-levels framing, bottom-pane-is-universal-input idea, save-versioning scheme, decision ledger in §3–§11 + §15. Reject/edit anything wrong.
2. **Pre-build picks complete.** §13.1 bundling → PATH-discovery; §13.2 first-scope → ground-up; §13.3 repo → same repo, `desktop/`; §13.4 tech stack → Electron. §13.5 docs cleanup is done (2026-05-20). Remaining §13 items are spikes only (§13.6, §13.10, §13.11) and v2 deferrals (§13.9, §13.12); none are pre-build blockers.
3. **Spike #1 — PDF highlight + text capture.** Single-page PDF.js prototype that proves we can highlight a region and reliably get the underlying text out, including the corrupted-PDF case from yesterday. Validates the load-bearing §5.2 requirement before committing the full app.
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
| `Cmd+S` | Submit current draft → hand off to agent (§10.1) | Any focus |
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
