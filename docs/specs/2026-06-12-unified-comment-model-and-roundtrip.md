# Unified Comment Model & Multi-Format Round-Trip — Specification

| Field | Value |
|---|---|
| Title | Unified cross-format comment/annotation model and native round-trip (PDF / DOCX / MD / HTML) |
| Date | 2026-06-12 |
| Status | PROPOSED — Phase B output of the 2026-06-12 architectural review. GATE 1 OPEN (approved by Anthony Byrnes 2026-06-12); GATE 2 CLOSED — **no implementation may begin from this document until GATE 2 opens**. |
| Author | Claude (Fable 5), Phase B (drafted lane B2, challenged lane B3, promoted by the Phase-B closer), on behalf of Anthony Byrnes |
| Repo | `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/` |
| Primary input | `docs/reports/arch-review/2026-06-12/REVIEW.md` (Phase A, ~57 findings, 14/14 verification) — esp. the Capability section and its "DRAFT — input to Phase B" sketch; companion roadmap in REVIEW.md `## Roadmap` |
| Challenge trail | `docs/reports/arch-review/2026-06-12/evidence/phaseB/B3-challenge.md` (14 issues) and `B4-dispositions.md` (all resolved; the fixes are folded into this text) |
| Raw evidence | `evidence/pass5/5B.md` (assets + sketch), `evidence/pass5/5A.md` (options + trade-offs) |
| Related — design | [`2026-05-16-review-pdf-to-latex-design.md`](2026-05-16-review-pdf-to-latex-design.md) (engine contract §5–§9 authoritative), [`2026-05-19-electron-app-ux-spec.md`](2026-05-19-electron-app-ux-spec.md) |
| Related — research | `docs/research/2026-05-21-pdf-lib-annotation-spike/`, `docs/research/2026-05-16-superdoc-fit-analysis.md` |
| Supersedes | The "DRAFT — input to Phase B" sketch inside REVIEW.md's Capability section (this document is its full elaboration) |
| Decision marking | Every unsettled point is marked **PROPOSED DEFAULT — owner may override at GATE 2**. Unmarked statements rest on verified Phase-A findings. |

---

## 1. Summary

This spec turns the charter's capability direction — full PDF annotation-level round-trip, DOCX comment round-trip with read-only body, MD kept editable, HTML read-only + comments, all bridged by ONE comment model — into a concrete schema, adapter contract, migration plan, and rollout order, every piece grounded in a cited Phase-A finding.

The centerpiece is the **M-2 per-comment discriminated anchor union** (REVIEW.md Capability §3; options analysis in 5A §iii), replacing today's required PDF-shaped anchor on every comment in every format (types.ts:130, verified C5/C6). It is a **three-party schema event** — drafts sidecar, submit/results files, and the rig contract move together, because `ResultEntry.new_anchor` is PDF-typed today (types.ts:245, verified C12). The per-format adapters are second instantiations of two proven in-repo templates: the bundle.ts six-step pipeline (5B A3) and the pdfHealth wrap-a-subcommand precedent (5B A8). The hardest non-code problem — three status vocabularies with near-miss names (Capability §4; scope correction in §6) — is resolved here by a single mapping table whose previously-open `?` cells get PROPOSED DEFAULTS.

Everything in this document is implementable as beads once GATE 2 opens; nothing here is implemented now.

## 2. Scope, inputs, and evidence discipline

**In scope:** the unified comment record and anchor union (§3); schema versioning and migration for drafts sidecars, submit/results files, and the rig contract, with rollout order (§4); the per-format adapter contract and the four adapters (§5); the unified status vocabulary and mapping table (§6); the engine/desktop boundary decision (§7); the open spikes with kill criteria (§8).

**Out of scope (roadmap items, not this spec):** the renderer decomposition that hosts this model (`openDocument`/`DocSession`/format registry — REVIEW.md "Renderer — Orchestration & Chrome"; roadmap X7); the five shipping data-loss bugs C1/C2/C7/C8/C9 (roadmap N1–N5 — though §4.4 names the two that are hard prerequisites); the Claude-route convergence (X8); the legacy HTTP viewer keep-vs-kill (touched only where it intersects §7); any visual in-place PDF annotation-editing UX (pdf.js AnnotationEditorLayer deliberately not evaluated — REVIEW.md Capability "Also noted").

**Evidence basis:** REVIEW.md findings are cited by section/claim id (C1–C14 were independently re-verified in Pass 6). Schema lines quoted in this spec were re-opened in the Phase-B drafting session: `desktop/shared/types.ts:110-192` (CommentStatus, AnchorRegion, CommentPayload, AnchorKind, DocFingerprint, DraftsFile) and `:211-270` (SubmitFile, ResultEntryStatus, ResultEntry, ResultsFile); `src/review_pdf_to_latex/state.py:173-183` (engine `Status` Literal, 9 values). The B3 challenge re-opened `types.ts:109-117` and `:227-235` and re-grepped the spike artifacts; its corrections are folded in (B4 dispositions).

**Charter amendment carried forward (FACT, verified C14):** the charter phrase "DOCX: comments.xml read/write, body read-only" is exactly true only for *editing* comment text. Comment CREATE/DELETE must insert/remove range-marker elements in `document.xml` — body **text** stays untouched, but that part is mutated (python-docx 1.2.0 docs, re-fetched verbatim in Pass-6 verification). This spec states it as a requirement rather than letting implementation discover it.

## 3. The unified comment model

### 3.1 The anchor union

Today's shape — and why it must go — is verified end-to-end: a REQUIRED PDF `AnchorRegion` on every comment (types.ts:121-124, :130), an optional bolted-on `md_anchor?` (types.ts:159-165), a FILE-level two-value discriminator (`AnchorKind`, types.ts:170; on DraftsFile types.ts:190), HTML/DOCX anchors smuggled through `md_anchor` with `as any` (C6 ✓, renderer/index.ts:2214-2223), a bundle writer that consumes the PDF anchor blind (C5 ✓, bundle.ts:67-68, :203-204), and cards rendering "p.1 · 0,0 0×0" for three of four formats (REVIEW.md "Renderer — Comments"). Option M-1 (keep accreting `*_anchor?` fields) is rejected on three passes' live-bug evidence (5A §iii).

