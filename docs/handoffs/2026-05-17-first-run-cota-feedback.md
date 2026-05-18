---
type: handoff
status: active
created: 2026-05-17
audience: review-pdf-to-latex author (AJB)
session_role: first-real-run validator
source_project: ~/gt/python419/crew/anthony/reports/cota-impact
source_pdf: ~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment-RESTORED.pdf
---

# review-pdf-to-latex — first-run friction report (COTA Impact v2.0)

## Run summary

- **Project root:** `/Users/anthonybyrnes/gt/python419/crew/anthony/reports/cota-impact/`
- **Source PDF:** `~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment-RESTORED.pdf` (40 annotations: 39 highlights + 1 sticky note, all "Anthony Byrnes")
- **Engine:** installed at `~/PycharmProjects/review-pdf-to-latex/.venv/` (`pip install -e .`); Python 3.14.3
- **Phase reached:** **0-setup only**. Viewer crash blocked entry to Phase 1 manual-mapping resolution and would also block all of Phase 2a.
- **State preserved at:** `~/gt/python419/crew/anthony/reports/cota-impact/.review-state/`
- **Pre-run stash:** `stash@{0}` "review-pdf phase 0 pre-extract stash 2026-05-17" — three dirty files (`reports/cota-impact/templates/advising_investment.tex`, `reports/cota-impact/templates/appendix.tex`, `.claude/tdd-guard/data/test.json`). **Not popped** — Phase 1 would mutate the same `.tex` files.

## What worked

1. **`pip install -e ~/PycharmProjects/review-pdf-to-latex`** — clean install. Editable wheel built fine on Python 3.14.
2. **CLI surface** — `review-pdf --help` enumerates 14 subcommands cleanly. Help text per subcommand is terse but complete.
3. **`extract`** — ran in ~3.8s end-to-end on a 40-annotation, 10-page PDF. Produced `annotations.json`, `mapping.json`, `state.json`, and 10 page PNGs. Schema versions in place. Exit code 0.
4. **Mapping accuracy** — for the 31 annotations where pdfannots succeeded in extracting highlighted text, the fuzzy mapper performed well: 15/31 above 0.95 confidence, 8/31 in 0.80–0.94, 5/31 in 0.60–0.79, 3/31 in 0.40–0.59, **zero** below 0.40. Notably, `ann-001` mapped to `templates/note_on_report.tex` (a file *created* during the manual review pass — moved content from `front_matter.tex`) at 0.998 confidence; the mapper found the moved prose in its new location.
5. **`needs_review` discrimination** — every annotation with empty `highlighted_text` was correctly flagged `needs_review` with `method=failed`, `confidence=0.0`, `latex_file=null`. No false-positive mappings.
6. **State separation** — `phase: 0-setup` set correctly; `current_annotation_id` and `builds[]` initialized to empty; `order: mechanical-first` default applied.

## What broke

### BLOCKER #1 — Viewer crashes on every GET (`StrictUndefined` against missing context)

**Symptom:** Browser shows "failed to open page"; curl returns empty reply.

**Root cause:** `src/review_pdf_to_latex/server.py:271`:

```python
return template.render(current_state=current_state, mode=self.mode).encode("utf-8")
```

passes only two kwargs, but `templates/frame.html` (462 lines) references at minimum: `diff2html_present`, `project_root`, `phase`, `order`, `annotation_index`, `total_annotations`, `current_annotation` (plus `current_annotation.id` and presumably the rest of the annotation dict). Jinja env at `server.py:49` is configured with `jinja2.StrictUndefined`, so the first missing var raises `UndefinedError` mid-render and the response body is never written.

**Trace (first request):**

```
File ".../server.py", line 271, in _render_frame
  return template.render(current_state=current_state, mode=self.mode).encode("utf-8")
File ".../templates/frame.html", line 215, in top-level template code
  {% if diff2html_present %}
jinja2.exceptions.UndefinedError: 'diff2html_present' is undefined
```

Identical trace for every subsequent request. The `_render_frame` docstring even acknowledges the contract violation: *"this method only guarantees that current_state (dict) and mode (str) are always passed as kwargs"* — but the template requires far more.

