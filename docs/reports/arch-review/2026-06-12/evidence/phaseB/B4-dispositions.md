# B4 — Challenge dispositions (Phase B closer, 2026-06-12)

Gate check re-run this session: `grep -n 'GATE' docs/reports/arch-review/2026-06-12/GATES.md` →
line 1 `GATE 1 (review findings → proposals & roadmap): OPEN — approved by Anthony Byrnes 2026-06-12`,
line 2 `GATE 2 (proposals → implementation): CLOSED`. GATES.md untouched.

All 14 B3 issues dispositioned below. FIXED = draft content changed in the merged deliverables
(REVIEW.md `## Roadmap` and/or `docs/specs/2026-06-12-unified-comment-model-and-roundtrip.md`);
REBUTTED = challenge declined with evidence. Tally: 13 FIXED, 1 FIXED-WITH-NOTE, 0 REBUTTED.

## HIGH

1. **FIXED — B1's OD-1 default WITHDRAWN; spec §6/D5 wins.** The challenge is correct: REVIEW.md:398
   characterizes engine `needs_review` as apply-failure/mapping-confidence workflow, while desktop
   `build_failed` is the RIG's build outcome (types.ts:247-249) — B1's "`build-failed` family"
   default commits the very conflation Capability §4 forbids. Merged position (roadmap OD-1 = spec
   §6 table): engine `needs_review` is never a unified status; it surfaces as
   `workflow.engine_status` plus anchor-resolution confidence. One table, both documents.

2. **FIXED — one status set: the 7-value desktop `CommentStatus`, shipped spellings verbatim
   (incl. underscore `build_failed`), no unified `resolved`.** B2's set wins (it matches
   types.ts:110-117 as re-opened by B3 and the on-disk strings); B1's "8-value / `build-failed`
   (hyphen)" framing was an artifact of the REVIEW.md:439 sketch and is corrected in the roadmap's
   OD-1 and X2.

3. **FIXED — spike S-1 (roadmap N7) widened to BOTH halves of /IRT, and the kill path got its own
   kill path.** B3's grep (zero /IRT hits in readback.json + spike.mjs) stands; B1's "read-back
   already supports per Capability §7" was a misquote and is deleted. New scope: prove the read
   half (pdf.js `getAnnotations` / pdf-lib walk exposing /IRT) AND the write half. New kill ladder:
   write-half fails → replies read-only; read-half also fails → replies out of v1 entirely,
   `native.in_reply_to` stays optional and populated only when readable.

4. **FIXED — rollout table step 1 now includes "desktop reads v2 results files (tolerant
   union parse, both shapes)"** so the rig's step-2 v2-results flip never outruns desktop
   tolerance; spec acceptance criterion 5 extended to test both directions from step 1. (Chosen
   over delaying the rig flip — one tolerant reader is cheaper than a third rollout step.)

## MEDIUM

5. **FIXED — effort tags corrected.** X5 → **L** (union schema + lazy migration + writeBundle
   retrofit + submit/results v2 + three-party rig coordination; REVIEW.md:400-403 "coordination is
   the real cost"). N6 → **M–L** (deliberately bundles the retry re-plumb M with the
   submit-state-machine extraction M, REVIEW.md:324 + :350-354 — bundled because the extraction is
   the stated precondition for the re-plumb). X7 → **M–L** (merges high/M + med/S–M + med/M
   findings). X2 → restored to **M** per REVIEW.md:395 ("[high / M — spec work]").

6. **FIXED — spec D1 provenance corrected.** The GATE-1 checklist box (REVIEW.md:471) is unchecked;
   no artifact records the M-2 confirmation. D1's status now reads: union settled on verified
   findings; the centerpiece designation itself is PROPOSED DEFAULT — owner may override at
   GATE 2. Also listed in the GATE 2 packet UNCERTAIN.

7. **FIXED — step-0 guard reworded to something implementable pre-v2, and scheduled.** Pre-v2 there
   is no `pdf-quad` kind; the guard now keys on what v1 actually carries: file-level
   `anchor_kind !== 'pdf-glyph-rect'` / `md_anchor` presence on the comment, plus the
   renderer-side `classifyPath(...) === 'pdf'` submit gate REVIEW.md:356 already recommends. Added
   to the roadmap's Now-adjacent ride-along list (it was unscheduled in B1).

8. **FIXED — migration step 2 gains a `new_anchor` row** (v1 `{page, region}` → `{kind: 'pdf-quad',
   page, region}`, same tolerant parse applied at migration time, null/absent passes through), and
   acceptance criterion 1 now tests five row shapes including a new_anchor-bearing one.

9. **FIXED — one migration story: B2's lazy read-time migration (rewrite on next write) wins**; it
   is the variant that cites the startup-cost finding (REVIEW.md Pass-3C tail) as the anti-pattern.
   Roadmap X5's "following the sidecar-migration precedent" wording replaced with an explicit
   pointer to spec §3.3's lazy plan — the precedent reused is the tolerant reader, not the startup
   sweep.

10. **FIXED — the step-3 gate got a named manual verification**: the desktop's v2 submit-writer
    flip happens only after at least one rig-written results file with `schema_version: 2` has
    been observed for a real round (recorded in a bead); added to D2's rationale and as acceptance
    criterion 7. No-handshake remains the PROPOSED DEFAULT.

## LOW

11. **FIXED — v2→v1 down-conversion stated.** Spec §4.4 now specifies the transition-window
    down-converter for SubmitFile emission: `pdf-quad` → required `{page, region}` (drop `quads`);
    non-PDF rows do not arise in practice during the window (only PDF rounds promote today — the
    accidental gate, REVIEW.md:356 — and the step-0 guard makes that gate explicit). Scheduled
    inside roadmap X5's done-when.

12. **FIXED — wait-event tests assigned once, to L7** (they should target the post-extraction
    events.py); struck from L13, which keeps bulk-surface.

13. **FIXED — X9 scope is EIGHT write sites**: REVIEW.md's seven (submit.ts, bundle.ts, three
    main/index.ts inline copies, drafts:read relink, sidecar-migration) plus the
    session-store.ts:43 `writeFileSync` outlier; done-when now enumerates all eight.

14. **FIXED-WITH-NOTE — the "share zero strings" correction is now announced.** Spec §6 carries an
    explicit correction sentence: the grep-proven zero-overlap claim is engine↔desktop only; the
    rig's `ResultEntryStatus` is a declared strict subset of `CommentStatus` (types.ts:227-235,
    "narrower than CommentStatus") sharing all 5 strings. The roadmap avoids restating the broad
    claim. NOTE: REVIEW.md's Exec Summary (:17) and Capability takeaway (:367) retain the
    overbroad phrasing — the closer's write rules forbid touching anything in REVIEW.md beyond the
    Roadmap section and the appended GATE 2 packet, so the correction is recorded here, in the
    spec, and in the GATE 2 packet rather than edited in place.

— end B4 dispositions
