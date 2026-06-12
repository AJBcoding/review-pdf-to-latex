# Pass 6 — Claim Verification Results (2026-06-12)

14 highest-impact claims selected per run-plan step 2 (biased toward Phase-B-driving claims and
suspicious citations); one independent read-only verifier per claim re-opened every cited line /
re-ran every cited command. Verdicts below are the verifiers' returns, recorded verbatim by the
synthesizer (run-plan step 4: verifiers return lines; the synthesizer is the only file writer).

## Tally

| Verdict | Count |
|---|---|
| CONFIRMED | 14 |
| WRONG | 0 |
| UNVERIFIABLE | 0 |
| **Total** | **14** |

**14/14 CONFIRMED.** No REVIEW.md findings deleted or downgraded; every verified claim is marked
with a trailing ✓ in REVIEW.md. Two text updates made on the strength of verifier evidence:
the C2 "uncited git-behavior link" flag is resolved (verifier reproduced it on git 2.50.1), and
the C13 open flag (carried unverified since Pass 3) is closed as a confirmed bug with the
verifier's agent-pane-ipc.ts evidence.

## Per-claim results

### C1 — CONFIRMED — apply.py:302-303 writes the .tex, validate_status_transition+IllegalStatusTransitionError at :336-338 precede atomic_write_json(state/mapping) at :341-342; grep of state.py shows "apply" keys only at :496-501 (pending/applied/rejected/redrafted/needs_review/surfaced_pending) — no accepted/deferred/surfaced_resolved.

- CLAIM: In `apply_edit`, the .tex file is rewritten at apply.py:300–305 (`tex_path.open("w")` + `writelines`), but `validate_status_transition(current_status, "applied", "apply")` runs only afterwards at apply.py:334–338, raising `IllegalStatusTransitionError` before the state.json/mapping.json writes at apply.py:341–342. The transition table has no `("accepted", "apply")`, `("deferred", "apply")`, or `("surfaced_resolved", "apply")` keys (state.py:496–501)
- CITATION: apply.py:300–305; apply.py:334–338; apply.py:341–342; state.py:496–501

### C2 — CONFIRMED — All citations exact (extract.py:945 gitignores .review-state/; commit.py:307-314 stages the 4 state files; :316-327 git add no -f, raises CommitFailedError=exit 19 per commit.py:33); repro on git 2.50.1: git add of named ignored paths exits 1 with "Use -f if you really want to add them", so commit-phase fails with exit 19 on extract-bootstrapped projects.

- CLAIM: `commit_phase` then stages `state.json`, `mapping.json`, `annotations.json`, and `state-events.jsonl` from under `.review-state/` (commit.py:307–314) via `git add -- <paths>` with no `-f` (commit.py:316–327), raising `CommitFailedError` (exit 19) on nonzero return. [...] `git add` on explicitly-named untracked ignored paths exits nonzero ("Use -f if you really want to add them"), so on any real project bootstrapped by `review-pdf extract`, `commit-phase` should fail with exit 19 [...] (The git behavior claim is the one uncited link — flagged for a Pass-6 verifier or quick repro.)
- CITATION: extract.py:945; extract.py:743–746; commit.py:307–314; commit.py:316–327; git-add-ignored-path behavior UNCITED — verify by repro (now reproduced, see verdict note)

### C3 — CONFIRMED — apply.py:121-123 is bare-json.load _read_json; all 7 cited call sites (148, 584, 646-647, 699, 730, 766, 803) are in mutator functions and are apply.py's only json.load sites; commit.py:227/282 are bare json.load; the grep over cli.py+tests/test_cli.py returned nothing (exit 1) while both exceptions exist at state.py:111/120.

- CLAIM: apply.py defines its own unguarded reader (apply.py:121-123, bare `json.load`) used for every mutation-path read (apply.py:148, 584, 646-647, 699, 730, 766, 803); commit.py uses bare `json.load` at commit.py:227 and 282 [...] `grep -n 'SchemaVersionError\|MigrationRequiredError' src/review_pdf_to_latex/cli.py tests/test_cli.py` returns NOTHING — no CLI handler catches either exception
- CITATION: apply.py:121-123; apply.py:148, 584, 646-647, 699, 730, 766, 803; commit.py:227, 282; grep -n 'SchemaVersionError\|MigrationRequiredError' src/review_pdf_to_latex/cli.py tests/test_cli.py