**Impact:**
- Phase 0 manual-mapping UI unreachable (the 9 `needs_review` entries cannot be resolved through the browser).
- Phase 2a Ratify entirely unreachable. This is the central per-annotation user touchpoint; without it, the four-phase workflow has no human-facing approval step.
- `--mapping-mode` and normal mode are both affected — same render path.

**Suggested fix shape** (not implementing without your sign-off):

```python
def _render_frame(self) -> bytes:
    state_path = self.project_dir / STATE_DIR_NAME / "state.json"
    current_state = json.loads(state_path.read_text())
    annotations = current_state["annotations"]
    current_id = current_state.get("current_annotation_id")
    current_annotation = annotations.get(current_id) if current_id else None
    annotation_index = (
        list(annotations).index(current_id) + 1 if current_id else 0
    )
    static_dir = self.project_dir / STATE_DIR_NAME / "static"
    context = {
        "current_state": current_state,
        "mode": self.mode,
        "project_root": str(self.project_dir),
        "phase": current_state.get("phase"),
        "order": current_state.get("order"),
        "annotation_index": annotation_index,
        "total_annotations": len(annotations),
        "current_annotation": current_annotation,
        "diff2html_present": (static_dir / "diff2html.min.js").exists(),
    }
    template = _jinja_env.get_template("frame.html")
    return template.render(**context).encode("utf-8")
```

This is a guess at intent; the spec likely has the canonical answer in §10 (viewer architecture). The deeper issue is that **there are no integration tests that hit the rendered HTML** — the bug is on the first GET, so the synthetic suite must be exercising the server differently or mocking it out entirely.

### BUG #2 — `--project-dir` is top-level only; skill docs put it on every subcommand

**Symptom:**

```
$ review-pdf extract --pdf foo.pdf --project-dir /path/to/proj
review-pdf: error: unrecognized arguments: --project-dir /path/to/proj
```

**Root cause:** argparse declares `--project-dir` only on the top-level parser (visible in `review-pdf --help`). The skill (`~/.claude/skills/review-pdf-to-latex/SKILL.md`) writes it after the subcommand in every example, e.g.:

```bash
review-pdf extract --pdf "<...>" \
  --project-dir "<absolute path to LaTeX project root>"
```

Working invocation:

```bash
review-pdf --project-dir "<proj>" extract --pdf "<...>"
```

**Fix options** (pick one):
- A. Move `--project-dir` into each subcommand's parser. Most flexibility for users but more code.
- B. Keep top-level only and rewrite every skill example. Cleaner but breaks muscle memory.
- C. Accept both positions (add `--project-dir` to subcommand parsers and have the subcommand handler prefer the subcommand-level value over the top-level value). Most forgiving; modest code.

I'd lean **C**. The first-run friction here was high — the CLI wouldn't even parse, with no hint that the flag was in the wrong place.

### BUG #3 — `pdfannots` "Missing text" warnings emitted twice

**Symptom:** Each of the 8 missing-text warnings prints twice during `extract`:

```
Missing text for Highlight annotation at page #2 (385.422,147.963)
...
Missing text for Highlight annotation at page #2 (385.422,147.963)
```

**Likely cause:** pdfannots is invoked twice during extract — probably once for annotation extraction and once for page geometry / coordinate normalization. Confirmable by `grep "pdfannots\." src/review_pdf_to_latex/`.

**Impact:** cosmetic; doubles the warning volume in stderr. But also a signal that the slow operation runs twice — on this small doc it cost ~1.5s of the 3.8s extract; on a 100-page review with 200 annotations it would be more painful.

**Fix:** cache the pdfannots result on the first call and reuse, or refactor to a single pass.

### BUG #4 — SURFACE trigger phrase is brittle; reviewer vocabulary diverges

**Symptom:** Only 3 of ~6 surface-intent annotations got `trigger_match=true`.

```
trigger_match=True:
  ann-009 "Claude surface this and let's refine this sentence in chat."
  ann-024 "We need to investigate this statistic - ... - claude surface this for a conversation"
  ann-025 "We need a conversation about this stat as well - CLAUDE surface this."

trigger_match=False (but surface-intent):
  ann-031 "Surface this whole table for conversation and comparison figures for all entries"
  ann-035 "SURFACE THIS - not sure this is accurate"
  (and from comment metadata not in trigger_match: page-6 #28, page-7 #37 use similar phrasing)
```