The replacement is a per-comment discriminated union. Kinds are named truthfully (the misreporting `anchorKind` getters in html/docx viewers — C6 — become impossible by construction). Field names below are normative for the v2 schema; TS spellings may be adjusted mechanically at implementation.

```ts
// shared/comments.ts (new module — part of the types.ts five-way split,
// REVIEW.md "shared/types.ts is a five-concern god-file"; roadmap X3)

type Quad = { x1: number; y1: number; x2: number; y2: number;
              x3: number; y3: number; x4: number; y4: number }; // Acrobat order, per bundle.ts QuadPoints precedent

type Anchor =
  | { kind: 'pdf-quad';
      page: number;
      region: { x: number; y: number; w: number; h: number };  // = today's AnchorRegion (types.ts:121-124)
      quads?: Quad[];                                            // PLURAL — per-line; round-trip requirement (a), 5A §iii
    }
  | { kind: 'text-quote';
      char_start: number; char_end: number;
      prefix: string; suffix: string; quoted_text: string;       // = MdAnchor verbatim (shared/md/anchors.ts:1-7)
      relocated?: { char_start: number; char_end: number } | null; // fuzzy relocations land HERE; originals immutable (Pass-4B finding)
    }
  | { kind: 'html-selector-hint';
      selector: string; char_offset: number; char_length: number; quoted_text: string;
      // Legitimizes the smuggled hybrid (renderer/index.ts:2214-2223) as a declared kind.
      // HINT only: resolution truth is a sibling text-quote anchor (Pass-4B verdict on the lossy capture scheme).
    };
```

Design rules baked into the union (each tied to its finding):

1. **`quads[]` is plural** on the PDF kind. Native annotations read back with per-line quads (spike readback.json) while the shipped writer is single-bbox by acknowledged limit (bundle.ts:73-76). The model must not be lossier than the data; whether the *writer* emits multi-quad is spike S-2 (§8).
2. **Originals are immutable.** The fuzzy re-anchoring bug (REVIEW.md "Fuzzy re-anchoring persists unverified guesses") destroyed provenance by rewriting `quoted_text/prefix/suffix` in place. v2 stores relocations in `relocated` (and round-level moves in `new_anchor`, §4.3); `quoted_text/prefix/suffix/char_*` are write-once. This imports the one W3C Web Annotation pattern worth having — selector redundancy — without JSON-LD (5A M-3 analysis).
3. **`text-quote` is ONE kind shared by MD, HTML, and DOCX body text.** Same resolver (`fuzzyMatchAnchor`, shared/md/anchors.ts — pure, tested, with the Pass-4B verification guard added as a prerequisite; roadmap X12), three formats (5B A5).
4. **No `docx-range` anchor kind.** PROPOSED DEFAULT — owner may override at GATE 2 (this closes the open decision flagged in the GATE 1 packet UNCERTAIN list): DOCX comments anchor by `text-quote` over the document's linear run text; the OOXML range markers are the *native projection* of that anchor, recorded in `native_ref` (§3.2), not a separate anchor kind. Rationale: Pass 4B showed DOM-path anchors against regenerated content are the wrong substrate ("`nth-of-type` paths against mammoth-regenerated DOM, with no stable mapping back to OOXML ranges"); OOXML ranges are unstable across Word edits for the same reason; the text-quote scan over run text is exactly the resolution mechanism the DOCX writer needs anyway (5A DOCX-A). Cost accepted: re-resolution on each read instead of direct range lookup — mitigated by `native_ref.docx.comment_id` giving O(1) access to the *marker* position when the file is unchanged.

### 3.2 The unified comment record (CommentPayload v2)

The v2 record is today's `CommentPayload` (types.ts:126-166) restructured per the 5B Part-3 sketch, plus the three round-trip-driven blocks 5A added (`origin`, `native`, union-typed lineage):

```ts
interface CommentV2 {
  id: string;                            // unchanged (types.ts:127)
  doc_id: string;                        // unchanged
  doc_version: string;                   // unchanged (sha256) — the results-watcher match key (results-watcher.ts:123-124)
  anchor: Anchor;                        // REQUIRED union — replaces AnchorRegion + md_anchor + the smuggle
  // body — unchanged 1:1 with v1 (types.ts:131-141):
  highlighted_text: string;
  comment: string;
  redraft: string | null;
  redraft_suggestion: string | null;
  engagement_level: 'comment' | 'redraft' | 'surface';   // types.ts:105
  author: string;
  kind: 'comment';
  status: CommentStatus;                 // unchanged 7-value desktop enum (types.ts:110-117) — see §6: the
                                         // UNIFIED vocabulary is the desktop enum; engine statuses map at the seam
  created_at: string;
  submitted_at?: string | null;
  agent_note?: string | null;
  new_anchor?: Anchor | null;            // RE-TYPED from AnchorRegion (types.ts:150) — the rig-contract half, §4.3
  derived_from?: string | null;          // unchanged (types.ts:153)
  // NEW — round-trip blocks (5A §iii requirements (b) and (c); 5B F4):
  origin: 'app-draft' | 'native-pdf' | 'native-docx' | 'engine-extract';
  native?: {
    comment_id: string;                  // generalizes pdf_annotation_id (types.ts:155-156); PDF /NM; DOCX w:id
    subtype?: 'Highlight' | 'StrikeOut' | 'Underline' | 'Squiggly' | 'Text' | string;  // readback.json field set
    author?: string; color?: string; created?: string;
    in_reply_to?: string;                // reply parent — captured nowhere today; population gated on spike S-1's READ half (§8)
    page_index?: number; annot_index?: number;  // read-time fallback handle for foreign annots lacking /NM (5A rec (i))
  } | null;
}
```

Field-level dispositions versus v1:

- **`md_anchor` is deleted** (folded into the union). **`pdf_annotation_id` is deleted** (folded into `native.comment_id`). Both removals are migration-shimmed (§3.3), never breaking-read.
- **`origin` is REQUIRED** (migration writes `'app-draft'` for all v1 rows). It exists because `writeBundle` regenerates the bundle PDF from scratch on every save (bundle.ts:152) — without provenance, every native annotation imported by the read path would be re-written as a duplicate app annotation on the next save (5A §iii requirement (b)). The bundle writer emits only `origin === 'app-draft'` comments as *new* annotations; `native-pdf` rows round-trip through their `native_ref` instead.
- **`native` is the normative native block**, field set adopted from the spike's readback records `{page, subtype, rect, contents, author, color, quads[]}` (readback.json:1-42; 5B F4) — the only complete native-annotation record in the repo today. Note that set contains NO reply parent: `in_reply_to` is aspirational until spike S-1's read half proves it extractable (challenge issue 3; §8).
- **`status` stays the 7-value desktop enum.** PROPOSED DEFAULT — owner may override at GATE 2: the unified vocabulary IS `CommentStatus` (types.ts:110-117) extended by nothing; engine statuses are *mapped* at the boundary (§6, §7) rather than merged into one super-enum. Rationale in §6.