### C4 — CONFIRMED — server.py defines only do_GET (:265) and do_POST (:288); both greps empty (exit 1); frame.html:675 falls back to tag="" so the :676 reload condition can never trigger, exactly as the :462-465 loop comments expect.

- CLAIM: server.py implements only `do_GET` (server.py:265) and `do_POST` (server.py:288); `grep -rn 'do_HEAD' src/ tests/` returns no hits, and `grep -rn 'Last-Modified\|ETag\|etag' src/review_pdf_to_latex/server.py tests/test_server.py` returns nothing. [...] The tag is permanently `""`, so the page never auto-reloads — the click→engine→reload loop the in-page comments describe (frame.html:462-465) cannot fire
- CITATION: server.py:265; server.py:288; templates/frame.html:666-679; grep -rn 'do_HEAD' src/ tests/; grep -rn 'Last-Modified\|ETag\|etag' src/review_pdf_to_latex/server.py tests/test_server.py

### C5 — CONFIRMED — bundle.ts:67 reads comment.anchor.region and :203 c.anchor.page with zero anchor_kind/md_anchor checks in the file (grep exit 1); types.ts:130 anchor:AnchorRegion is required, :121-124 = page+x/y/w/h, :159-165 md_anchor? optional, :170 AnchorKind union, :190 anchor_kind? on DraftsFile — all exact.

- CLAIM: `buildHighlight` reads `comment.anchor.region` with no discriminator check (bundle.ts:67-68, re-verified this session), and page grouping reads `c.anchor.page` (bundle.ts:203-204, re-verified). The data model forces this: `CommentPayload.anchor: AnchorRegion` is a REQUIRED, PDF-shaped field (shared/types.ts:130, AnchorRegion = page + x/y/w/h at types.ts:121-124) on every comment in every format, while md comments carry their real anchor in the optional `md_anchor` field (types.ts:157-165) keyed off a file-level `anchor_kind` discriminator (types.ts:168-170, 190)
- CITATION: bundle.ts:67-68, 203-204; shared/types.ts:130, 121-124, 157-165, 168-170, 190

### C6 — CONFIRMED — index.ts:2214-2223 shows md_anchor with selector/char_offset/char_length `as any` (schema at types.ts:159-165 lacks them); types.ts:170, html-viewer.ts:55, docx-viewer.ts:41 all verbatim as claimed.

- CLAIM: `buildHtmlCommentPayload` persists a hybrid object into the typed `md_anchor` field with extension fields the schema doesn't have, cast away: `md_anchor: { char_start: sel.charOffset, …, quoted_text: sel.text, selector: sel.selector, char_offset: sel.charOffset, char_length: sel.charLength } as any` (renderer/index.ts:2214-2223; function at :2198) [...] The declared discriminator has only two values — `export type AnchorKind = 'pdf-glyph-rect' | 'md-fuzzy-snippet';` (shared/types.ts:170, re-verified verbatim) — and both iframe viewers report the md kind for selector anchors: `get anchorKind(): AnchorKind { return 'md-fuzzy-snippet'; }` (html-viewer.ts:55; docx-viewer.ts:41)
- CITATION: renderer/index.ts:2214-2223, :2198; shared/types.ts:170; html-viewer.ts:55; docx-viewer.ts:41

### C7 — CONFIRMED — md-viewer.ts:120/123 mounts only parseFrontmatter body; :147 getContent returns editorView doc only; renderer/index.ts:192-197 flushMdSave writes getContent() straight to docState.path via writeFileText — all verbatim as claimed.

