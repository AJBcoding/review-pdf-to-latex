# B3 — Adversarial challenge of the Phase B drafts (lane B3, 2026-06-12)

Gate check performed first this session: `grep -n 'GATE' docs/reports/arch-review/2026-06-12/GATES.md` →
line 1 `GATE 1 (review findings → proposals & roadmap): OPEN — approved by Anthony Byrnes 2026-06-12`,
line 2 `GATE 2 (proposals → implementation): CLOSED`. Phase B proceeds; GATES.md untouched.

Inputs read in full: charter, ground-truth map, PROGRESS.md (ends `LAST COMPLETED PASS: 6`),
REVIEW.md (all 487 lines), B1-roadmap-draft.md, B2-spec-draft.md.

**Spot-checks performed (finding references re-opened against REVIEW.md, 10 of the required ≥8):**
N1↔C7 (REVIEW.md:284-288 ✓ quoted accurately), N4↔C1 (:33-37 ✓), N5↔C2 (:39-43 ✓),
X1↔"Before any unified-model refactor, add vitest coverage" (:236 ✓ quoted accurately),
X3↔five-seam split list (:150 ✓), X9↔"all seven write sites" (:224 ✓ — but see issue 13),
L7↔`--since` cursor (:77-79 ✓), N7↔Capability §7 readback field set (:412 — **misquoted, issue 3**),
OD-1↔Capability finding 4 (:397-398 — **semantics misread, issue 1**),
B2 D1↔GATE 1 packet checklist (:471 — **unchecked box presented as accepted, issue 6**).
Fresh ground-truth verifications this session (commands + outputs on record above this file's
creation): `desktop/shared/types.ts:109-117` (CommentStatus, 7 values incl. `build_failed`),
`types.ts:227-235` (ResultEntryStatus "narrower than CommentStatus" — a strict subset, 5 shared
strings), and `grep -in 'IRT\|reply\|in_reply' desktop/spikes/rev-cvr-pdf-lib/readback.json
desktop/spikes/rev-cvr-pdf-lib/spike.mjs` → exit 1, zero hits.

**Checks that came back clean (asserted so the closer doesn't re-litigate):** no NOW item secretly
depends on the anchor union (N1–N6 are standalone; N7/N8 are spike INPUTS to X5, not dependents);
no roadmap item rests on zero named findings (the "Now-adjacent" cluster is labeled judgement but
each line names its finding); adapters (L3–L6) are all sequenced after the union (X5) in both
drafts; B1's OD-2/OD-3/OD-4 and B2's D2–D7/D9/D11 carry the required PROPOSED DEFAULT marking.

Issues only, numbered, severity-tagged. No rewrites.

---

## HIGH

### 1. B1 and B2 contradict each other on the engine `needs_review` mapping — and B1's default misreads the finding it cites
- B1:481-485 (OD-1 first bullet): "engine `needs_review` → unified `build-failed` family, NOT
  `needs-followup`", rationale quoting Capability §4's conflation warning.
- B2:274-275 (§6 table) + B2:326 (D5): engine `needs_review` is **deliberately not a unified
  status at all** — it surfaces only as `workflow.engine_status` plus anchor-resolution confidence.
- Ground truth: REVIEW.md:398 characterizes `needs_review` as the "(apply-failure flow)";
  desktop `build_failed` is the RIG's build outcome ("build-error excerpt for `build_failed`",
  types.ts:247-249, re-opened this session; rig-written per types.ts:107-109). Apply-failure /
  low-confidence-mapping workflow is neither a rig disposition nor a build failure — B1's default
  commits a conflation of the same class its own rationale quotes Capability §4 to forbid.
- Consequence: the closer cannot merge both drafts; the spec's normative table (B2 §6) and the
  roadmap's owner-decision sheet (B1 OD-1) currently give the owner two different defaults for the
  same `?` cell. One must be rewritten to match the other before the closer promotes anything.

### 2. B1 and B2 assume different unified status SETS (8-value vs 7-value) and different spellings
- B1:481 says "`build-failed` family" (hyphen) and OD-1 is framed against the REVIEW.md sketch's
  8-value set "open/submitted/applied/rejected/deferred/needs-followup/build-failed/resolved"
  (REVIEW.md:439, which includes `resolved`).
- B2:119 (§3.2) + B2:262 (§6) fix the unified vocabulary as "the desktop `CommentStatus`,
  unchanged" — 7 values, `resolved` explicitly **not added** (B2:277), and shipped spellings kept
  verbatim including underscore `build_failed` (B2:279, D11 at :332).
- Ground truth: types.ts:109-117 (re-opened) spells it `build_failed`; the sidecars/results files
  on disk use that string. A roadmap that promises a "`build-failed` family" and a spec that
  forbids respelling and forbids `resolved` describe two different schemas. Same merge problem as
  issue 1; X2's "Done when" (B1:164-168) points at OD-1, so the roadmap inherits the wrong table.

### 3. The /IRT kill path in BOTH drafts rests on read-side reply support that no evidence establishes
- B1:101-104 (N7 kill criteria): on spike failure, "keep read-only display of existing replies via
  the union's `native.in_reply_to` field, **which read-back already supports per Capability §7**."