The current trigger seems to be the literal substring "claude surface this" (case-insensitive). AJB wrote "Surface this" / "SURFACE THIS" in two of his comments, which fall outside the trigger.

**Impact:** real workflow risk. After mapping resolves `needs_review` → `pending`, those annotations enter the Phase 1 mechanical batch and the engine will try to apply an edit — wrong outcome for an annotation the human meant for conversation.

**Fix options:**
- A. Broaden trigger to `(?i)\bsurface this\b` — accept any case, drop the "claude" prefix requirement. Cheap.
- B. Make it project-configurable: `.review-config.toml` with `surface_trigger = "..."` regex.
- C. Both: ship a sensible default that catches AJB's vocabulary, allow override.

I'd lean **C** with default broadened (A).

### BUG #5 — `needs_review` with empty `highlighted_text` is unresolvable by the viewer alone

**Symptom:** 8 of 9 `needs_review` entries have `highlighted_text == ""` (pdfannots couldn't read it from the PDF). Even if the user maps `latex_file` + `line_range` in the mapping-mode UI, the engine has no `before_text` for Phase 1 to anchor on.

**Why it happens:** The RESTORED PDF was reconstructed by re-injecting annotations from a corrupted source onto a clean PDF. Some annotations carry only bbox coordinates, not the underlying text run. (The handoff that briefed this run notes this.)

**Impact:** for these 8 annotations, the user has to provide BOTH the file+line range AND the new text in Phase 1, since there's no `before_text` to compare against. The viewer currently has no surface for "you'll need to type the intended edit text here too."

**Fix options:**
- A. When `highlighted_text == ""`, render a banner in the mapping-mode card: *"No text was extractable from this annotation. You'll need to provide both the mapping AND the intended edit text directly (we have no `before_text` to match against)."*
- B. In Phase 1, when `before_text` is empty/absent, skip the apply-revert-on-failure dance and instead emit `surfaced_pending` immediately — defer all empty-before_text annotations to Phase 2b. Probably the most correct behavior: these aren't mechanical edits if we can't even compare.

**B** is the cleaner long-term answer.

### BUG #6 — Engine accepts a structurally-corrupt PDF as input without warning

**Symptom:** `extract` against the original `2026-05-15-COTA-Impact-Report-v2.0comment.pdf` raises `AssertionError` from pdfannots at the first highlight on page 2:

```
Missing text for Highlight annotation at page #2 (387.652,147.622)
ERROR: AssertionError:
```

No preflight check; no helpful error message; the user just sees "AssertionError" with no traceback line numbers and no hint at what to do.

**Fix options:**
- A. Wrap pdfannots in try/except and emit: `"Extraction failed: <reason>. The PDF may have corrupted content streams; try re-saving via Preview/Acrobat, or reconstructing annotations onto a clean copy."`
- B. Add a `--probe` flag that validates the PDF before extraction (count annotations, sample pages) and prints a structured report.
- C. Both.

This isn't a frequent failure mode for healthy PDFs, but Adobe-edited PDFs that have been round-tripped through multiple tools (which is exactly what AJB had) hit it.

## What I wished was different (UX / CLI / skill prompt wording)

- **Skill wording on `--project-dir`** — every example needs the flag moved before the subcommand. Right now reading the skill teaches the wrong shape and the engine doesn't reject it until you try.
- **Skill's PDF assumption** — "Confirm the source PDF and project root with me before Phase 0" is good practice but the skill doesn't say *what to do if the PDF is broken*. A line like "*If `extract` raises an extraction error, ask the user whether a recovered/clean PDF is available — corrupted streams from Acrobat edits are common*" would have shortcut several minutes here.
- **Annotation-count expectation mismatch** — AJB's run brief said "80 annotations". Actual count: 40. (39 highlights + 1 sticky.) The brief may have been counting highlight-text + comment-text as separate items, or just hand-counted. No engine bug; just a planning detail to flag.
- **`status` subcommand output** — `review-pdf --project-dir X status` is the documented way to verify state, but the default (non-`--json`) output isn't actually a status table — at least not in this run. Couldn't tell from the help text alone. Would prefer the default to be a 4-line summary (phase, total/applied/pending/needs_review/surfaced counts, last build status, dirty flag).
- **No `--quiet` flag for extract** — the doubled "Missing text" lines plus a noisy stderr made it hard to spot the actually-important info. A `--quiet` (errors only) and a `--json` (machine output, no progress) would help when this runs from a wrapper script.
- **No CLI command to mark `needs_review` as `deferred` from the command line.** I had a clean use case — "this annotation was already applied in commit 1150473, just defer it" — but the path through the mapping UI (broken anyway) is heavy-handed. `review-pdf set-status --annotation-id ann-X --status deferred --reason "already-applied-by-prior-edit"` should work *before* mapping is resolved, OR `override-mapping` should accept `--status deferred` as a shortcut. The status-transition table (spec §10.3) may currently disallow `needs_review → deferred`.
- **The skill mentions a `--mapping-mode` flag on `serve` but doesn't say what shape the UI takes** — turns out we never got to find out. When the viewer is fixed, a short paragraph in the skill on what mapping-mode looks like (a list view? a flow with candidates?) would help.
- **Skill doesn't mention venv** — modern macOS / Homebrew Python is externally-managed (PEP 668). The bare `pip install -e ~/PycharmProjects/review-pdf-to-latex` will fail without a venv. Suggest:

  ```bash
  python3 -m venv ~/PycharmProjects/review-pdf-to-latex/.venv
  ~/PycharmProjects/review-pdf-to-latex/.venv/bin/pip install -e ~/PycharmProjects/review-pdf-to-latex
  # then either alias or symlink the venv's review-pdf into PATH
  ```

## Quantitative observations

### Mapping confidence histogram (n=31 resolved)

| bucket | count |
|---|---|
| 0.95–1.00 | 15 |
| 0.80–0.94 | 8 |
| 0.60–0.79 | 5 |
| 0.40–0.59 | 3 |
| <0.40 | 0 |

### `needs_review` distribution (n=9)

All 9 have `method=failed`, `confidence=0.0`, `latex_file=null`, `highlighted_text=""`. 8 are pdfannots extraction failures (page 2/4/5/6×2/7×2/8); 1 is a true sticky note with no underlying highlight (ann-003).

### Timing

| step | wall time |
|---|---|
| `pip install -e .` (cold venv) | ~12s |
| `review-pdf extract` (40 annotations, 10-page PDF, 10 page PNG renders @ pdftoppm) | 3.87s |
| Viewer startup → first failed GET | <1s |
| Phase 1 build budget — *not measured, blocked* | — |

### Files / state on disk

```
.review-state/
  annotations.json      15302 bytes
  mapping.json           9241 bytes
  state.json            11635 bytes
  pages/                10 PNGs
```

`state-events.jsonl` not yet present (no clicks recorded).

## Path forward (suggested order)

1. **Fix the viewer render context** (BLOCKER #1). Until this lands, the four-phase workflow is incomplete. Probably the cheapest test to add alongside is a smoke test: `GET /` returns 200 against a fixture project.
2. **Move or duplicate `--project-dir` to subcommand parsers** (BUG #2). One-line argparse change. Or update the skill — but the CLI behavior is the more discoverable surface.
3. **Broaden / configure the SURFACE trigger** (BUG #4). Cheap, high human-experience payoff.
4. **Empty-`before_text` handling** (BUG #5). Engine-level decision: surface-route them, or carry the `before_text` requirement into apply.
5. **`needs_review → deferred` CLI shortcut** (UX item). One CLI command extension.
6. **Preflight on PDF + dedupe pdfannots calls** (BUG #6 + #3). Quality-of-life.

## Resumption notes

When the viewer is fixed and AJB wants to retry against the same project:

1. The COTA project still has `.review-state/` from this run. `review-pdf --project-dir ... status` will report `phase: 0-setup` with 31 pending / 9 needs_review.
2. The stash `stash@{0}` contains the three pre-run-dirty files. After the run completes, `git stash pop` to restore them.
3. If a fresh extract is wanted, `review-pdf --project-dir ... extract --pdf ... --force` blows away `.review-state/` and starts over.
4. The viewer fix can be tested directly on this project without a fresh extract.

## Open question for AJB

Two pre-existing dirty files (`advising_investment.tex`, `appendix.tex`) were stashed at the start of this run. They predate the v2.0 review pass — `git log` doesn't show them touched in `1150473`. Want me to surface their diffs in a follow-up? They may or may not be relevant to the next pass.