- CLAIM: `MarkdownViewer.loadBytes` strips frontmatter before mounting the editor — `const { frontmatter, body, bodyOffset } = parseFrontmatter(text); … this.mountEditor(body);` (md-viewer.ts:118-124, re-verified verbatim this session) — and `getContent()` returns only the editor doc: `return this.editorView?.state.doc.toString() ?? '';` (md-viewer.ts:146-148, re-verified). The save path writes that body-only string straight to the source file: `flushMdSave` does `const content = mdViewerRef.getContent();` then `await window.electronAPI.writeFileText(docState.path, content)` (renderer/index.ts:192-197)
- CITATION: md-viewer.ts:118-124; md-viewer.ts:146-148; renderer/index.ts:192-197

### C8 — CONFIRMED — All four citations exact: wholesale DraftsFile write at :2954-2959 inside seedNextVersionDraft; sole seeded-flag guard at :2677 (within :2674-2679); `seeded: prev?.seeded ?? false` at :2665 (within :2660-2667); `docState.rounds = new Map();` verbatim at :1261/:1402/:1531/:1618 in doc-load reset blocks.

- CLAIM: `seedNextVersionDraft` writes the v1.1 drafts file wholesale — `const file: DraftsFile = { schema_version: 1, doc_version: newSha, comments: reraised }` then `writeDrafts(newDocId, newSha, file)` (renderer/index.ts:2954-2959, re-verified verbatim) [...] The only guard is the in-memory `seeded` flag (2674-2679), which defaults to false whenever the round isn't already in the map (`seeded: prev?.seeded ?? false`, 2660-2667, re-verified verbatim) and lives in `docState.rounds`, rebuilt to `new Map()` on every doc load (1261, 1402, 1531, 1618)
- CITATION: renderer/index.ts:2954-2959; renderer/index.ts:2674-2679; renderer/index.ts:2660-2667; renderer/index.ts:1261, 1402, 1531, 1618

### C9 — CONFIRMED — submit.ts:323 has the exact .abandoned.json rename inside abandonRound (:310); results-watcher.ts:44 regex /^results-.+\.json$/ tests true against 'results-x.abandoned.json' (node-verified); re-run grep for 'abandoned' hits only submit.ts/renderer/index.ts/shared/types.ts — zero in results-watcher.ts.

- CLAIM: `abandonRound` renames a results file to the `.abandoned.json` soft tombstone — submit.ts:323 `const renamedTo = resolvedPath.replace(/\.json$/, '.abandoned.json');` (re-verified this session). The watcher's match regex still matches that tombstone name — results-watcher.ts:44 `const RESULTS_RE = /^results-.+\.json$/;` (re-verified; `results-x.abandoned.json` matches). Nothing in results-watcher.ts checks the `.abandoned` suffix (verbatim: `grep -rn 'abandoned' desktop/main desktop/renderer desktop/shared --include='*.ts'` → hits only in submit.ts, renderer/index.ts, shared/types.ts — zero in results-watcher.ts)
- CITATION: desktop/main/submit.ts:323; desktop/main/results-watcher.ts:44; grep -rn 'abandoned' desktop/main desktop/renderer desktop/shared --include='*.ts'

### C10 — CONFIRMED — All six citations exact verbatim: Re-sling→retrySling (submit.ts:424, in the timeout banner branch :407), event dispatch (:453-455), sole listener→handleSubmitBundle (index.ts:362-364, grep-confirmed only listener), in-flight flash guard (:1093-1095), 'timeout' absent from canFire (:716-721) and present in isInFlight (:136-140); minor imprecision only — the flash is the second guard (a doc-open check at :1086-1089 precedes it), which doesn't break the no-op chain.

- CLAIM: Timeout "Re-sling" is a guaranteed no-op: the banner button calls `retrySling()` (submit.ts:424), which dispatches `submit:retry-requested` (453-455); index.ts's only listener re-runs `handleSubmitBundle()` (renderer/index.ts:362-364), whose first guard flashes "Submit already in flight." (1093-1095) — and in the `timeout` state `canFire()` is false (`timeout` absent from submit.ts:716-721, re-verified verbatim) while `isInFlight()` is true (`timeout` included, submit.ts:136-140, re-verified verbatim)
- CITATION: renderer/submit.ts:424, 453-455, 716-721, 136-140; renderer/index.ts:362-364, 1093-1095

