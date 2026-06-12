# Review Progress Log

## Pass 1 — Inventory & Plan (2026-06-12)

Gate check: GATES.md present; GATE 1 CLOSED, GATE 2 CLOSED. No proposal/roadmap/implementation work performed.

### Spot-check results (full transcripts in evidence/pass1/spot-checks.md)

- Engine LOC: CONFIRMED — 6,486 total, 14 files, every per-file number exact.
- Desktop key-file LOC (index.ts 2971 / types.ts 1008 / main/index.ts 826 / submit.ts 721 / bundle.ts 302): CONFIRMED exact.
- AnchorKind discriminator at shared/types.ts:168-170: CONFIRMED (the CSS-selector reuse detail is NOT on those lines — re-cite in Pass 4B).
- classifyPath if/else dispatch at renderer/index.ts:769-779: CONFIRMED.
- Duplicate AnnotationNotFoundError: CONFIRMED — apply.py:38 (map said :39, off by one) vs preview.py:158 exact.
- Tests: PARTIAL — Python 8,648 LOC exact and desktop 7 vitest files exact, but tests/*.py count is 22 (map's "20" excludes conftest.py and __init__.py).

Verdict: ground-truth map highly reliable; trust but re-open line citations before quoting.

### Lane partition validation (MECE vs real tree, node_modules/release/out excluded)

run-plan.md lanes are substantially MECE. Real-tree sweep found these files not named by
any lane; corrected assignment rules below (run-plan.md NOT edited, per instructions).
Final lane assignment rules — literal lane ids + path lists:

- 2A (Engine core pipeline): src/review_pdf_to_latex/{extract,apply,state,commit,migrate,status}.py
- 2B (Engine serve/build): src/review_pdf_to_latex/{server,terminal,build,preview,pdf_health}.py + src/review_pdf_to_latex/templates/ (incl. templates/static/ vendored xterm assets — note vendoring, don't review the vendor code)
- 2C (Engine CLI & cross-cutting): src/review_pdf_to_latex/{cli,__main__,__init__}.py, pyproject.toml, uv.lock, tests/ (coverage map only). ADDED vs run-plan: __init__.py (6 LOC) and uv.lock (root lockfile, named in ground-truth hygiene block).
- 3A (Desktop process/IPC backbone): desktop/main/{index,engine}.ts, desktop/preload/, desktop/shared/types.ts. ADDED vs run-plan: desktop build/config files — desktop/{package.json,package-lock.json,tsconfig.json,tsconfig.node.json,tsconfig.web.json,electron.vite.config.ts,vitest.config.ts} (no lane owned them; they are process/toolchain backbone).
- 3B (Claude/agent subsystem): desktop/main/{claude-pty,claude-backend,agent-pane-ipc,session-store}.ts, desktop/main/agent-pane-ipc.test.ts, desktop/shared/agent-pane/ (incl. adapter.test.ts and __fixtures__/).
- 3C (Persistence & submit pipeline): desktop/main/{submit,bundle,results-watcher,sidecar-migration}.ts, desktop/main/sidecar-migration.test.ts, plus drafts/appState handler BODIES in desktop/main/index.ts (3A owns registration/shape — overlap rule unchanged). ADDED vs run-plan: desktop/shared/bundle.ts (108 LOC; exists alongside main/bundle.ts, unnamed by any lane — belongs with the bundle pipeline).
- 4A (Renderer orchestration & chrome): desktop/renderer/index.ts structure/dispatch/state, desktop/renderer/{tree,toolbar,palette,splitter}.ts, desktop/renderer/styles.css (organization only). ADDED vs run-plan: desktop/renderer/index.html and desktop/renderer/vite-env.d.ts.
- 4B (Viewers & anchoring): desktop/renderer/{pdf-viewer,md-viewer,html-viewer,docx-viewer}.ts, desktop/shared/file-viewer.ts, desktop/shared/md/anchors.ts. ADDED vs run-plan: desktop/shared/md/anchors.test.ts.
- 4C (Comments, submit UX & panes): desktop/renderer/submit.ts, comment-card/submit spans of renderer/index.ts (4A owns structure — overlap rule unchanged), desktop/renderer/claude-pane.ts, desktop/renderer/agent-pane/ (incl. its .test.ts files, env.d.ts, styles.css, main.tsx, components/).
- 5A/5B (Capability): no exclusive file ownership; ADDED note — desktop/spikes/rev-cvr-pdf-lib/readback.json is prior-art evidence for the pdf-lib read-back option and was unowned by any lane; Pass 5 should cite it alongside docs/research/2026-05-21-pdf-lib-annotation-spike/.

No lane-overlap conflicts found beyond the two overlap rules already written in run-plan.md
(3A/3C on main/index.ts; 4A/4C on renderer/index.ts), which stand as written.

### Artifacts produced

- evidence/pass1/spot-checks.md (6 checks, verbatim commands + output)
- evidence/pass1/hotspots.md (18 ranked hotspots)
- REVIEW.md skeleton (12 exact headings from run-plan.md, placeholder bodies)

LAST COMPLETED PASS: 1

## Pass 2 — Python Engine (2026-06-12)

Gate check: GATES.md present; GATE 1 CLOSED, GATE 2 CLOSED. Review-only synthesis; no proposal/roadmap/implementation content written.

Lanes completed: 2A (core pipeline), 2B (serve/build surface), 2C (CLI, tests & cross-cutting) — all three lane files present and non-empty in evidence/pass2/. Synthesized into the three Engine sections of REVIEW.md (13 findings + per-section "also noted" tails + reusability notes), key-takeaways block at the top of "Engine — Core Pipeline".

Anomalies / synthesis decisions:
- Duplicate finding: the schema-version-guard bypass was independently found by 2A and 2C; consolidated under "Engine — CLI, Tests & Cross-Cutting" using 2C's more complete citations (adds server.py read sites and the missing CLI catcher), with a cross-reference from the Core Pipeline tail.
- 2A's commit_phase/.gitignore finding contains one explicitly uncited link (git's nonzero exit on adding ignored named paths) — lane flagged it for a Pass-6 verifier; preserved that flag in REVIEW.md.
- 2C corrected the ground-truth map's subcommand count: 17 on disk (cli.py:757-775), not 16.
- Merged 2A's two per-operation-cost findings (fuzzy_map rescan; per-mutator PDF hash) into one finding; folded 2B's wait-event same-second-drop bug into the event-bus extraction finding (the fix rides the same move); folded 2C's split-error-convention finding into the exit-code-contract finding.
- Cross-lane routing notes preserved for later passes: terminal.py duplicates desktop/main/claude-pty.ts (→ 3B); desktop/main/engine.ts:273 consumes exit codes as a bare numeric set (→ 3A).

LAST COMPLETED PASS: 2

## Pass 3 — Desktop Main + Shared (2026-06-12)

Gate check: GATES.md present; GATE 1 CLOSED, GATE 2 CLOSED. Review-only synthesis; no proposal/roadmap/implementation content written.

Lanes completed: 3A (process/IPC backbone), 3B (claude/agent subsystem), 3C (persistence & submit pipeline) — all three lane files present and non-empty in evidence/pass3/. Synthesized into the three Desktop Main sections of REVIEW.md (14 findings + per-section tails + two reusability notes + one capability note), key-takeaways block at the top of "Desktop Main — Process, IPC & Engine Bridge".

Anomalies / synthesis decisions:
- Merged 3A's two typed-IPC findings (EngineResult duplication + AgentViewerApi triplication) into one high finding — same root cause (hand-wired types, no result-side enforcement), and the agentViewer drift is the live proof for the EngineResult risk.
- Merged 3A's god-entry-file and double-before-quit findings (same file, same extraction work) and its three engine.ts findings (re-resolution, exit-code mirror, zero tests) into single findings; compressed 3A's API-residue finding (dead _sha256, pdf-only argv/index, readPdfBytes naming) into the section tail with citations intact.
- Merged 3B's zombie-session and unbounded-lazy-spawn findings (both session-registry hygiene, same files, both S) and its priming-duplication and setTimeout-race findings (one shared-priming-module fix).
- Anchor-model flaw found independently by 3A (types.ts structure: required PDF anchor, file-level anchor_kind) and 3C (bundle.ts consumes it blind): kept both halves in their own sections with explicit cross-references; the discriminated-union restructure is named once as the highest-leverage pre-work for the unified model.
- Atomic-write duplication consolidated across lanes: 3C's four sites + 3A's fifth (fs:writeFileText, main/index.ts:600-611) = 5 copies + 2 non-atomic outliers, one finding under Persistence.
- Citation correction during spot-check: 3B cited claude-backend.ts:161-162 for `permissionMode: "default"`; re-opened — it is at :160-161 (sed verified). Corrected in REVIEW.md. Also re-verified results-watcher.ts:44, submit.ts:323, engine.ts:234-237, bundle.ts:67-68/203-204, types.ts:130/190 verbatim this session.
- PATH-binary resolution triplication (engine.ts chain / claude-pty whichSync / submit whichGt) noted by 3B and 3C separately — consolidated as one cross-lane tail line under Process/IPC.
- Open flag preserved, unverified: registerAgentPaneIpc(mainWin) binds the first window vs app.on('activate') re-creation (main/index.ts:808-812) — 3A flagged it to 3B; 3B did not verify; carried in the Claude/Agent tail for Pass 4/6.
- Cross-lane routing notes for later passes: tombstone bug chain ends in renderer/index.ts:2660-2667/2864-2868 (→ 4A/4C: applyResultsEvent needs the abandoned check too); three-step submit with no rollback orchestrated by renderer/submit.ts (→ 4C); terminal.py-as-third-claude-bridge folded into the route-convergence finding (closes the Pass 2 routing note).

LAST COMPLETED PASS: 3

## Pass 4 — Desktop Renderer (2026-06-12)

Gate check: GATES.md present; GATE 1 CLOSED, GATE 2 CLOSED. Review-only synthesis; no proposal/roadmap/implementation content written.

Lanes completed: 4A (orchestration & chrome), 4B (viewers & anchoring), 4C (comments, submit UX & panes) — all three lane files present and non-empty in evidence/pass4/. Synthesized into the three Renderer sections of REVIEW.md (15 findings + per-section tails + two reusability notes), key-takeaways block at the top of "Renderer — Orchestration & Chrome".

Anomalies / synthesis decisions:
- Merged 4A's four-cloned-loaders and 21-mutable-lets findings (same openDocument/DocSession refactor); merged 4B's twin-iframe-viewers and lossy-selector-capture findings (the capture code is duplicated across the twins and the IframeDocViewer extraction is the home for both fixes); merged 4C's recovery-affordances and sling-failure-status-stranding findings (one submit-failure-path family, one re-plumbing fix); merged 4C's card-surface and payload-builder-triplication findings (same anchor-union companion change).
- Cross-lane overlap on the `as any` md_anchor smuggle (4B cited renderer/index.ts:2214-2223/1686/1702; 4C cited :2198-2225/:1683-1713 — same code): kept the anchor-semantics/discriminator half in "Viewers & Anchoring" and the builder-triplication/card half in "Comments, Submit UX & Panes" with explicit cross-references, consistent with the run-plan overlap rule.
- Demoted 4A's draftsCache finding (med/S) to a fully-cited tail line under Orchestration cross-referencing 4C's re-seed finding, where the user-visible data loss lives; likewise demoted 4C's ghost-pill race and localStorage-persist findings and 4B's renderPage-race and docx-dark-mode findings to cited tail lines to hold the finding count near the cap.
- Pass-3 routing notes closed: applyResultsEvent confirmed missing the abandoned check (renderer half of the tombstone chain, now a finding); the three-step-submit-no-rollback note is confirmed and extended by the status-stranding facts (submit.ts:233-235 dispatch-before-sling). The Pass-3 open flag on registerAgentPaneIpc(mainWin) first-window binding was NOT verified by any Pass-4 lane — still open for Pass 6.
- Citations spot-checked verbatim this session before merging: md-viewer.ts:118-124/146-148, submit.ts:136-140/716-721, renderer/index.ts:1398/1415/1423, :2660-2667, :2954-2959, :487/:804, shared/types.ts:170, toolbar.ts:344, App.tsx:25-26 — all confirmed exact. One nuance tightened: 4B's claim that the viewer "does not retain the raw frontmatter text" — the frontmatter IS rendered into a DOM card (renderFrontmatter, md-viewer.ts:122/229); REVIEW.md phrases the fact as "nothing reattaches the stripped block in getContent()", which is what the grep evidence supports.
- Finding count is 15 (vs the ~12 template cap) after the four merges above; the renderer is the densest layer (god-file + four viewers + submit UX) and three of the overflow items are high-severity data-loss/dead-recovery bugs that should not be tail lines.
- Cross-lane routing notes for Pass 5/6: pdf-viewer already consumes the pdf.js builder chain (TextLayerBuilder/StructTreeLayerBuilder, pdf-viewer.ts:31-34/:204-240) so the annotation layer slots into renderPage (→ 5A); shared/md/anchors.ts is the designated text-anchor substrate for MD/HTML/DOCX once the verification guard lands (→ 5A/5B); the new-pane worker fire-and-forget finding plus Pass 3B's spawn-cap finding together gate any default-flip of the agent-pane flag (→ exec summary).

LAST COMPLETED PASS: 4

## Pass 5 — Special Question: Multi-Format Comment Round-Trip (2026-06-12)

Gate check: GATES.md present; GATE 1 CLOSED, GATE 2 CLOSED. Review-only synthesis; the 5B spec sketch is carried in REVIEW.md explicitly labeled "DRAFT — input to Phase B", not as a proposal; no roadmap/implementation content written.

Lanes completed: 5A (options & recommendation: PDF round-trip, DOCX comments.xml, unified model shape), 5B (reusable assets & starter spec draft) — both lane files present and non-empty in evidence/pass5/. Synthesized into "Capability — Multi-Format Comment Round-Trip (special question)": 3 option-set recommendations (PDF split-library, DOCX hand-rolled adapter + re-grounded SuperDoc rejection, M-2 anchor union) + 4 findings (status vocabularies, rig-typed new_anchor, PDF-pair bundle hard-commit, native record only in spike output) + condensed asset inventory + the DRAFT sketch/adapter-table/status-mapping + tail; key-takeaways block at top.

Anomalies / synthesis decisions:
- Citation correction during spot-check: 5B called engine `Status` an "11-value Literal"; re-opened state.py:172-183 this session — the Literal contains exactly 9 strings. Corrected to 9 in REVIEW.md (the finding stands: 9 vs 7 vs 5 values, zero shared strings — the cross-vocabulary grep was re-run this session, no output, exit 1).
- Re-verified verbatim this session before merging: pdf-viewer.ts:204 (TextLayerBuilder), the no-annotation-surface grep (exit 1), bundle.ts:73-76/:104/:152, types.ts:110-117/:130/:155-156/:159-166/:170/:245, shared/bundle.ts:20/:32-37, state.py:172-183/:192-199, extract.py:321, cli.py:119/:812, docx-viewer.ts:44-46, spike.mjs:278, readback.json head, desktop/package.json:69/:71-72 — all confirmed exact except the 11→9 count above.
- De-duplication: the pdf-lib spike facts appeared in both lanes (5A options basis; 5B asset A8) — cited once per use site; 5A's three union requirements (quads[]/origin/native_ref) kept in the recommendation with 5B's sketch carrying the field shapes; 5B's full status table summarized in REVIEW.md with a pointer to evidence/pass5/5B.md §3.3 (the `?` cells are owner decisions for Phase B).
- Pass-1 routing note closed: desktop/spikes/rev-cvr-pdf-lib/{spike.mjs,readback.json} (the unowned-asset note) is now cited as load-bearing read-back evidence. Pass-4 routing note closed: the renderPage annotation-layer slot is the read-path recommendation. Pass-2 reusability note confirmed: engine annotations.json schema-v2 (subtype/native-id/in_reply_to) is the unavoidable cost of engine-side round-trip.
- Still open for Pass 6: the registerAgentPaneIpc(mainWin) first-window-binding flag (Pass 3A → 3B → 4 → unverified by any lane; out of Pass-5 scope). New cross-cutting fact for Pass 6's exec summary: the anchor-union migration is a THREE-party schema event (drafts sidecar + submit/results files + rig contract, types.ts:245) — changes Phase-B sequencing versus the desktop-only framing in Passes 3–4. Charter-wording note for Phase B: "DOCX comments.xml read/write, body read-only" is exactly true only for comment-text EDITS; create/delete must touch document.xml range markers (python-docx docs, cited in REVIEW.md §2).

LAST COMPLETED PASS: 5

## Pass 6 — Synthesis, Verification & Exec Summary (2026-06-12)

Gate check: GATES.md present; GATE 1 CLOSED, GATE 2 CLOSED. `## Roadmap` left as its placeholder per the gate rules; no proposal/roadmap/implementation content written. The GATE 1 Review Packet is appended to REVIEW.md (doubles as the Phase-A completion sentinel per run-plan).

Verification tally: 14 claims (C1–C14) selected for highest Phase-B impact, one independent read-only verifier each — **14 CONFIRMED, 0 WRONG, 0 UNVERIFIABLE**. Full per-claim record (verdict + note + claim + citation) in evidence/pass6/verification.md. No findings deleted or downgraded; each confirmed claim marked with a trailing ✓ in REVIEW.md.

Anomalies / synthesis decisions:
- The one explicitly uncited link in the whole review (Pass 2A: git's nonzero exit when `git add` names ignored paths) was REPRODUCED by the C2 verifier on git 2.50.1 ("Use -f if you really want to add them", exit 1) — the commit-phase exit-19 finding's flag text in REVIEW.md updated from "flagged for a Pass-6 verifier" to "link closed".
- The open flag carried unverified since Pass 3 (registerAgentPaneIpc first-window binding, main/index.ts:808-812) is CLOSED as a confirmed bug by the C13 verifier: agent-pane-ipc.ts:24/:27-28 hold a module-level mainWindowRef whose isDestroyed() guard (:114) silently drops all agent:event pushes to re-created windows. REVIEW.md's Claude/Agent "Also noted" line rewritten from open-flag to confirmed S-sized bug.
- One precision note from the C10 verifier preserved in REVIEW.md: the "Submit already in flight." flash is the SECOND guard in handleSubmitBundle (a doc-open check at index.ts:1086-1089 precedes it) — does not affect the no-op conclusion.
- C14 is the review's only web-only citation (python-docx user docs); the verifier re-fetched all three quotes verbatim. Noted in the packet's UNCERTAIN list that web-sourced capability facts are as-of-2026-06-12.
- Executive Summary written (1 page: verification stats, overall verdict, five conclusions); it explicitly tells readers nothing came back WRONG and how to calibrate the unverified remainder.
- No de-duplication edits were needed in Pass 6 beyond the above — cross-section reconciliation was already done by the Pass 2–5 synthesizers (their merge decisions are logged in the per-pass blocks above) and re-checking found no contradictions between sections.

Artifacts: evidence/pass6/verification.md; REVIEW.md (exec summary + 14 ✓ marks + 2 evidence-driven text updates + GATE 1 Review Packet); this PROGRESS block.

Phase A complete. Next step is human-only: review the GATE 1 packet at the end of REVIEW.md and, if approved, edit GATES.md line 1 per its TO OPEN section. No agent work remains until GATE 1 is OPEN.

LAST COMPLETED PASS: 6
