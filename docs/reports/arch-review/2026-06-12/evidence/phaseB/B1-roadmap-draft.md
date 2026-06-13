# B1 — Phased Roadmap DRAFT (Phase B, lane B1 — 2026-06-12)

Status: DRAFT for the Phase-B closer to merge into REVIEW.md `## Roadmap`. GATE 1 verified
OPEN this session (`GATE 1 (review findings → proposals & roadmap): OPEN — approved by
Anthony Byrnes 2026-06-12`); GATE 2 verified CLOSED — nothing below is implementation, and
every item executes only after GATE 2 opens.

Inputs: REVIEW.md in full (~57 findings, 14 ✓ independently verified C1–C14), the Capability
section's "DRAFT — input to Phase B" sketch, and the GATE 1 packet's UNCERTAIN/owner-decision
list. Every item below names the REVIEW.md finding(s) it rests on (section → short finding
name, ✓ where Pass-6 confirmed). This draft introduces NO new factual claims — all evidence
is REVIEW.md's, already cited there.

Reading guide: effort tags S/M/L as used throughout REVIEW.md. "Resolves" names findings by
REVIEW.md section. "Done when" is the acceptance criterion. "Deps" = what the item blocks or
is blocked by. Items prefixed SPIKE carry explicit kill criteria.

---

## NOW — standalone correctness fixes + de-risking spikes (do NOT fold into refactors)

These are the five confirmed data-loss/correctness bugs plus the submit unhappy-path
stranding (REVIEW.md Exec Summary §1; GATE 1 packet CHECK item: "the five data-loss bugs
(C1, C2, C7, C8, C9) should be sequenced as immediate fixes ... rather than folded into the
larger refactors"). Each is standalone; none waits on the Next-phase restructures.

### N1. Stop deleting Markdown frontmatter on save [S]
- Resolves: Renderer — Viewers & Anchoring → "Saving an edited Markdown file silently
  deletes its frontmatter" (high, C7 ✓).
- Done when: vitest case "load doc-with-frontmatter → edit → getContent() contains the
  block" passes (the finding's own acceptance test), and a manual edit of a frontmatter'd
  .md leaves the YAML block on disk. Also covers the lazy-regex horizontal-rule false match
  noted in the same finding.
- Deps: blocks nothing, blocked by nothing. Restores the input to sidecar rename recovery
  (`DocFingerprint.title_from_frontmatter`) that the bug currently destroys.

### N2. Make v1.1 draft seeding idempotent against DISK [S]
- Resolves: Renderer — Comments, Submit UX & Panes → "Re-opening a doc with a completed
  round re-seeds the next version's draft, clobbering comments" (high, C8 ✓).
- Done when: read-before-write guard (skip or merge into a non-empty existing draft, or a
  persisted `seeded_from: <submit_id>` marker) lands with the finding's "testable without
  the rig" test: complete round → add v1.1 comments → re-open v1 → v1.1 sidecar intact.
- Deps: the related stale `draftsCache` masking (Renderer — Orchestration "Also noted":
  path-keyed, never invalidated, can mask/overwrite the seeded file) should ride along —
  key by path+sha256 or delete the cache (S) — since it can mask this exact fix.

### N3. Filter `.abandoned.json` tombstones at BOTH layers [S]
- Resolves: Desktop Main — Persistence → "Abandoned-round tombstone is re-emitted by the
  results watcher" (high, C9 ✓) + Renderer — Comments → "applyResultsEvent has no
  `.abandoned` filter" (high).
- Done when: `isResultsName` rejects `*.abandoned.json` with a vitest case (the C9 verifier
  already node-tested the regex against `results-x.abandoned.json`), `applyResultsEvent`
  carries the belt-and-suspenders guard, and Abandon → doc re-open does not resurrect the
  round banner.
- Deps: none. Pick one side of the contract (filter vs `abandoned:true` flag) per the
  finding's recommendation; filtering is the default here.

### N4. Hoist status validation above the .tex mutation in apply/revert [S]
- Resolves: Engine — Core Pipeline → "apply_edit / revert_edit mutate the .tex file BEFORE
  status validation" (high, C1 ✓).
- Done when: pure reordering lands in both functions (current status already in hand per
  the finding) and a regression test shows `apply_edit` on an `accepted` annotation raises
  `IllegalStatusTransitionError` with the .tex file byte-identical to before the call.
- Deps: none; no happy-path behavior change.

### N5. Resolve the commit-phase vs extract .gitignore contradiction [S]
- Resolves: Engine — Core Pipeline → "commit_phase stages .gitignore'd `.review-state/`
  files without `-f` — exit-19 on every extract-bootstrapped project" (high, C2 ✓, repro'd
  on git 2.50.1).