- B2:306 (S-1 kill criterion): on failure, "v1 ships replies read-only (display
  `native.in_reply_to` threads in the card stream…)".
- Ground truth: Capability §7's readback field set is `{page, subtype, rect, contents, author,
  color, quads[]}` (REVIEW.md:412) — **no reply parent**; the sketch itself annotates
  `in_reply_to? /* captured nowhere today */` (REVIEW.md:428); Capability §1 says the spike "did
  NOT exercise" /IRT (REVIEW.md:377). Re-verified this session: `grep -in 'IRT\|reply\|in_reply'`
  over readback.json + spike.mjs → zero hits. B1's "read-back already supports" is a finding
  misquote, and the shared kill path ("fall back to read-only display") may itself be infeasible —
  the S-1 spike scope must include the READ half (pdf.js `getAnnotations`/pdf-lib exposing /IRT),
  or the kill path needs its own kill path.

### 4. Rollout order: the rig flips to v2 results files (step 2) one step before the desktop's declared v2-results tolerance (step 3)
- B2:175-181 (§4.4 table): step 2 = rig ships "v2 submit-file reader + kind-echoing new_anchor +
  **v2 results writer**"; the desktop's "tolerates v1 AND v2 results files" guarantee appears only
  in step 3's row. Step 1's desktop tolerance column lists only "v1 sidecars … still EMITS v1
  SubmitFile" — nothing about reading v2 results.
- The spec's own stated philosophy makes this load-bearing: §3.3's downgrade story (B2:147) is
  that a reader "fails loudly on the literal `schema_version` mismatch rather than silently
  mutating". Applied consistently to results files, a step-1 desktop would loudly reject every
  step-2 rig result — a party forced to break compatibility, exactly the unshippable-order class.
  (In today's shipped code nothing validates results `schema_version` — REVIEW.md:160's
  no-runtime-validation finding — so it would *silently work*, but the spec cannot rely on the
  absence of validation it elsewhere mandates adding.)
- Fix direction (closer's choice, not mine to write): either move the rig's results-writer flip
  into step 3+, or add "reads v2 results files" to the step-1 desktop deliverable and to §10's
  acceptance criteria (criterion 5 currently covers only the v1-stays-readable direction).

---

## MEDIUM

### 5. Effort-tag sandbagging on the items that touch the rig contract or merge multiple M findings
- **X5 = M** (B1:194): bundles the union schema + DraftsFile v2 migration + writeBundle narrowing
  (REVIEW.md:218 tags the C5 fix alone "M (ripples through renderer + sidecars; schema_version
  bump or tolerant reader required)") + as-any deletion + MdAnchor dedup + submit/results v2 +
  **rig coordination** (REVIEW.md:400-403: "coordination is the real cost"; B2's own §4.4 needs a
  4-step cross-party rollout with a deploy-confirmation gate). An item that moves the rig contract
  and requires a multi-step coordinated rollout is not an M; tag L, or split the rig-coordination
  rollout out as its own item.
- **N6 = M** (B1:75): explicitly folds in the submit-state-machine extraction + vitest, which
  REVIEW.md tags as its own M ("Zero tests on the submit state machine", :350-354) on top of the
  retry re-plumb's M (:324). Two M's labeled one M.
- **X7 = M** (B1:232): merges three findings tagged high/M (:260-264), med/S–M (:266-270), and
  med/M (:302-306).
- **X2 = S–M** (B1:161): REVIEW.md Capability §4 tags the vocabulary problem "[high / M — spec
  work…]" (:395). Downgraded with no stated reason.

### 6. B2 D1 presents a pending owner confirmation as already given
- B2:322 (D1 status): "owner accepted M-2 as Phase-B centerpiece at GATE 1 (packet checklist
  item)". Ground truth: the GATE 1 packet's checklist items are UNCHECKED boxes (`- [ ] Confirm
  you accept the M-2 discriminated anchor union…`, REVIEW.md:471), and the gate line records only
  approval to enter Phase B — no artifact records the M-2 confirmation specifically. Per the
  evidence rules this must be "PROPOSED DEFAULT — owner may override at GATE 2" (or cite a real
  owner artifact). Note the union itself is well-evidenced — the problem is solely the "owner
  accepted" provenance claim.

### 7. B2's step-0 "C5 narrowing before v2" is incoherent as worded, and B1 doesn't schedule it at all
- B2:177 (§4.4 step 0): "`writeBundle` rejects/skips non-`pdf-quad` anchors *immediately*, even
  before v2, as a one-line guard." Pre-v2 there IS no `pdf-quad` kind — every v1 comment carries
  the required PDF-shaped `anchor`, including the md/html placeholders `{page:1, 0,0 0×0}`
  (REVIEW.md:216-217, :292; types.ts:126-130 re-opened). A guard keyed on anchor kind matches
  nothing; the implementable pre-v2 guard keys on file-level `anchor_kind`/`md_anchor` presence
  (or the renderer-side `classifyPath === 'pdf'` gate REVIEW.md:356 already recommends).
- Cross-draft gap: B1 has no NOW item for this guard — C5 lands only inside X5 (B1:195-218). So B2
  mandates an immediate fix the roadmap never schedules. Pick one: add it to B1's Now-adjacent
  list, or strike "immediately, even before v2" from B2.

### 8. B2's migration enumeration never migrates `new_anchor`
- B2:138-143 (§3.3 step 2) maps `anchor`, `md_anchor`, the smuggled selector shape, and
  `pdf_annotation_id` — but v1 rows can carry `new_anchor?: AnchorRegion | null` (types.ts:150,
  re-opened; written by the rig, consumed by reveal per REVIEW.md:402), and CommentV2 re-types it
  to the union (B2:100). The per-row mapping is silent on it (presumably the §4.3 bare-
  `{page,region}` tolerant parse applies, but §4.3 scopes that rule to anchors "appearing in any
  `new_anchor`" *on the wire*, not to the sidecar migration), and acceptance criterion 1 (B2:336)
  tests four row shapes, none of which is new_anchor-bearing. Add the mapping row and a fifth test
  shape.

### 9. The two drafts tell different migration stories off the same cited precedent
- B1:205-207 (X5 done-when): tolerant reader "following the sidecar-migration precedent named in
  the sketch" — the sketch's precedent (REVIEW.md:428) is the one-shot startup migration of
  domain trap #5.
- B2:135-137 (§3.3): explicitly REJECTS the startup sweep as "the anti-pattern to avoid
  repeating" (citing the Pass-3C startup-cost finding, REVIEW.md:238) and specifies lazy
  read-time, rewrite-on-next-write migration.
- Both are defensible; they are not the same plan, and both cite "the precedent". The closer must
  pick B2's lazy variant (the better-evidenced one) and align B1's wording, or vice versa.

### 10. The step-3 rollout gate ("after step-2 rig is confirmed deployed") has no verification mechanism and no acceptance criterion
- B2:180 conditions the desktop's v2 submit-writer flip on rig deployment confirmation, while D2
  (B2:185, :323) declines any runtime negotiation/handshake as PROPOSED DEFAULT. With no
  handshake, "confirmed deployed" is checked by… nothing stated. §10's acceptance criteria don't
  cover it (criterion 5 tests file tolerance, not the gate). Untestable as written — either name
  the manual check (e.g. a rig version probe, or a results file observed with `schema_version: 2`)
  or fold the risk into D2's rationale explicitly.

---

## LOW

### 11. Unspecified v2→v1 down-conversion during the transition window
- From step 1 the drafts store v2 — and the migration **discards** the v1 placeholder PDF anchor
  for text-quote rows (B2:140) — yet the desktop "still EMITS v1 SubmitFile" until step 3
  (B2:178-180). Emitting v1 from v2 rows requires re-synthesizing the v1 shape (required
  `AnchorRegion`, `md_anchor` blob) that the migration just threw away. In practice only PDF
  rounds promote today (the non-PDF submit gate is accidental — REVIEW.md:356), so the
  down-conversion is mechanical (pdf-quad → page+region, drop quads) — but neither draft states
  it, and B1 schedules no item for it.

### 12. wait-event tests are double-claimed
- B1 L7 (B1:388) and B1 L13 (B1:447) both claim the wait-event test gap from the same finding
  (REVIEW.md:111-114). Harmless but the closer should assign it once (L7 is the natural home —
  the tests should target the post-extraction events.py).

### 13. X9's "Resolves" and "Done when" disagree on the site count
- B1:264-265 adds "the session-store writeFileSync outlier" (session-store.ts:43 per
  REVIEW.md:204) to X9's scope, but the done-when list (B1:266-268) enumerates only REVIEW.md's
  seven sites (:224) and omits session-store. Eight sites or seven — say which.

### 14. B2 silently corrects REVIEW.md's "share zero strings" claim without flagging it
- REVIEW.md's Exec Summary (:17) and Capability takeaway (:367) say the three status vocabularies
  "share zero strings"; the underlying grep (:397) only proves engine↔desktop. Verified this
  session: rig `ResultEntryStatus` is a declared strict subset of `CommentStatus`
  (types.ts:227-235, "narrower than CommentStatus") — desktop and rig share all 5 rig strings.
  B2:260-262 words itself carefully ("zero shared strings **with the engine**") and its `deferred`
  row says "Same string" (B2:273) — correct, but the correction is unannounced, so a closer
  merging B1 (which restates nothing) and the Exec Summary could re-propagate the wrong claim into
  the final Roadmap prose. One sentence in the spec noting the correction closes it.

---

Tally: 4 HIGH, 6 MEDIUM, 4 LOW = 14 issues. The HIGH set blocks the closer from a clean merge:
issues 1–2 (status-table contradiction) require one draft to yield before the spec file is
promoted; issue 3 requires widening spike S-1's scope; issue 4 requires a one-row rollout-table
amendment. None invalidates the M-2 union centerpiece itself, whose evidence base held up under
every spot-check performed here.

— end B3 challenge (issues only; no draft text was modified)