### C11 — CONFIRMED — claude-pty.ts:219-220 and :526-527 contain the exact skipPerms-defaults-true lines; claude-backend.ts:160-161 has permissionMode:"default"+canUseTool (interactive permissionRequest flow at :113-139); query() options :157-166 list only the five claimed keys and grep finds zero 'cwd' in claude-backend.ts (the only other query(), :276, is the AGENT_VIEWER_SMOKE debug one-shot, not the session route).

- CLAIM: the pty route defaults to `--dangerously-skip-permissions` (claude-pty.ts:219-220 `const skipPerms = params.dangerouslySkipPermissions !== false;`, again at :526-527); the SDK route hardcodes `permissionMode: "default"` with an interactive `canUseTool` approve/deny flow (claude-backend.ts:160-161, re-verified this session) [...] the SDK route never sets cwd — `query()` options (claude-backend.ts:157-166) contain only `permissionMode`, `canUseTool`, `includePartialMessages`, `resume`, `model` — SDK sessions run in the Electron process cwd
- CITATION: desktop/main/claude-pty.ts:219-220, :526-527; desktop/main/claude-backend.ts:160-161, 157-166

### C12 — CONFIRMED — types.ts:245 and :150 both read `new_anchor?: AnchorRegion | null;` (in ResultEntry/CommentPayload); :147-149 doc says verbatim "Set by the rig when an `applied` redraft moved the underlying text"; AnchorRegion (types.ts:121-124) is {page, region:{x,y,w,h}}; renderer/index.ts:2398 consumes it in reveal (`const revealAnchor = c.new_anchor ?? c.anchor;`).

- CLAIM: `ResultEntry.new_anchor?: AnchorRegion | null` (types.ts:245) and `CommentPayload.new_anchor?: AnchorRegion | null` (types.ts:150) — both relocation fields are hard-typed to the PDF page+rect shape, written by the RIG ("Set by the rig when an `applied` redraft moved the underlying text", types.ts:147-149) and consumed by the renderer's reveal path (Pass 4C)
- CITATION: desktop/shared/types.ts:245; desktop/shared/types.ts:150; desktop/shared/types.ts:147-149

### C13 — CONFIRMED — main/index.ts:808 passes the first window into registerAgentPaneIpc; :810-812 activate handler calls createWindow() with no re-registration; agent-pane-ipc.ts:24/27-28/114 show a module-level mainWindowRef whose isDestroyed() guard silently drops all agent:event pushes to any re-created window.

- CLAIM: Open flag from 3A, unverified this pass: `registerAgentPaneIpc(mainWin)` binds the FIRST window while `app.on('activate')` creates fresh windows with no re-registration (main/index.ts:808-812) — verify event delivery after window re-creation (Pass 4/6)
- CITATION: desktop/main/index.ts:808-812
- DISPOSITION: the Pass-3 open flag (carried through Passes 3→4→5 unverified) is now CLOSED as a
  confirmed bug — on macOS, closing the window and reactivating the app yields a window whose
  agent pane never receives `agent:event` pushes (silently dropped by the destroyed-window guard).
  REVIEW.md's flag line updated accordingly.

### C14 — CONFIRMED — Re-fetched python-docx.readthedocs.io/en/latest/user/comments.html: verbatim "stored in a separate comments-part (part-name word/comments.xml)", start/end range markers (w:commentRangeStart/End) in the document body positioned around runs, and "a range must enclose _contiguous_ runs" — all three quotes exact; the CREATE/DELETE-mutates-document.xml consequence follows directly and is labeled as inference.

- CLAIM: comment content lives in `word/comments.xml`; the ANCHOR is range markers in document.xml, and ranges "must enclose _contiguous_ runs". CONSEQUENCE the charter wording glosses: CREATE/DELETE of an anchored comment must insert/remove range-marker elements in document.xml — body TEXT stays untouched but the part is mutated
- CITATION: python-docx 1.2.0 user docs, fetched by 5A (web citation — no in-repo line; re-verified against python-docx.readthedocs.io this session)
