# Pass 1 — Ground-Truth Map Spot-Checks (2026-06-12)

All commands run from /Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex.
Map under test: docs/research/2026-06-12-ground-truth-map.md.

## Check 1 — Engine LOC total + per-file (map: 6,486 LOC, 14 files; server.py 1222, extract.py 972, apply.py 838, cli.py 832, state.py 662)

Command:
```
wc -l src/review_pdf_to_latex/*.py | sort -rn
```
Output:
```
    6486 total
    1222 src/review_pdf_to_latex/server.py
     972 src/review_pdf_to_latex/extract.py
     838 src/review_pdf_to_latex/apply.py
     832 src/review_pdf_to_latex/cli.py
     662 src/review_pdf_to_latex/state.py
     456 src/review_pdf_to_latex/terminal.py
     399 src/review_pdf_to_latex/build.py
     354 src/review_pdf_to_latex/commit.py
     262 src/review_pdf_to_latex/pdf_health.py
     251 src/review_pdf_to_latex/preview.py
     126 src/review_pdf_to_latex/status.py
      90 src/review_pdf_to_latex/migrate.py
      16 src/review_pdf_to_latex/__main__.py
       6 src/review_pdf_to_latex/__init__.py
```
**Result: CONFIRMED.** Total 6,486; 14 .py files; every per-file number in the map table matches exactly.

## Check 2 — Desktop key-file LOC (map: renderer/index.ts 2971, shared/types.ts 1008, main/index.ts 826, renderer/submit.ts 721, main/bundle.ts 302)

Command:
```
wc -l desktop/renderer/index.ts desktop/shared/types.ts desktop/main/index.ts desktop/renderer/submit.ts desktop/main/bundle.ts
```
Output:
```
    2971 desktop/renderer/index.ts
    1008 desktop/shared/types.ts
     826 desktop/main/index.ts
     721 desktop/renderer/submit.ts
     302 desktop/main/bundle.ts
    5828 total
```
**Result: CONFIRMED.** All five match the map exactly.

## Check 3 — Anchor-kind discriminator at shared/types.ts:168-170

Command:
```
sed -n '160,175p' desktop/shared/types.ts
```
Output (relevant span; lines 168-170 are the doc comment + type):
```
/** Anchor kind discriminator — determines which anchor strategy the sidecar's
 *  comments use. Existing sidecars without `anchor_kind` default to `'pdf-glyph-rect'`. */
export type AnchorKind = 'pdf-glyph-rect' | 'md-fuzzy-snippet';
```
**Result: CONFIRMED** for the claim `anchor_kind ∈ {pdf-glyph-rect, md-fuzzy-snippet}` at types.ts:168-170 (line 170 is the `export type AnchorKind` line). Note: the map's adjacent claim that HTML/DOCX reuse md-fuzzy-snippet with CSS-selector anchors is NOT literally on these lines — those lines only define the discriminator. The CSS-selector detail must be re-cited by Pass 4B if used.

## Check 4 — Viewer dispatch if/else on classifyPath at renderer/index.ts:769-779

Command:
```
sed -n '765,785p' desktop/renderer/index.ts
```
Output (relevant span):
```
async function openFileFromTreeOrPalette(path: string): Promise<void> {
  if (!viewerHandlesRef) return;
  const kind = classifyPath(path);
  if (kind === 'md') {
    await loadMarkdown(viewerHandlesRef, path);
  } else if (kind === 'html') {
    await loadHtml(viewerHandlesRef, path);
  } else if (kind === 'docx') {
    await loadDocx(viewerHandlesRef, path);
  } else {
    await loadPdf(viewerHandlesRef, path);
  }
}
```
`const kind = classifyPath(path);` sits at line 769; the if/else chain runs through line 779.
**Result: CONFIRMED.** If/else dispatch, no registry, at the cited lines.

## Check 5 — Duplicate AnnotationNotFoundError (map: apply.py:39 vs preview.py:158)

Command:
```
sed -n '35,43p' src/review_pdf_to_latex/apply.py; echo '---'; sed -n '154,162p' src/review_pdf_to_latex/preview.py
```
Output:
```
    exit_code: int = 1


class AnnotationNotFoundError(ApplyError):
    exit_code = 7


class MappingUnresolvedError(ApplyError):
---

from review_pdf_to_latex import state as _state


class AnnotationNotFoundError(Exception):
    """Raised when ``preview()`` is asked about an unknown annotation ID.

    CLI handler maps this to exit code 7 (``EXIT_ANNOTATION_NOT_FOUND``).
    """
```
**Result: CONFIRMED (off by 1 on one citation).** apply.py defines `class AnnotationNotFoundError(ApplyError)` at line 38 (map said 39 — that line is the class body `exit_code = 7`). preview.py:158 is exactly `class AnnotationNotFoundError(Exception):`. The duplication is real: two distinct classes, different bases (ApplyError vs Exception), same exit-code-7 semantics.

## Check 6 — Test inventory (map: Python 20 files / 8,648 LOC; desktop 7 vitest files)

Command:
```
ls tests/*.py | wc -l; wc -l tests/*.py | tail -1; find desktop -name '*.test.ts' -not -path '*/node_modules/*' -not -path '*/release/*' -not -path '*/out/*' | sort
```
Output:
```
      22
    8648 total
desktop/main/agent-pane-ipc.test.ts
desktop/main/sidecar-migration.test.ts
desktop/renderer/agent-pane/components/ContextMeter.test.ts
desktop/renderer/agent-pane/store.test.ts
desktop/renderer/agent-pane/timeline.test.ts
desktop/shared/agent-pane/adapter.test.ts
desktop/shared/md/anchors.test.ts
```
**Result: PARTIAL.** LOC matches exactly (8,648). Desktop vitest count matches (7 files). Python test FILE count is 22, not 20 — the map evidently excluded `tests/__init__.py` and `tests/conftest.py` (both present in `ls tests/*.py`). 20 is correct if counting only `test_*.py` files; phrase as "20 test files + conftest + __init__".

## Verdict

Ground-truth map is highly reliable: 5 of 6 checks confirmed exactly; 1 partial
(test file count semantics; one class-def citation off by one line). Trust it,
but re-open any line citation before quoting it in REVIEW.md.