- Done when: one policy wins (stop staging `.review-state/*` — the commit message already
  points at the snapshot path — or stage with `-f`) and a regression test whose fixture
  includes the extract-written .gitignore passes `commit-phase` cleanly.
- Deps: none. Unblocks the engine's commit loop on every real extract-bootstrapped project.

### N6. Un-strand the submit unhappy paths (retry/resume/compensation) [M]
- Resolves: Renderer — Comments, Submit UX & Panes → "Every submit failure path strands the
  user" (high, C10 ✓), including: timeout Re-sling no-op, circular Resume, Retry minting a
  duplicate round against the same-submit_id contract, and failed slings leaving comments
  `submitted` forever.
- Done when: a real `retrySling(submitId, destination)` entry point calls `submitSling`
  directly against the cached frozen `submitFilePath` (no re-promote, no picker);
  `canFire()`/`handleSubmitBundle` accept the retry path in `timeout`/`send_failed`; Resume
  wires to the same entry point; the `submit:comments-promoted` flip moves to after
  `slingResult.ok` (or a compensating un-promote fires on terminal failure/Dismiss). Unit
  tests cover timeout→retry reusing the SAME submit_id and failed-sling→comments back to
  `open`.
- Deps: per Renderer — Comments → "Zero tests on the submit state machine" (med/M), the
  transition-table/guard extraction from DOM rendering is "the precondition for safely
  landing the retry re-plumb" — that extraction + vitest is IN SCOPE for this item (it is
  why this is M, not S). Blocks nothing downstream but de-risks every later round-lifecycle
  change.

### N7. SPIKE (1 day): PDF /IRT reply chains [S]
- Resolves nothing directly; de-risks: Capability §1 → "replies where feasible = feasible-
  unproven" (GATE 1 packet UNCERTAIN: "PDF /IRT reply chains ... two 1-day spikes
  recommended in Capability §1").
- Done when: a throwaway spike (extend `desktop/spikes/rev-cvr-pdf-lib/` style) writes an
  /IRT-chained reply via pdf-lib, and Acrobat/Preview displays it threaded; result recorded
  as a dated note in docs/research/.
- KILL CRITERIA: if within 1 day pdf-lib cannot produce an /IRT chain that Acrobat renders
  as a threaded reply (or preserving existing chains through a write corrupts them), CUT
  reply CREATION from the PDF adapter scope (L4) — keep read-only display of existing
  replies via the union's `native.in_reply_to` field, which read-back already supports per
  Capability §7.
- Deps: informs the spec's `native.in_reply_to` semantics (X5) and the L4 adapter scope.
  Cheap, parallelizable with N1–N6.

### N8. SPIKE (1 day): per-line quads write-back [S]
- Resolves nothing directly; de-risks: Capability §1 spike (b) — the capture side already
  has `screenRects` per the finding; bundle.ts's single-region quad is an acknowledged v1
  limit (bundle.ts:73-76 as cited in Capability §1).
- Done when: spike writes a multi-line Highlight with per-line /QuadPoints from captured
  rects and it survives an Acrobat open/annotate/save cycle without bbox-collapse; result
  recorded as a dated research note.
- KILL CRITERIA: if within 1 day per-line quads either can't be produced reliably from the
  existing capture or don't survive the Acrobat round-trip, KEEP single-bbox writes as the
  shipped limit and mark `quads[]` in the union as read-fidelity-only (native annots read
  back with per-line quads regardless, per readback.json evidence in Capability §3).
- Deps: informs the `PdfQuadAnchor.quads[]` field semantics in the spec (X5) and L4 scope.

### Now-adjacent S fixes (recommended ride-alongs, drafter's judgement — same files, same sitting)
Not part of the mandated five, but confirmed/high-rated standalone S correctness fixes that
touch the same modules as N1–N6 and should not wait for Next:
- Empty-text revert destroys an unrelated line — Engine — Core Pipeline → "Revert after an
  empty-text apply" (med/S): reject empty `new_text` or special-case the degenerate range;
  add apply-empty→revert tests. Natural companion to N4 (same functions).
- `gt mail` stdin EPIPE can crash the main process — Desktop Main — Persistence (med/S):
  add the stdin error listener routing into the existing settle path. Companion to N6.
- Errored SDK session becomes a message-eating zombie + uncapped lazy session creation —
  Desktop Main — Claude/Agent → "Session-registry failure modes" (high/S): end queue, clear
  pending approvals, drop registry entry; create-only-for-conv. Standalone S.
- Re-created window never receives agent events — Desktop Main — Claude/Agent "Also noted"
  (S, C13 ✓): re-bind `mainWindowRef` on window creation.
- Skip-permissions setting silently rewritten to `true` — Renderer — Orchestration →
  "Skip-permissions setting read through a window-global" (med/S): module state + spread
  previously-read app state so no-UI fields can't be clobbered.