### 3.3 DraftsFile v2 and the migration story

```ts
interface DraftsFileV2 {
  schema_version: 2;                     // bump from literal 1 (types.ts:187)
  doc_version: string;
  format: 'pdf' | 'md' | 'docx' | 'html';  // NEW file-level fact (a sidecar is per-doc); REPLACES anchor_kind
  comments: CommentV2[];
  doc_fingerprint?: DocFingerprint;      // unchanged (types.ts:175-180)
}
```

`anchor_kind` is dropped: it was the file-level discriminator whose absence/lying produced C5/C6; under the union it is derivable per comment and meaningless per file. `format` replaces it because the *document's* format is genuinely file-level (it drives adapter selection, §5).

**Migration (v1 → v2), in main, LAZY at read time** — reusing the tolerant-reader half of the sidecar-migration precedent (domain trap #5; Pass 3C) while explicitly REJECTING its startup-sweep half (the Pass-3C startup-cost finding is the anti-pattern to avoid repeating; this is the single migration story — challenge issue 9), plus the documented default "existing sidecars without `anchor_kind` default to `'pdf-glyph-rect'`" (types.ts:168-169 comment):

1. `drafts:read` detects `schema_version: 1` and migrates rows **in memory**; the file is rewritten as v2 only on the next `drafts:write` (no startup-blocking sweep).
2. Per-row mapping, exhaustive over the FIVE real v1 shapes (the four Pass 4B identified, plus `new_anchor` — challenge issue 8):
   - `anchor_kind` absent or `'pdf-glyph-rect'` → `anchor = { kind: 'pdf-quad', page, region }` from the v1 `anchor`; no quads (v1 never had them).
   - `anchor_kind === 'md-fuzzy-snippet'` with a clean `md_anchor` → `anchor = { kind: 'text-quote', ...md_anchor }`; the v1 placeholder PDF `anchor` (`page:1, 0,0 0×0` — renderer/index.ts:2237) is **discarded**, not preserved.
   - `md_anchor` carrying the smuggled selector fields (detectable exactly as the shipped sniff does: `md_anchor && (md_anchor as any).selector`, renderer/index.ts:1686) → `anchor = { kind: 'html-selector-hint', selector, char_offset, char_length, quoted_text }`. The degenerate `prefix:''/suffix:''` v1 context is not carried into a fake text-quote; re-capture of a true text-quote happens lazily on next view (HTML adapter, §5.5).
   - `new_anchor` present and non-null (`{ page, region }`, types.ts:150 — rig-written) → `new_anchor = { kind: 'pdf-quad', page, region }`; the same tolerant bare-shape parse as §4.3, applied at migration time; null/absent passes through unchanged.
   - `pdf_annotation_id` present → `native = { comment_id: pdf_annotation_id }`, `origin: 'app-draft'` (it was app-written by bundle.ts, /NM-stamped — bundle.ts:104).
   - Everything else: `origin: 'app-draft'`; body/status fields copy verbatim.
3. The migrated write must be **atomic and clobber-safe**: it goes through the single extracted `atomicWriteJson` (the duplication finding, REVIEW.md "Persistence & Submit"; roadmap X9 — eight sites) and must not interact with the C8 re-seed path — the seeding-idempotence fix (read-disk-before-seed) is a hard prerequisite (§4.4 step 0).
4. Vitest coverage for all five row shapes plus an already-v2 passthrough, in the style of sidecar-migration.test.ts (the best-covered desktop module — REVIEW.md Pass-3 takeaway).

**Downgrade story:** none. v2 readers never write v1; a v1-only build opening a v2 sidecar fails loudly on the literal `schema_version` mismatch rather than silently mutating — which is precisely the protection the engine side currently lacks (C3) and must gain before its own bump (§7).

## 4. The three-party schema event

`new_anchor` is written by the rig and consumed by the renderer's reveal path (`c.new_anchor ?? c.anchor`, renderer/index.ts:2398), and it is PDF-typed in BOTH the comment and the rig's result entry (`CommentPayload.new_anchor?: AnchorRegion | null`, types.ts:150; `ResultEntry.new_anchor?: AnchorRegion | null`, types.ts:245; C12 ✓). So the union is not a desktop-internal change. The three parties and their exact deltas:

### 4.1 Party A — drafts sidecar (desktop-private)

Delta: §3.3 in full. Sole reader/writer is the desktop main process (`draftsPathFor`, main/index.ts:47-50; engine never reads drafts — ground-truth architecture facts). **Can ship first, unilaterally.**

### 4.2 Party B — submit/results files (desktop writes submit; rig writes results)

Both files already carry optional `schema_version?: 1` (types.ts:212, :258), so versioning is additive (5B F3).

- `SubmitFile` v2: `schema_version: 2`; `comments: CommentV2[]` (the frozen audit copy inherits the union); `bundle_pdf?`/`bundle_json?` generalized to `native_artifact_path?: string; sidecar_json_path?: string; format: 'pdf'|'md'|'docx'|'html'` (5B F2 — the fields are already optional and the watcher never reads them, results-watcher.ts:123-124, so this is rename + addition, not behavior change). PROPOSED DEFAULT — owner may override at GATE 2: keep `bundle_pdf`/`bundle_json` as deprecated aliases populated for PDF rounds during the transition window, dropped at v3.
- `ResultsFile` v2: `schema_version: 2`; `ResultEntry.new_anchor?: Anchor | null` (union-typed). `ResultEntryStatus` unchanged (5-value, types.ts:230-236) — §6 keeps it a strict subset of the unified vocabulary.
- The §10.4 filename grammar carries over untouched — `SOURCE_NAME_RE` already parses `(pdf|md|tex)` (shared/bundle.ts:20; 5B A4); the "always PDF+JSON" *comment* at shared/bundle.ts:32-37 is superseded by the `format` field.

### 4.3 Party C — the rig contract

What the rig must change (and nothing more): (a) **read** v2 submit files — i.e. tolerate the union `anchor` and the renamed artifact fields; (b) **echo** anchors in the kind it received — a relocated `text-quote` comment gets a `text-quote` `new_anchor`, a `pdf-quad` gets `pdf-quad`; (c) **write** `schema_version: 2` results files. The rig's matching/dedup key (`submit_id`) and round semantics are untouched — the transport was verified format-agnostic end to end (5B A7: promote/sling/watch/match is path/id/string-only).

**Old-payload tolerance, both directions, forever:** a bare `{ page, region }` object (no `kind`) appearing in any `new_anchor` — on the wire or in a sidecar row at migration time (§3.3) — is structurally unambiguous and is read as `{ kind: 'pdf-quad', ... }`. This single tolerant-parse rule means v1 results files on disk (and a not-yet-updated rig emitting v1-shaped relocations for PDF rounds) keep working without a flag day.

### 4.4 Compatibility and rollout order

Order is forced by who reads whose files (REVIEW.md Capability §5: "the schema bump must be coordinated with the rig-side writer of results files, or relocations stay PDF-only"):

| Step | Party | Ships | Tolerates |
|---|---|---|---|
| 0 | desktop | **Prerequisite fixes**: C8 seed-idempotence (roadmap N2 — the migration rewrite must not ride a known clobber path); pre-v2 C5 exposure closed by the implementable v1-shape guard — `writeBundle` rejects comments whose file-level `anchor_kind !== 'pdf-glyph-rect'` or that carry `md_anchor`, plus the explicit `classifyPath(...) === 'pdf'` submit gate (REVIEW.md "Renderer — Comments" Also-noted rec; reworded per challenge issue 7 — pre-v2 there is no `pdf-quad` kind to key on) | — |
| 1 | desktop | DraftsFile v2 + tolerant v1 reader + lazy migration (§3.3); `shared/comments.ts` split out of types.ts; all renderer payload builders collapse to one `buildPayload(buf, anchor)` (REVIEW.md "Comments, Submit UX" rec); **v2-results tolerance: the results reader accepts BOTH v1 and v2 results files and both `new_anchor` shapes** (challenge issue 4 — this must not wait for step 3); the **v2→v1 SubmitFile down-converter** for the transition window: `pdf-quad` → required `{page, region}` (drop `quads`) — sufficient because only PDF rounds promote during the window (the step-0 gate makes today's accidental PDF-only gate explicit; challenge issue 11) | v1 sidecars (reads + migrates); v1 AND v2 results files; still EMITS v1 SubmitFile |
| 2 | rig | v2 submit-file reader + kind-echoing `new_anchor` + v2 results writer | v1 submit files (existing behavior); bare-`{page,region}` anchors |
| 3 | desktop | flips SubmitFile writer to v2. **Gate, named and checkable (challenge issue 10):** the flip lands only after at least one rig-written results file with `schema_version: 2` has been observed for a real round, recorded in a bead | v1 AND v2 results files, permanently (the §4.3 tolerant-parse rule) |
| 4 | both | DOCX/MD/HTML rounds become possible (non-PDF `format` in SubmitFile) | — |

Until step 3 completes, relocations stay PDF-only — which is exactly today's behavior, so nothing regresses at any intermediate step. The results watcher needs **zero** changes at any step (match is `doc_version`-only, results-watcher.ts:123-124).

PROPOSED DEFAULT — owner may override at GATE 2: no runtime version *negotiation* (e.g. rig advertising capabilities). With a single owner operating both sides, deploy-order discipline per the table — including the step-3 observed-v2-results manual gate — is cheaper than a handshake protocol; revisit if a second rig operator ever exists.

## 5. Per-format adapters

### 5.1 The adapter contract

Distilled from the two proven in-repo templates — bundle.ts's six-step pipeline (read source → mint ids → write native → stamp ids into sidecar → return id map; step comment bundle.ts:141-156; 5B A3 "THE adapter template") and the pdfHealth wrap-a-subcommand precedent (engine.ts:264-288; 5B A8):

```ts
// shared/comments.ts
interface FormatCommentAdapter {
  format: 'pdf' | 'md' | 'docx' | 'html';
  capabilities: {
    readNative: boolean;     // can ingest comments authored outside the app
    writeNative: boolean;    // can write comments into the native file format
    editNative: boolean; deleteNative: boolean;
    replies: boolean;        // thread support (PDF: pending spike S-1, BOTH halves; DOCX false in v1)
    bodyEditable: boolean;   // MD only, per charter
  };
  readNative(sourcePath): Promise<CommentV2[]>;                       // main process
  writeNative(sourcePath, comments: CommentV2[]): Promise<{ artifactPath: string; idMap: Record<string,string> }>;
}
```

The renderer-side twin of this seam is the renegotiated `FileViewer` (capabilities record, `applyAnchors(Anchor[])`, `reveal(Anchor)`, unified selection — REVIEW.md "The FileViewer interface is decorative"; roadmap X7) — owned by the renderer-decomposition work, referenced here only as the display surface every adapter renders through: **the existing card stream is the single UI for native and draft comments alike** (charter centerpiece; 5A recommendation (i) explicitly rejects a second pdf.js annotation DOM).

### 5.2 PDF — pdf.js reads, pdf-lib writes (split-library, both already shipped)

Adopts REVIEW.md Capability §1 / 5A recommendation (i) unchanged; restated normatively:

- **READ + DISPLAY (renderer, S–M):** `page.getAnnotations()` inside the existing `renderPage` (pdf-viewer.ts:204 slot; the viewer is grep-verified annotation-free today). Each native annotation is normalized immediately to `CommentV2` with `origin: 'native-pdf'`, `anchor: { kind: 'pdf-quad', page, region: rectToRegion(rect), quads }`, and `native = { comment_id: NM ?? minted, subtype, author, color, created, in_reply_to?, page_index, annot_index }` (`in_reply_to` only if spike S-1's read half passes). Rendered through the card stream + the existing `revealAnchor`/`drawHighlight` primitives (pdf-viewer.ts:288-317, :447-463). pdfjs-dist ^5.7.284 is already a dependency (package.json:72).
- **WRITE / EDIT / DELETE (main, M):** extend bundle.ts into `main/pdf-comments.ts` implementing the adapter. Create = the shipped `buildHighlight` (bundle.ts:59-108) plus the spike-proven StrikeOut and Text(sticky) dict shapes (2026-05-21 spike README; spike.mjs). Edit = locate the dict by /NM for app-written annots (bundle.ts:104 precedent) or by the read-time `(page_index, annot_index)` handle for foreign annots, **writing /NM on first edit** so subsequent edits are id-addressed. Delete = remove the ref from /Annots. Replies = behind spike S-1 (§8), BOTH halves — "replies where feasible" per charter stays feasible-unproven on read AND write until the spike runs.
- **Duplicate-prevention rule (binding):** `writeNative` re-emits as new annotations ONLY `origin === 'app-draft'` comments; `native-pdf` rows are preserved/edited via `native_ref`. This is the §3.2 `origin` requirement applied to the "regenerated from scratch on every write" writer (bundle.ts:152).
- **Foreign-PDF robustness (deferred, port-don't-invoke):** the engine's pdfplumber bbox-crop fallback (extract.py:113-156 region, domain trap #8) and sticky→highlight association (extract.py:176-243) are port candidates into the adapter when foreign-PDF breadth lands; engine extraction itself is REJECTED for the live read path (5A PDF-C: bootstrap-not-query semantics, EXIT_EXISTING_STATE, PNG side effects, 8-field lossy schema).

### 5.3 DOCX — hand-rolled comments.xml adapter in main; SuperDoc stays rejected

Adopts REVIEW.md Capability §2 / 5A recommendation (ii); v1 scope is **flat comments** — no replies, no resolution, the same line python-docx 1.2.0 drew for itself (5A DOCX-B).

- **Module:** `main/docx-comments.ts` implementing the adapter, on one new small zip dependency — mammoth uses a zip internally but exposes no zip API (package.json:69 lists only mammoth). PROPOSED DEFAULT — owner may override at GATE 2: **jszip** (read/write file-level API, mainstream); fflate acceptable if footprint wins.
- **READ (M):** unzip → parse `word/comments.xml` (+ `commentsExtended` ignored in v1) → locate `commentRangeStart/End` markers in `document.xml` → emit `CommentV2` with `origin: 'native-docx'`, `native = { comment_id: w:id, author, created }`, `anchor = text-quote` built from the enclosed runs' text with prefix/suffix context (the §3.1 PROPOSED-DEFAULT anchor decision).
- **WRITE (M):** mint `w:id`; append `w:comment` to comments.xml, **creating the part + content-types + .rels registration when the document has no comments yet**; insert range markers in document.xml, **splitting runs** when the anchor starts/ends mid-run (the contiguous-runs rule, C14 ✓); resolve the anchor position by TextQuoteSelector scan over concatenated run text (same `fuzzyMatchAnchor` core). Body text bytes are never altered — only marker elements are inserted (the §2 charter amendment).
- **EDIT / DELETE (S, same module):** comment-text swap in comments.xml / comment + marker removal.
- **DISPLAY (S, independent, can ship any time):** add mammoth's `comment-reference` style mapping so native comment positions appear in the iframe (today's `convertToHtml` passes `{ styleMap: ['u => em'] }` only — docx-viewer.ts:44-46 per 5A).
- **Hedge (kill path for spike S-3, §8):** python-docx write-only via the engine, wrapped exactly like pdfHealth (engine.ts:264-288 template) — a hedge, not the plan, because it cannot read the anchored range and splits the adapter across two languages (5A DOCX-B judgement).
- **SuperDoc stays rejected — on NEW grounds, recorded here as the standing rationale:** the 2026-05-16 file-format rationale ("neither of which is DOCX") is obsolete now that DOCX is a charter requirement; the rejection now rests on architecture — SuperDoc is a ProseMirror+Yjs editor with its own comment store and sidebar UI, and embedding it means a parallel comment store synced to the drafts sidecar, its DOM/theming, and its OOXML interop history (issue #752 class), for one of four formats, against the one-model-one-card-stream centerpiece (5A DOCX-C). **Recorded revisit trigger:** if requirements grow to threaded replies + resolution + tracked changes on DOCX, hand-rolling commentsExtended is where DOCX-A's cost curve crosses SuperDoc's — redo the 5A analysis then.

### 5.4 MD — the degenerate adapter (sidecar IS the store)

`capabilities = { readNative: false, writeNative: false, editNative: false, deleteNative: false, replies: false, bodyEditable: true }`. The existing fuzzy-snippet model folds into the union as the `text-quote` kind verbatim (`MdAnchor` is field-for-field the union member — shared/md/anchors.ts:1-7; 5B A5), and `MdAnchor`'s duplicate inline definition in types.ts (REVIEW.md Pass-4B "defined twice with no link") collapses to the single shared/comments.ts shape.

Prerequisites that ride this spec (both from the verified Pass-4B fuzzy-re-anchoring finding; roadmap X12):

1. `fuzzyMatchAnchor` steps 3–4 verify the candidate slice before returning (similarity threshold; downgrade to `orphaned` on failure); prefer the occurrence nearest `char_start`; export `CONTEXT_CHARS`.
2. Provenance immutability: relocations go to `anchor.relocated` (§3.1), never overwriting `quoted_text/prefix/suffix` — the current `syncMdAnchorsToComments` rewrite-in-place behavior (renderer/index.ts:1775-1781) is replaced, not migrated.

CodeMirror's `anchorField` position-mapping (md-viewer.ts:42-57) stays the live-tracking mechanism (Pass-4B reusability verdict). The C7 frontmatter-loss fix is a standalone bug fix sequenced by the roadmap (N1); it is named here only because frontmatter feeds `DocFingerprint.title_from_frontmatter`, which v2 keeps.

### 5.5 HTML — read-only + comments, no native round-trip

`capabilities = { readNative: false, writeNative: false, editNative: false, deleteNative: false, replies: false, bodyEditable: false }` (charter: HTML is read-only viewing + comments; no native comment format exists). Comments anchor by `text-quote` over the iframe's extracted linear text (truth), with `html-selector-hint` kept as the locality hint (§3.1) — the Pass-4B verdict that the shipped selector/charOffset capture is "lossy by construction" stands; capture is rebuilt on the md strategy inside the `IframeDocViewer` consolidation (REVIEW.md "html-viewer and docx-viewer are ~60% verbatim twins"; roadmap X11), which also serves the DOCX display path. Migrated v1 hint-only anchors (§3.3) get a true text-quote captured lazily on next successful resolution.

### 5.6 Adapter summary table

| Format | readNative | writeNative | edit/delete | replies | Anchor kind(s) | New code | Rests on |
|---|---|---|---|---|---|---|---|
| PDF | pdf.js `getAnnotations` in renderPage | pdf-lib `pdf-comments.ts` (Highlight + StrikeOut + Text) | by /NM, else (page,annot) handle | spike S-1 (both halves) | pdf-quad (+quads) | S–M read, M write | REVIEW.md Cap §1; 5A (i); spike artifacts |
| DOCX | comments.xml + range markers | comments.xml + marker insertion, run-splitting | S, same module | v1: no | text-quote (native_ref = w:id) | M read, M write | REVIEW.md Cap §2; 5A (ii); C14 |
| MD | n/a (sidecar is store) | n/a | n/a | n/a | text-quote | guard + provenance fixes (S–M) | Pass 4B findings; 5B A5 |
| HTML | n/a | n/a | n/a | n/a | text-quote + selector hint | rides IframeDocViewer consolidation | Pass 4B; charter |

Transport (all formats): promote/sling/watch/match unchanged (5B A7); bundle generalizes per §4.2; `new_anchor` re-types per §4.3.

## 6. Status-vocabulary unification

The three vocabularies, re-verified in Phase B: engine `Status`, 9 values (state.py:173-183); desktop `CommentStatus`, 7 values (types.ts:110-117); rig `ResultEntryStatus`, 5 values, a declared subset of CommentStatus (types.ts:227-235 comment "narrower than CommentStatus").

**Scope correction (challenge issue 14, announced here so it cannot re-propagate):** REVIEW.md's Exec Summary and Capability takeaway say the three vocabularies "share zero strings"; the underlying grep proves that only for engine↔desktop. The rig enum is a declared strict SUBSET of the desktop enum — desktop and rig share all 5 rig strings (`applied`, `rejected`, `deferred`, `needs-followup`, `build_failed`). The zero-overlap problem and the near-miss names (`needs_review` vs `needs-followup`) are an engine↔desktop seam problem, which is exactly where this section puts the mapping.

**Architecture of the resolution (PROPOSED DEFAULT — owner may override at GATE 2):** the unified vocabulary is the **desktop `CommentStatus`, unchanged** — no merged super-enum. Engine statuses are a different *kind* of thing (per-annotation workflow state inside the apply/build loop) and are **mapped at the engine↔desktop seam** (§7), with the engine-native status preserved losslessly in an optional `workflow.engine_status` passthrough field so every fold below is reversible. Rationale: merging would force the 9-value engine workflow grammar into every drafts sidecar that will never touch the engine (today: all of them — the two worlds share a directory but not one file, 5B F1), and the near-miss collision (`needs_review`/`needs-followup`) is *eliminated* rather than adjudicated when the engine string never enters the desktop enum.

**The normative mapping table.** The `?` cells from the GATE 1 packet get PROPOSED DEFAULTS, marked. (This table is the single source — the contradictory draft default that mapped `needs_review` toward a "`build-failed` family" was withdrawn at challenge; see B4 dispositions 1–2.)

| Unified (= desktop CommentStatus, types.ts:110-117) | Engine Status (state.py:173-183) | Rig ResultEntryStatus (types.ts:230-235) | Notes |
|---|---|---|---|
| `open` | `pending` | — (app-side only, per types.ts:228-229) | |
| `open` + `engagement_level: 'surface'` | `surfaced_pending` | — | **PROPOSED DEFAULT — owner may override at GATE 2.** `surfaced_pending` is "flagged for surface discussion, not yet held" — the desktop already expresses exactly this as an engagement level, not a status (`EngagementLevel = 'comment'\|'redraft'\|'surface'`, types.ts:105). Mapping it to a status would invent an 8th value for a concept the model already carries orthogonally. |
| `submitted` | — (no engine notion) | — (app-side only) | |
| `applied` | `applied`, `accepted`, `redrafted` | `applied` | **PROPOSED DEFAULT — owner may override at GATE 2** for the `accepted`/`redrafted` fold: all three are "an edit landed in the source"; the distinctions (ratified vs auto-applied vs redrafted-then-applied) are workflow history, preserved losslessly in `workflow.engine_status` and the engine's own `AnnotationState` fields (`before_text/proposed_text/applied_text`, state.py:309-320 per 5B A2). |
| `rejected` | `rejected` | `rejected` | |
| `deferred` | `deferred` | `deferred` | Same string, independently defined today — table makes the identity explicit. |
| `needs-followup` | — **deliberately unmapped** | `needs-followup` | **PROPOSED DEFAULT — owner may override at GATE 2.** Rig `needs-followup` is a *disposition* ("redirect-to-L3 advice", types.ts:247). Engine `needs_review` does NOT map here — see next row. This row closes the F1 collision by fiat: the two near-miss names denote different things and never alias. |
| — (not a unified status) | `needs_review` | — | **PROPOSED DEFAULT — owner may override at GATE 2.** Engine `needs_review` is mapping-confidence/apply-failure workflow ("low-confidence mappings" bucket, design spec §3.2 table; "apply-failure flow" per Capability finding 4). In the unified model it surfaces as `workflow.engine_status: 'needs_review'` plus the existing orphan/confidence machinery on the anchor (`fuzzyMatchAnchor`'s `'orphaned'` confidence) — a property of the *anchor resolution*, not a disposition, and NOT desktop `build_failed` (which is the rig's build outcome, types.ts:247-249). |
| `build_failed` | — (engine models this as `failure_log_path` on AnnotationState, state.py:319, not a status) | `build_failed` | Lexical note below. |
| `resolved` — **not added** | `surfaced_resolved` | — | **PROPOSED DEFAULT — owner may override at GATE 2.** `surfaced_resolved` ("surface discussion held") folds to unified `applied` when an edit resulted, `rejected` when explicitly declined, else stays engine-side as `workflow.engine_status: 'surfaced_resolved'` with unified `deferred`. Adding a unified `resolved` value (the 5B sketch's tentative 8th row) is declined to keep the rig subset-relationship (types.ts:228-229) intact; revisit if surface workflows start round-tripping through the desktop. |

**Lexical convention (PROPOSED DEFAULT — owner may override at GATE 2):** the unified enum keeps its shipped spellings verbatim — including the inconsistent `build_failed` (underscore) amid hyphenated values — because every sidecar, submit file, and results file on disk already uses them and the rig writes them (types.ts:230-235); a cosmetic respelling would be a third schema migration with zero behavior gain. Normalize only if/when a v3 bump happens for other reasons.

No code is written against this table until GATE 2 opens; the table itself is the deliverable the GATE 1 packet asked Phase B to finish.

## 7. Engine/desktop boundary: bridge, don't adopt

**Decision (PROPOSED DEFAULT — owner may override at GATE 2):** the engine's `annotations.json`/`state.json` world does **not** adopt the TS union as its native schema. It keeps its own Python schema, bumped to **annotations.json/state.json schema-v2** with exactly the round-trip fields Pass 2 proved missing, and meets the unified model through a **mapping bridge at the adapter seam** (the same seam the desktop already crosses via `runEngine`/pdfHealth, engine.ts:264-288).

Grounded rationale:

1. **Cross-language schema mirroring is a demonstrated failure mode in this repo.** The hand-mirrored `EngineResult`/`PdfHealthReport` twins behind a false "re-exported" comment have already drifted (REVIEW.md "The hand-wired typed IPC surface is vacuous", engine.ts:21-68/237-253 vs types.ts:4-80). Making Python dataclasses track a TS discriminated union wholesale would institutionalize that failure mode across the project's least-typed boundary.
2. **The engine's schema layer is not ready to carry anyone's v2.** The state.py dataclasses are write-only with three live drifts against the raw-dict mutators (REVIEW.md "Half-adopted typed layer"), and the schema-version guard is bypassed by every mutator and uncaught by the CLI (C3 ✓). Fixing C3 + the dataclass-direction decision are **hard prerequisites** to ANY engine schema bump (roadmap L1→L2) — adopting the union would couple the desktop's schedule to that cleanup; bridging decouples them.
3. **The engine's reusable asset is its workflow machine, not its record shape.** The `(status, action)` transition table and id-addressed mutators are format-free and carry over (5B A2); the persisted `Annotation` record is the lossy part (8 fields, no subtype/native-id/replies — state.py:192-199 per Pass 2). The bridge keeps the good half in service.
4. **The engine is not on the live multi-format path.** PDF read/write happens desktop-side (§5.2; 5A rejects PDF-C for the live path); the engine remains the LaTeX-project pipeline (spec §3.2 decision) plus a possible python-docx write hedge (§5.3) — both subprocess seams where a JSON mapping at the boundary is the natural contract.

**Engine schema-v2 contents (rides whenever the engine next bumps, NOT a Phase-B blocker; roadmap L2):** persist `subtype`, native annotation id, and optional `in_reply_to` in annotations.json (Pass-2 reusability note: "as persisted, extraction cannot even distinguish a Highlight from a StrikeOut"); rename `latex_file` → `file`; statuses unchanged (the §6 mapping handles them). Prerequisites stated by Phase A and restated here as binding: C3 fix first (route mutating reads through `state.read_json`, CLI catches both schema exceptions); the migrate.py registry gains its first real migration.

**Bridge mechanics:** engine annotations import to the unified model as `CommentV2 { origin: 'engine-extract', native: { comment_id: <engine annotation id>, subtype? }, anchor: pdf-quad from bbox, status: §6 table, workflow: { engine_status, before_text?, proposed_text?, applied_text? } }`. Direction is one-way (engine → unified) until a concrete use case needs write-back into engine state; none is identified in Phase A.

**Interaction with keep-vs-kill (owner decision OD-2, still open):** nothing in this spec depends on the legacy HTTP viewer surviving. The one engine asset this spec's direction wants regardless is the flock-disciplined event bus extraction (`events.py`, REVIEW.md "Keep-vs-kill: split the format-agnostic event bus"; roadmap L7) — a compatible-but-independent workstream, not a dependency.

## 8. Open spikes and kill criteria

Each spike is time-boxed at 1 day, has a binary kill criterion, and ships its result as a dated research note (house pattern: `docs/research/2026-05-21-pdf-lib-annotation-spike/`). All were flagged feasible-unproven in the GATE 1 packet UNCERTAIN list; none may be skipped by assuming success.

**S-1 — PDF /IRT reply chains, READ and WRITE halves (roadmap N7).**
Scope (widened per challenge issue 3 — the 2026-05-21 spike did NOT exercise /IRT, the readback field set has no reply parent, and a fresh grep over readback.json + spike.mjs found zero /IRT hits — so even read-only display is unproven):
(a) READ: on an Acrobat-authored threaded PDF, confirm /IRT chains are extractable via pdf.js `getAnnotations` or a pdf-lib walk.
(b) WRITE: with pdf-lib, write a Text annotation carrying /IRT pointing at an existing Highlight; round-trip through Acrobat and confirm the chain displays as a reply and survives a re-save (PDF 1.7 §12.5.2 territory).
Kill ladder: write half fails within the day → **v1 ships replies read-only** (display `native.in_reply_to` threads in the card stream; no reply write-back), `capabilities.replies = false` on the PDF adapter. Read half ALSO fails → **replies are out of v1 entirely** — no read-only display either; `native.in_reply_to` stays an optional schema field populated only when readable; a bead records the retry condition.

**S-2 — per-line quads write-back (roadmap N8).**
Scope: upgrade the writer from single-bbox /QuadPoints to per-line quads using the capture side's existing `screenRects` (pdf-viewer.ts:60; merge logic :447-463); verify Acrobat renders multi-quad highlights correctly, including on a restored/degraded PDF (domain trap #8 class).
Kill criterion: if Acrobat rendering is misaligned on the restored-PDF case within the day → keep single-bbox **writes**, but the model still stores `quads[]` (reads are unaffected — readback.json proves natives carry them); file a bead for the writer upgrade.

**S-3 — DOCX range-marker insertion with run-splitting.**
Scope: on a Word-authored .docx with no existing comments, insert one comment whose anchor starts mid-run: create comments.xml + content-types + .rels, split the run, insert `commentRangeStart/End` + reference; open in Word and confirm the comment displays anchored, and the document body is textually unchanged.
Kill criterion: if Word rejects the file or the marker/rels bookkeeping isn't tamed within the day → activate the recorded hedge (5A (ii)): **python-docx write-only via the engine**, wrapped on the pdfHealth template (engine.ts:264-288), with desktop-side read still hand-rolled (python-docx cannot read the anchored range); reassess hand-rolled write after v1.

Sequencing note: S-1/S-2 gate only their specific features (replies; multi-quad writes) — the PDF adapter's core (read/display, Highlight/StrikeOut/Text create, edit, delete) does not wait on them. S-3 gates the DOCX write milestone's approach, not its existence.

## 9. Decision log

| # | Decision | Status | Rests on |
|---|---|---|---|
| D1 | Per-comment discriminated anchor union (M-2) with `quads[]`, `origin`, `native_ref`; M-1 accretion rejected | The union's necessity is settled by verified findings (C5, C6, C12; 5A §iii). Its designation as the Phase-B centerpiece is **PROPOSED DEFAULT — owner may override at GATE 2** — the GATE-1 packet checklist box ("Confirm you accept the M-2 union…") is unchecked; no artifact records that confirmation (challenge issue 6) | REVIEW.md Cap §3 |
| D2 | Three-party rollout order: sidecar v2 (+ v2-results tolerance + down-converter) → rig reader/writer → desktop submit-writer flip gated on an OBSERVED `schema_version: 2` rig results file; bare `{page,region}` parsed as pdf-quad forever | Settled mechanics (forced by file-reader topology); the no-handshake choice incl. the manual observed-results gate is **PROPOSED DEFAULT — owner may override at GATE 2** | §4.4; C12; 5B F3; challenge issues 4, 10, 11 |
| D3 | DOCX anchors are `text-quote` over run text; OOXML range markers are the native projection (`native_ref`), not an anchor kind | **PROPOSED DEFAULT — owner may override at GATE 2** (closes the GATE-1 UNCERTAIN "docx-range vs text-fuzzy") | §3.1 rule 4; Pass 4B; 5A (ii) |
| D4 | Unified status vocabulary = desktop `CommentStatus` unchanged; engine statuses mapped at the seam, preserved in `workflow.engine_status` | **PROPOSED DEFAULT — owner may override at GATE 2** | §6; 5B F1 |
| D5 | `needs_review` ≠ `needs-followup` ≠ `build_failed`: engine `needs_review` is anchor-resolution workflow, never a unified disposition and never the rig's build outcome | **PROPOSED DEFAULT — owner may override at GATE 2** (closes a GATE-1 `?` cell; supersedes the withdrawn draft default per B4 disposition 1) | §6 table; Cap §4; types.ts:247-249 |
| D6 | `accepted`/`redrafted` fold into unified `applied` (lossless via `workflow.engine_status`); `surfaced_pending` maps to `open` + `engagement_level:'surface'`; no unified `resolved` value | **PROPOSED DEFAULT — owner may override at GATE 2** (closes the remaining GATE-1 `?` cells) | §6 table; types.ts:105; 5B §3.3 |
| D7 | Engine bridges to the unified model; does not adopt the union. Engine schema-v2 (subtype/native-id/in_reply_to) rides the engine's own next bump, gated on the C3 fix | **PROPOSED DEFAULT — owner may override at GATE 2** | §7; C3; REVIEW.md typed-IPC drift finding |
| D8 | PDF: pdf.js reads / pdf-lib writes (split-library); engine extraction rejected for the live path | Settled by 5A options analysis (all three options evidenced); restated normatively | §5.2; 5A (i) |
| D9 | DOCX: hand-rolled jszip/OOXML adapter, v1 flat comments; SuperDoc rejection re-grounded on architecture with a recorded revisit trigger; jszip-vs-fflate is **PROPOSED DEFAULT (jszip) — owner may override at GATE 2** | Settled approach per 5A (ii); dep choice proposed | §5.3; 5A DOCX-A/B/C |
| D10 | Replies (PDF /IRT, read AND write), multi-quad writes, and DOCX marker insertion ship only behind spikes S-1/S-2/S-3 with the stated kill ladders | Settled (feasibility was flagged unproven in the GATE 1 packet; spiking is the mitigation; S-1 scope widened per challenge issue 3) | §8; 5A (i)/(ii) |
| D11 | Keep shipped status spellings verbatim (incl. `build_failed`); keep `bundle_pdf/bundle_json` as deprecated aliases through the transition | **PROPOSED DEFAULT — owner may override at GATE 2** | §6 lexical note; §4.2 |

## 10. Acceptance criteria (for the GATE-2 implementation beads to be filed from)

1. A v1 sidecar of each of the FIVE real row shapes (pdf, md, smuggled-html, `new_anchor`-bearing, `pdf_annotation_id`-bearing) opens, migrates in memory, and round-trips to a valid v2 file; vitest covers all five + a v2 passthrough (§3.3).
2. `writeBundle`/`pdf-comments.ts` refuses non-`pdf-quad` anchors and never re-emits `origin: 'native-pdf'` comments as new annotations; a PDF carrying foreign Acrobat annotations displays them as cards and survives edit→save→re-open in Acrobat with /NM stamped (§5.2).
3. A Word-authored .docx round-trips: native comments appear as cards; an app-created comment appears anchored in Word; body text bytes unchanged except marker elements (§5.3, post-S-3).
4. Every status crossing the engine seam maps per the §6 table with `workflow.engine_status` preserved; grep finds no engine status string in desktop code outside the mapping module.
5. v1 AND v2 results files (and both `new_anchor` shapes) are readable from rollout step 1 onward; v1 stays readable at every step; the results watcher is diff-identical (§4; challenge issue 4).
6. During the transition window the v2→v1 SubmitFile down-converter emits a valid v1 file for PDF rounds (`pdf-quad` → `{page, region}`, quads dropped) (§4.4 step 1; challenge issue 11).
7. The step-3 submit-writer flip is recorded in a bead citing the observed rig-written `schema_version: 2` results file that satisfied its gate (§4.4; challenge issue 10).
8. Spikes S-1/S-2/S-3 each have a dated research note with a PASS or KILL outcome (for S-1: per half) before their gated features are filed as beads (§8).