- Concurrent doc-open race mis-keys sidecars — Renderer — Orchestration → "Concurrent doc
  opens race" (high/S–M): load-epoch guard re-checked after every await. Listed here
  because it is a data-correctness guard independent of (and not to be deferred behind) the
  X8 DocSession restructure, which later subsumes it.

---

## NEXT — the anchor-union schema event + duplication-divergence convergence

Sequencing rule (from Capability §3: the union is "the precondition for both adapters", and
Exec Summary §2: it is "a three-party schema event"): X1–X5 land BEFORE any Later format
adapter. Convergence items (X6–X11) stop live behavioral drift before the multi-format work
multiplies it (Exec Summary §3).

### X1. Vitest safety net on the persistence writers, BEFORE the union retrofit [M]
- Resolves: Desktop Main — Persistence → "Test investment is inverted: zero tests on the
  three highest-consequence persistence writers" (med/M); partially Renderer — Comments →
  "Zero tests on the submit state machine" (remainder beyond N6's scope).
- Done when: vitest covers RESULTS_RE/tombstone behavior (locks in N3), quad-point ordering
  + out-of-range page skip, promote status-flip semantics, and shared/bundle.ts
  parsing/palette — the finding's own list.
- Deps: BLOCKS X5 (the finding: "Before any unified-model refactor, add vitest coverage";
  "it de-risks every other recommendation in this section").

### X2. Finalize the status-vocabulary mapping table (spec work, owner sign-off) [S–M]
- Resolves: Capability §4 → "Three status vocabularies, zero mapping code, near-miss names"
  (high/M — "the hardest non-code problem").
- Done when: the unified spec publishes ONE status set with an explicit two-way mapping
  against engine Status (9), desktop CommentStatus (7), and rig ResultEntryStatus (5), with
  every `?` cell from evidence/pass5/5B.md §3.3 decided — see Owner decisions OD-1 for the
  proposed defaults. No adapter code is written against an unfinished table (the finding's
  own rule).
- Deps: BLOCKS X5 (the union record carries `status: UnifiedStatus`) and all Later
  adapters. Pure spec work — can start immediately in Phase B (it belongs in the closer's
  spec file).

### X3. Split shared/types.ts along its five seams [M]
- Resolves: Desktop Main — IPC → "shared/types.ts is a 1008-line five-concern type
  god-file" (med/M).
- Done when: shared/engine.ts, shared/comments.ts, shared/files.ts, shared/ipc.ts,
  shared/pty.ts exist per the finding (mirroring the shared/agent-pane/ precedent) and
  typecheck passes across all three configs.
- Deps: the finding's explicit ordering — "do it as the FIRST step of the unified-model
  work, not after". shared/comments.ts is where X5 lands.

### X4. IPC type dedup + typed handle() wrapper [S then M]
- Resolves: Desktop Main — IPC → "The hand-wired typed IPC surface is vacuous on the result
  side and has already drifted on both bridges" (high/S–M); the no-runtime-validation
  finding's wrapper half (med/M).
- Done when: (S) engine.ts type copies deleted in favor of @shared imports; agentViewer
  bridge type moved to shared/ and imported by BOTH preload and ipc-client; the three
  `as any` casts deleted. (M) a typed `handle<K extends keyof ElectronAPI>` wrapper checks
  main-side bodies against the same contract the preload implements, with the per-channel
  runtime checks and the fs path-scoping from the sandbox finding folded in.
- Deps: the IPC finding's own deadline — "Land this before the multi-format work adds
  docx/html comment channels" (i.e., before L3–L6).

### X5. THE CENTERPIECE: per-comment discriminated anchor union (M-2) + DraftsFile v2 + rig coordination [M]
- Resolves (the three-party schema event, Exec Summary §2): Desktop Main — IPC → comment
  model accretes per-format fields; Desktop Main — Persistence → "Bundle writer is
  anchor-kind-blind" (med/M, C5 ✓); Renderer — Viewers → "HTML/DOCX anchors smuggled
  through md_anchor with as any" (high/M, C6 ✓); Capability §3 → unified model = M-2 union
  with `quads[]`/`origin`/`native_ref`; Capability §5 → "the rig results contract is
  PDF-typed too" (med/S spec, C12 ✓); Capability §7 → native-record field set.
- Done when, per the Capability §3 recommendation and the DRAFT sketch:
  - shared/comments.ts defines `anchor: PdfQuadAnchor | TextQuoteAnchor | HtmlSelectorHint
    | DocxRange(placeholder)` per comment (kinds named truthfully), plus `origin`
    provenance and `native_ref` (generalizing `pdf_annotation_id`);
  - DraftsFile `schema_version: 2` ships with a tolerant reader migrating v1 rows
    (file-level `anchor_kind` dropped as derivable), following the sidecar-migration
    precedent named in the sketch;
  - `writeBundle` narrows to the pdf anchor kind and skips/reports others (closes C5);
  - the `as any` write/read sites are deleted and `FileViewer.anchorKind` reports
    truthfully (closes C6); `MdAnchor` becomes the single imported definition;
  - submit/results files bump additively (`schema_version` fields already exist per
    Capability §5) and `new_anchor` is re-typed to the union — COORDINATED with the
    rig-side writer of results files (C12: "the rig contract moves with the desktop schema,
    not after it"). A rounds-compat note (old-schema results files still readable) is part
    of done.
- Deps: blocked by X1 (tests), X2 (status set), X3 (file split), and informed by N7/N8
  spike outcomes (quads/IRT field semantics). BLOCKS X6, X7, X13 and ALL Later format
  adapters (L3–L6). This is the single highest-leverage item in the roadmap, named by three
  passes (Exec Summary §2).

### X6. Renderer comment surface on the union: one payload builder, honest cards, polymorphic reveal [M]
- Resolves: Renderer — Comments → "The comment surface is PDF-shaped end-to-end:
  triplicated payload builders with placeholder anchors, cards that render 'p.1 · 0,0 0×0',
  reveal hard-wired to a never-nulled PdfViewer" (med/M).
- Done when: one `buildPayload(buf, anchorUnion)` replaces the three builders; per-kind
  card location renderer (page+rect / char-range / selector); reveal routes through the
  active viewer handle (nulled on switch like the other refs); click/Enter unified on
  `new_anchor ?? anchor`; `commitNewComment` tail + AUTHOR constant extracted.
- Deps: blocked by X5 ("the natural companion to the shared/comments.ts restructure").
  Blocks L3 (native PDF annots render through this same card stream).

### X7. openDocument + DocSession + format registry; renegotiate FileViewer around the union [M]
- Resolves: Renderer — Orchestration → "four cloned loaders whose reset/dispose lists have
  already diverged, atop 21 mutable module lets" (high/M); "Per-format knowledge scattered
  across ≥6 places with no registry" (med/S–M); Renderer — Viewers → "The FileViewer
  interface is decorative" (med/M).
- Done when: one `openDocument(path)` = teardown + DocSession reset + per-format adapter
  from a registry keyed by classifyPath; `shared/file-kinds.ts` consumed by classifyPath,
  tree.ts, main's classifyFile, and the indexer; Open… routes through the same dispatch;
  FileViewer renegotiated to `loadBytes(bytes, ctx)` / `onSelection(unified | null)` /
  `applyAnchors(Anchor[])` / `reveal(Anchor)` / `capabilities`, host holding ONE ref. The
  N-adjacent epoch guard is subsumed by the single-flight open queue.
- Deps: blocked by X5 (FileViewer's anchor-typed surface). Per the Orchestration
  reusability note, this is the structural precondition for L5/L6 — "before DOCX/HTML
  comment work lands, or that work becomes the fifth and sixth clones".

### X8. Claude-route convergence, staged per OD-3 [L overall; first parity items S each]
- Resolves: Desktop Main — Claude/Agent → "Two live Claude routes have materially divergent
  semantics" (high/L, C11 ✓); "Priming serialized twice with magic wall-clock delays"
  (med/M); Renderer — Comments → "new agent-pane workers are fire-and-forget" (high/M).
- Done when, staged: (1) [S each] cwd and skip-permissions parity land via one shared
  session-policy module both routes consume (defaults can no longer diverge); (2) [M] the
  shared pure priming module (bundle→text, doc-switch, fresh-start) with unit tests,
  pty-side triggered by observed output with timeout as fallback only; (3) [M] a minimal
  worker UI on the new-pane route (sessionId → status/stop) so spawned sessions are visible
  and stoppable; (4) the flag default flips ONLY after the parity checklist (cwd,
  permissions, worker cap, sling gating, resume) is green — per the C11 finding's own
  recommendation and the Renderer finding ("the flag flip is not yet safe as a default").
- Deps: depends on OD-3 (convergence target). The priming module is the natural place for
  anchor-kind-aware context (Claude/Agent capability note) — schedule stage (2) after X5.

### X9. One atomicWriteJson util at all seven write sites [S]
- Resolves: Desktop Main — Persistence → "Atomic temp+rename write helper duplicated 5×,
  with 2 non-atomic outliers writing the same artifact" (med/S); plus the session-store
  writeFileSync outlier (Claude/Agent "Also noted").
- Done when: one util in a main-process fs util (or shared/), used by submit.ts, bundle.ts,
  the three main/index.ts inline copies, the drafts:read relink, and sidecar-migration.
- Deps: none; cheap, do early in Next. Protects every sidecar the union migration (X5)
  rewrites.

### X10. Single-source the engine exit-code contract across both layers [S]
- Resolves: Engine — CLI → "Exit-code contract expressed four different ways, with a live
  21 overload" (med/S); Desktop Main — IPC → engine.ts bridge's hand-mirrored numeric set
  (med/S–M part).
- Done when: one `exit_codes.py` imported by cli/apply/commit/extract/server/pdf_health;
  preview's exceptions folded into the exit-code-carrying hierarchy; the 21 overload
  resolved or documented; pinning test extended; a TS constants twin emitted/checked with a
  contract test on the desktop side; `PdfHealthReport` minimally validated before the cast.
- Deps: none hard; do before L3–L6 multiply engine-backed calls (the bridge finding's
  warning). Pairs with engine.ts resolution memoization (same finding, S).

### X11. IframeDocViewer base: collapse the html/docx twins, one not-found behavior [M]
- Resolves: Renderer — Viewers → "html-viewer and docx-viewer are ~60% verbatim twins that
  have already drifted, and their selector/charOffset capture is lossy by construction"
  (med/M); plus the dark-mode inversion note ("Also noted").
- Done when: one base (stage/iframe/sandbox, injectStyles, wireSelectionCapture,
  applyHighlights, cssPath, findTextNode) with a `bytesToHtml` strategy; the two index.ts
  highlight functions collapse to one; ONE not-found behavior (skip, like docx); capture
  redesigned on the md strategy (prefix/quoted_text/suffix + fuzzyMatchAnchor) with the CSS
  selector demoted to a locality hint.
- Deps: blocked by X5 — the finding is explicit: "designed inside the unified anchor union,
  not before it". BLOCKS L5/L6 ("do it before the docx/html comment-UI epics, rev-2h6,
  rev-6k6").

### X12. Harden fuzzyMatchAnchor: verify guesses, immutable provenance [S–M]
- Resolves: Renderer — Viewers → "Fuzzy re-anchoring persists unverified guesses back into
  the sidecar, destroying the user's original referent" (med/S–M).
- Done when: steps 3-4 verify the candidate slice (similarity threshold, downgrade to
  orphaned on failure); nearest-occurrence disambiguation; ORIGINAL quoted_text/prefix/
  suffix immutable with relocations in separate fields; CONTEXT_CHARS exported;
  anchors.test.ts gains the four missing cases.
- Deps: blocks L5/L6 — per the Viewers reusability note this module is "the text-anchor leg
  of the unified model for MD, HTML, and DOCX alike", so its robustness is leveraged.
  Naturally co-lands with X5's TextQuoteAnchor.

---

## LATER — capability build-out, decompositions off the critical path, disposition decisions

### L1. Migration-safety hardening: guarded readers + CLI schema-error handling [M]
- Resolves: Engine — CLI → "Schema-version guard is bypassed by every mutator and uncaught
  when it fires — migration design can't work" (high/M, C3 ✓); Exec Summary §4 ("must be
  fixed before the schema-v2 bump the unified model forces").
- Done when: apply._read_json deleted; apply/commit/server state reads route through
  state.read_json with schema errors wrapped per the existing _guard_source_pdf pattern; a
  top-level cli.main catch maps SchemaVersionError/MigrationRequiredError to a spec'd exit
  code (which then rides X10's single source).
- Deps: HARD-BLOCKS L2 (no engine schema bump while the hot path bypasses the guard).
  Listed first in Later deliberately; pull earlier if L2's schedule moves up.

### L2. Engine schema-v2: persist subtype / native id / in_reply_to; de-LaTeX the names [M]
- Resolves: Engine — Core Pipeline reusability note ("annotations.json schema-v2 is
  unavoidable for the Acrobat round-trip"); Capability §7 ("the complete native-annotation
  record exists in-repo only as throwaway spike output"); the half-adopted dataclass layer
  finding's "pick a direction before schema-v2" (med/M — drift fixes (a)–(c) are S and
  should land immediately regardless, per that finding).
- Done when: annotations.json persists subtype, native annotation id, optional
  `in_reply_to`; `latex_file` → `file`; fuzzy_map's glob + strip function parameterized per
  format; the state.py dataclass-vs-dict direction decided and the three drifts fixed; one
  migration registered in migrate.py exercising the (now-working, L1) guard.
- Deps: blocked by L1; coordinated with X5's union (the `native` block adopts the
  readback.json field set per Capability §7). Blocks engine extraction serving as the PDF
  adapter's in-bound leg.

### L3. PDF round-trip, read half: display native annotations in the viewer [S–M]
- Resolves: Capability §1 → "pdf.js reads, pdf-lib writes" (read+display S–M); the
  format-capability matrix gap "desktop viewer does NOT display PDF annots".
- Done when: `page.getAnnotations()` is consumed inside the existing `renderPage`,
  normalized immediately into the union (X5), and rendered through the EXISTING card stream
  + reveal (X6) — explicitly NOT a second pdf.js annotation DOM, per the Capability §1
  recommendation. Native and draft comments share one surface; `origin` provenance prevents
  re-import duplication on the next bundle write.
- Deps: blocked by X5, X6 (and X7 for the viewer interface). First user-visible capability
  payoff of the union — schedule it first in Later.

### L4. PDF round-trip, write half: pdf-comments.ts adapter (create/edit/delete; StrikeOut/Text; replies per spike) [M]
- Resolves: Capability §1 write-back (M); the "unused richness" suspicion (StrikeOut/Text
  proven unshipped).
- Done when: bundle.ts extends into a per-format adapter implementing the X5 interface:
  create = existing buildHighlight + spike's StrikeOut/Text shapes; edit = locate by /NM or
  (page, index) captured at read time, stamping /NM on first edit of foreign annots; delete
  = remove from /Annots. Reply creation and per-line-quads write scope are set by N7/N8
  spike outcomes (kill criteria there). Port (don't invoke) the engine's bbox-crop fallback
  and sticky-association heuristics when foreign-PDF breadth lands.
- Deps: blocked by X5, N7, N8; informed by L2 (engine in-bound leg). Pairs with the
  Capability §6 bundle generalization (below).

### L5. DOCX comments.xml adapter, v1 flat comments + display [read M, write M, edit/delete S, display S]
- Resolves: Capability §2 → "jszip/fflate + hand-written OOXML adapter in main; SuperDoc
  stays rejected on new grounds"; the C14 ✓ range-marker nuance (create/delete must touch
  document.xml range markers — body TEXT untouched, part mutated; the spec must state
  this).
- Done when: main-process docx-comments.ts (jszip or fflate, one small new dep) reads
  comments.xml + range markers into unified comments; writes mint w:id, create part+rels
  when absent, insert range markers with run-splitting, anchors resolved by
  TextQuoteSelector scan; edit/delete per the finding; mammoth `comment-reference` style
  map lands independently (S) so native comment positions show in the iframe. Hedge on
  record: python-docx write-only via the engine if marker insertion proves nasty; revisit
  SuperDoc only if requirements grow to threaded replies + resolution + tracked changes.
- Deps: blocked by X5 (anchor union incl. the DocxRange-vs-text-fuzzy spec decision), X7
  (registry), X11 (iframe base), X12 (text-anchor leg). Closes beads epic rev-6k6.

### L6. HTML comments UI on the unified text anchor [S–M]
- Resolves: the Capability adapter-table HTML row ("declare the kind honestly; no native
  round-trip required"); the format matrix's "wired, no comment UI" gap.
- Done when: HTML comment creation/display runs on TextQuoteAnchor truth +
  HtmlSelectorHint locality (per X5/X11), through the X6 card surface. Closes beads epic
  rev-2h6.
- Deps: blocked by X5, X7, X11, X12. Cheapest of the format build-outs; good sequencing
  probe before L5.

### L7. Extract events.py from server.py; fix the --since cursor [M]
- Resolves: Engine — Server → "Keep-vs-kill: split the format-agnostic event bus out of
  server.py" (high/M), including the same-second event-drop and the kqueue side-effect
  notes.
- Done when: _validate_event/_append_event_line/wait_for_events/handle_wait_event live in
  an events.py with zero viewer imports; the --since cursor uses sub-second timestamps or a
  sequence number; wait-event gains its missing tests (the untested-subcommand finding).
- Deps: HARD-BLOCKS L8 (the finding: extract the survivable ~40% "before any keep-vs-kill
  decision"). The event bus is "the closest existing thing to a cross-layer comment-event
  bus" — relevant to any future engine↔desktop comment sync.

### L8. Legacy HTTP viewer + terminal.py disposition (per OD-2) [S–M]
- Resolves: Engine — Server → "Viewer auto-reload contract unimplemented — the legacy
  viewer's core loop is broken" (high/S, C4 ✓); the keep-vs-kill finding's option call;
  Exec Summary §4.
- Done when (proposed default = delete, OD-2): server-viewer + terminal.py + templates
  (~2.6K LOC + 283 KB vendored xterm) removed, `wait-event` retained on events.py; or, if
  the owner overrides to keep: do_HEAD implemented with Last-Modified/ETag, the
  SimpleHTTPRequestHandler fallthrough closed, and a "legacy, headless-only" freeze note.
- Deps: blocked by L7 and OD-2. Removes a whole parallel viewer stack from the maintenance
  surface (ground-truth domain trap #2 — decision, not discovery).

### L9. main/index.ts decomposition + single before-quit teardown [M; quit collapse S]
- Resolves: Desktop Main — IPC → "main/index.ts registers the IPC surface in three styles,
  and its two independent before-quit handlers double-run teardown" (med/M); the "Also
  noted" API-residue sweep (dead _sha256 params, pdf-only argv/index filters,
  fs:readPdfBytes naming) rides along (S).
- Done when: fs-ipc.ts / external-open.ts / quit-flush.ts registrars exist; ONE before-quit
  handler sequences flush → agent shutdown → pty shutdown → watcher stop before re-quit;
  the residue sweep lands (drop dead params, extend argv/index filtering to the FileKind
  set, rename the generic byte loader).
- Deps: the quit collapse (S) can be pulled into Next if quit-time data loss is observed;
  the rest is off the critical path. The FileKind extension overlaps X7's
  shared/file-kinds.ts — land that part with X7.

### L10. claude-pty.ts split + marker-parser tests — scope per OD-3 outcome [M]
- Resolves: Desktop Main — Claude/Agent → "claude-pty.ts mixes six concerns and its pure
  parser core has zero tests" (med/M).
- Done when: pure parts (β-marker parser, priming builders — superseded by X8's shared
  module — whichSync) are importable with vitest coverage. If OD-3's convergence retires
  the pty route on schedule, do ONLY the parser tests needed while it remains live and let
  retirement delete the rest (avoid investing in a deprecated surface).
- Deps: depends on OD-3 staging; whichSync consolidation pairs with L9's fs utils (the
  3× PATH-resolution note).

### L11. renderer/index.ts residual decomposition + hygiene batch [M]
- Resolves: Renderer — Orchestration "Also noted" cluster: one Debounced utility + drain
  registry; requireEl(id) + jsdom smoke test for the 87-id silent-bail class; writeFileText
  returning the new sha; tree filter walk debounce; basename/dirnameOf dedup;
  notifyPanesDocSwitch extraction.
- Done when: the listed S items land post-X7 (DocSession makes them mechanical).
- Deps: blocked by X7 (don't decompose twice). Explicitly NOT on the critical path for
  L3–L6.

### L12. Engine per-operation cost: window-index fuzzy_map + cached PDF guard [S–M]
- Resolves: Engine — Core Pipeline → "fuzzy_map re-reads and re-scores the entire .tex tree
  per annotation; every mutator re-hashes the full source PDF" (med/S–M).
- Done when: build_window_index(root) + resolve(target, index) split (M); PDF guard cached
  per (path, mtime, size) and apply_batch guards once (S).
- Deps: the finding notes the refactor "pays twice" — the index/resolve shape is what a
  unified cross-format anchor resolver needs — so co-design with X12/X5's resolver, but
  don't block them on it.

### L13. Engine contract polish batch: uniform --json, untested subcommands, status-enum single source [S each]
- Resolves: Engine — CLI → "--json silently ignored by most subcommands" (low-med/S);
  "bulk-surface and wait-event untested" (med/S); Engine — Core "Also noted" status-enum
  4× definition (S); preview build-ID TOCTOU + in-place-edit snapshot (Engine — Server,
  med/S and med/M) if the preview path survives the L8 disposition.
- Done when: structured {error, exit_code} envelope at minimum; the two test modules exist;
  canonical status sets exported from state.py (feeding X2's mapping table); preview fixes
  decided alongside L8.
- Deps: the status-enum export is an input to X2 — pull that single S forward into Next.

### L14. Bundle generalization: per-format native artifact + sidecar [S spec + rides L4/L5]
- Resolves: Capability §6 → "the bundle grammar already parses md/tex sources but
  hard-commits every round to a PDF+JSON pair" (med/S spec).
- Done when: SubmitFile carries `{ native_artifact_path?, sidecar_json_path?, format }` per
  round (transport already tolerates it — matching is doc_version-only); writers
  generalized as part of L4/L5 adapter work.
- Deps: spec decision belongs in the X5 spec file; implementation rides the adapters.

### L15. Retire the sidecar migration; single doc-identity function [S]
- Resolves: Desktop Main — Persistence "Also noted": permanent startup migration machinery
  for a completed one-shot migration; inline fingerprint re-implementation; mintSubmitId/
  mintBundleId duplication + same-second overwrite uniquification.
- Done when: migration deleted keeping findSidecarByFingerprint; one canonical fingerprint
  function; shared id minting with uniquification.
- Deps: do after X5's v2 migration lands (it reuses the tolerant-reader precedent first).

---

## Owner decisions (GATE 1 packet UNCERTAIN list) — PROPOSED DEFAULTS

Each of these is a pending owner decision per the GATE 1 packet. A default is proposed with
rationale; none is settled. All four are marked: **PROPOSED DEFAULT — owner may override at
GATE 2.**

### OD-1. Status-vocabulary mapping cells (feeds X2)
PROPOSED DEFAULT — owner may override at GATE 2:
- engine `needs_review` → unified `build-failed` family, NOT `needs-followup`. Rationale:
  Capability §4 warns the naive merge "silently conflates engine needs_review
  (apply-failure flow) with rig needs-followup (disposition)" — the proposed default keeps
  the failure-flow semantics with the failure-flow value and reserves `needs-followup` for
  reviewer disposition only.
- engine `surfaced_pending` → unified `open`. Rationale: it is a pre-disposition state;
  mapping it anywhere else would create a sixth live vocabulary value with no desktop
  surface.
- engine `accepted` and `redrafted` → unified `applied`, with the accepted/redrafted
  distinction preserved losslessly in the union's `workflow` block (the DRAFT sketch
  already carries `workflow.proposed_text/applied_text`). Rationale: collapses the
  near-miss surface area while losing nothing — the engine-side detail stays queryable.
- The full 3-way table with these defaults filled in goes in the Phase-B spec file
  (per Capability §4: spec before adapter code), sourced from evidence/pass5/5B.md §3.3.

### OD-2. Legacy HTTP viewer + terminal.py: keep vs kill (feeds L7/L8)
PROPOSED DEFAULT — owner may override at GATE 2: **kill** — option (a) of the Engine —
Server keep-vs-kill finding: after L7 extracts events.py, delete server-viewer +
terminal.py + templates, keeping only `wait-event`. Rationale: the viewer's core loop is
confirmed broken (C4 ✓ — it cannot auto-reload, and nobody noticed, which is itself the
strongest usage evidence); the finding's own conclusion is "Evidence favors (a) unless a
headless use-case is documented", and none is on record; ~2.6K LOC + vendored xterm of
carrying cost disappears from a daily-driver tool the Electron app superseded by design
(spec §10 per the ground-truth map).

### OD-3. Claude-route convergence target (feeds X8/L10)
PROPOSED DEFAULT — owner may override at GATE 2: **converge on the SDK/agent-pane route**;
retire the pty route after X8's parity checklist (cwd, permissions param, worker cap, sling
gating, resume) and the worker UI land. Rationale: the C11 finding itself names the SDK
route "the structurally better base — typed events, native permission hooks, no TUI timing
races"; the Claude/Agent section's positive note records the SDK-route cluster as the
best-tested desktop code ("the right reuse substrate"); and the wall-clock priming fragility
class "disappears on the SDK route" per the priming finding. The pty route's worker UI
(stop/retry/progress) is kept as the REQUIREMENTS SPEC for the SDK worker surface, per the
Renderer — Comments reusability note ("treat it as the requirements spec ... not as
deletable legacy").

### OD-4. `_reviewer_rig_guard` commit-phase exemption (small; rides N5/X10 territory)
PROPOSED DEFAULT — owner may override at GATE 2: **document the exemption as deliberate, do
not extend the guard** — add the spec-§10.5.2 reference at the guard site and a test
pinning the exact guarded subcommand set (apply/build/revert) so the set can't drift
silently. Rationale: the Engine — CLI finding itself flags the exemption as "possibly
deliberate per spec §10.5.2"; documenting + pinning is the no-behavior-change option and
converts an open question into an enforced contract; if the owner instead wants commit-phase
guarded, it is a 2-line change at the same site.

---

## Dependency spine (one screen)

```
NOW    N1 N2 N3 N4 N5 N6  (independent S/M fixes)   N7,N8 spikes ──┐
NEXT   X1 tests ┐                                                  │
       X2 status┼─► X5 ANCHOR UNION (3-party: sidecar+submit/results+rig)
       X3 split ┘        │                                         │ (spike outcomes
       X4 IPC dedup      ├─► X6 comment surface                    │  set quads/IRT scope)
       X9 atomic util    ├─► X7 DocSession/registry/FileViewer     │
       X10 exit codes    ├─► X11 iframe base ──► X12 fuzzy guard   │
       X8 claude converge (OD-3)                                   │
LATER  L1 migration guard ─► L2 engine schema-v2 ─► (PDF in-bound) │
       X5+X6+X7 ─► L3 PDF read ─► L4 PDF write ◄───────────────────┘
       X5+X7+X11+X12 ─► L5 DOCX adapter, L6 HTML comments
       L7 events.py ─► L8 legacy disposition (OD-2)
       L9–L15 off critical path
```

Ordering rationale, restated: Now items are standalone and must not wait (GATE 1 packet
CHECK item); the union (X5) lands BEFORE every format adapter that depends on it
(Capability §3) and is coordinated as a three-party schema event (Capability §5, C12 ✓);
convergence items stop live divergence before multi-format work multiplies it (Exec Summary
§3); capability build-out, off-path decompositions, migration hardening, and the
legacy-viewer disposition follow (Exec Summary §4–5).

— end B1 draft (closer merges; do not edit REVIEW.md from this lane)
