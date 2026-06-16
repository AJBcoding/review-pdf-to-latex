"""Phase 0 (`extract`) pipeline: PDF -> annotations.json, mapping.json, state.json, pages/.

The functions in this module are wired together by `cli.py`'s `extract` handler
(Task 4.7). Each function is independently tested.
"""

from __future__ import annotations

import logging
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

import pdfannots
from rapidfuzz import fuzz

from review_pdf_to_latex.exit_codes import (
    EXIT_EXISTING_STATE,
    EXIT_MISSING_PDF,
    EXIT_OK,
    EXIT_PDFANNOTS_FAILED,
)
from review_pdf_to_latex.state import (
    SUPPORTED_SCHEMA,
    Annotation,
    AnnotationState,
    Mapping,
    MappingCandidate,
    StateFile,
    Status,
)


def _format_created(raw: object) -> str | None:
    """Coerce pdfannots' `created` value into an ISO8601 string or None.

    pdfannots returns a `datetime` (sometimes tz-naive) or None. We normalize
    to UTC ISO8601 with a trailing 'Z' so the JSON output is unambiguous.
    """
    if raw is None:
        return None
    if isinstance(raw, datetime):
        dt = raw if raw.tzinfo is not None else raw.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    # Defensive: if pdfannots ever changes shape, stringify rather than crash.
    return str(raw)


DEFAULT_SURFACE_TRIGGER = "surface this"
"""Case-insensitive substring used to flag SURFACE-intent annotations.

Broadened from the legacy ``claude surface this`` after a real run found
reviewers writing ``Surface this``/``SURFACE THIS`` without the ``claude``
prefix (rev-is6). The legacy phrase still matches because it contains
``surface this`` as a substring. Per-project override via
``.review-config.toml``'s ``surface_trigger`` key; see
:func:`load_project_config`.
"""


def is_trigger(comment: str, trigger_phrase: str) -> bool:
    """Return True iff `trigger_phrase` appears in `comment` (case-insensitive substring).

    Per spec §7.1, the SURFACE trigger is a case-insensitive *substring* match,
    not a word-boundary match. Empty comment is always False.
    """
    if not comment or not trigger_phrase:
        return False
    return trigger_phrase.casefold() in comment.casefold()


def load_project_config(project_dir: Path) -> dict:
    """Read ``<project_dir>/.review-config.toml`` if present, else return {}.

    Currently recognized keys:

    - ``surface_trigger`` (str): override the case-insensitive substring used
      to flag SURFACE-intent annotations.

    Unknown keys are ignored. Parse errors silently degrade to ``{}`` so a
    broken config never blocks ``extract``; future work could surface a
    warning to stderr.
    """
    import tomllib

    config_path = Path(project_dir) / ".review-config.toml"
    if not config_path.exists():
        return {}
    try:
        with config_path.open("rb") as f:
            return tomllib.load(f)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


class _DedupePdfannotsWarnings(logging.Filter):
    """Drop duplicate 'pdfannots' warnings within a single extract pass.

    pdfannots calls ``Annotation.gettext()`` once during ``process_file``
    (inside ``Annotation.resolve()``, to deduplicate Skim-style ``contents``
    that equal the highlighted text — see pdfannots ``types.py``) and our
    per-annotation loop calls it again. Both invocations emit
    ``Missing text for ... annotation at ...`` for the same annotation,
    doubling the warning count on real review PDFs (rev-fpe).
    """

    def __init__(self) -> None:
        super().__init__()
        self._seen: set[str] = set()

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if msg in self._seen:
            return False
        self._seen.add(msg)
        return True


def _bbox_recover_text(
    plumb_pdf, page_index: int, bbox: tuple[float, float, float, float]
) -> str:
    """Extract text from a page region by cropping with pdfplumber.

    Used as a fallback when ``pdfannots.gettext()`` returns empty for a
    Highlight annotation — common for re-saved PDFs and "RESTORED" PDFs
    where annotations were re-injected from a corrupted source, so the
    annotation's quad points no longer line up with the page's text run
    even though the underlying text is intact.

    Uses ``page.crop`` (intersection semantics) rather than
    ``page.within_bbox`` (strict containment). Tight-fitting annotation
    rectangles never fully contain a character's bounding box — character
    glyphs leak above/below the visible highlight by a pixel or two — so
    ``within_bbox`` returns empty for ~every real annotation regardless
    of ``strict=False``. ``crop`` returns any character whose box overlaps
    the region, which is what we want for "what text was highlighted?".

    ``bbox`` is in pdfannots' PDF-coordinate frame: (left, bottom, right, top)
    with origin at the page's bottom-left. pdfplumber uses (x0, top, x1, bottom)
    with origin at the top-left, so we flip ``y`` against page height.

    A small minority of PDFs (or pdfannots variants) report bbox in the
    top-left frame already; for those the flipped crop falls in dead space.
    If the flipped crop is empty, we fall back to the raw bbox — costs one
    extra crop but converts misses into hits.

    Returns the recovered text (stripped), or ``""`` if both crops are
    empty, the bbox is degenerate, or pdfplumber raises.
    """
    left, bottom, right, top = bbox
    if right - left <= 0 or top - bottom <= 0:
        return ""
    try:
        page = plumb_pdf.pages[page_index]
        flipped = (left, page.height - top, right, page.height - bottom)
        text = (page.crop(flipped).extract_text() or "").strip()
        if text:
            return text
        # Some PDFs disagree on the y-axis origin; try the raw bbox.
        return (page.crop((left, bottom, right, top)).extract_text() or "").strip()
    except Exception:  # noqa: BLE001 — recovery is best-effort by design
        return ""


_STICKY_ASSOC_DISTANCE_PT = 72.0
"""Max bbox-center distance (PDF points, ~1 inch) for sticky→highlight association.

Acrobat's sticky-note glyph is ~16pt and reviewers click slightly off the
highlighted text, so 72pt (≈1in, ~4 lines at 12pt) is generous enough to
catch typical free-floating notes without bleeding across paragraphs. See
rev-9m5.
"""

_STICKY_ASSOC_RUNNER_UP_RATIO = 1.5
"""Nearest highlight wins only if runner-up is at least this many times as far.

Keeps the merge unambiguous: if two highlights are roughly equidistant from
the sticky, we leave it alone and let the manual-mapping UI resolve it.
"""


def _associate_sticky_notes(
    annotations: list[Annotation],
    subtypes_by_id: dict[str, str],
    *,
    distance_threshold_pt: float = _STICKY_ASSOC_DISTANCE_PT,
    runner_up_ratio: float = _STICKY_ASSOC_RUNNER_UP_RATIO,
) -> None:
    """Copy ``highlighted_text`` from the nearest Highlight onto each free-floating sticky.

    A sticky note (subtype ``Text``) without ``highlighted_text`` carries the
    reviewer's comment but no anchor text — :func:`fuzzy_map` has nothing to
    match against and the annotation drops into ``needs_review``. When Acrobat
    is used in "highlight then comment" mode the comment lands on a separate
    Text annotation right next to the Highlight, so we can recover the lost
    anchor by spatial proximity.

    For each Text annotation with empty ``highlighted_text``:

    1. Find Highlight annotations on the same page with non-empty
       ``highlighted_text`` (the standalone-Highlight side of the pair).
    2. Compute bbox-center Euclidean distance to each candidate.
    3. If the nearest is within ``distance_threshold_pt`` AND the runner-up
       is at least ``runner_up_ratio`` times farther (or there is no runner-up),
       copy the winner's ``highlighted_text`` onto the sticky.
    4. Otherwise leave the sticky untouched (the manual-mapping UI handles
       ambiguous cases).

    Mutates ``annotations`` in place. The Highlight annotation is left
    untouched — both annotations remain in the list with their original
    bboxes; only the sticky gains an anchor. See rev-9m5.

    Args:
        annotations: The list returned by :func:`read_annotations`.
        subtypes_by_id: Map of annotation id → pdfannots subtype name
            (``"Text"`` / ``"Highlight"`` / ``...``). Captured during the
            read loop because :class:`Annotation` does not carry subtype.
    """
    highlights_by_page: dict[int, list[Annotation]] = {}
    for ann in annotations:
        if subtypes_by_id.get(ann.id) == "Highlight" and ann.highlighted_text:
            highlights_by_page.setdefault(ann.page, []).append(ann)

    for sticky in annotations:
        if subtypes_by_id.get(sticky.id) != "Text":
            continue
        if sticky.highlighted_text:
            continue
        candidates = highlights_by_page.get(sticky.page)
        if not candidates:
            continue

        sticky_cx = (sticky.bbox[0] + sticky.bbox[2]) / 2
        sticky_cy = (sticky.bbox[1] + sticky.bbox[3]) / 2
        distances: list[tuple[float, Annotation]] = []
        for hl in candidates:
            hl_cx = (hl.bbox[0] + hl.bbox[2]) / 2
            hl_cy = (hl.bbox[1] + hl.bbox[3]) / 2
            d = ((sticky_cx - hl_cx) ** 2 + (sticky_cy - hl_cy) ** 2) ** 0.5
            distances.append((d, hl))
        distances.sort(key=lambda t: t[0])

        nearest_d, nearest = distances[0]
        if nearest_d > distance_threshold_pt:
            continue
        if len(distances) >= 2:
            runner_up_d = distances[1][0]
            # Guard nearest_d == 0 (sticky exactly on a highlight center):
            # treat as unambiguous winner regardless of runner-up.
            if nearest_d > 0 and runner_up_d < runner_up_ratio * nearest_d:
                continue

        sticky.highlighted_text = nearest.highlighted_text


def read_annotations(
    pdf_path: Path,
    trigger_phrase: str = DEFAULT_SURFACE_TRIGGER,
) -> list[Annotation]:
    """Parse PDF highlight annotations into a list of Annotation dataclasses.

    Uses pdfannots' Python API (not the CLI). Each annotation gets a sequential
    zero-padded id `ann-001`, `ann-002`, ... in document order. `trigger_match`
    is True iff the annotation's comment contains `trigger_phrase`
    (case-insensitive substring).

    When ``pdfannots.gettext()`` returns empty for a Highlight (e.g. a
    "RESTORED" PDF where re-injected annotation quad points no longer align
    with the page's text run), this function falls back to a bbox-region
    crop via pdfplumber so the highlighted text is preserved. See rev-fv6.

    After the per-annotation loop, runs a spatial-association pass
    (:func:`_associate_sticky_notes`) so a sticky-note Text annotation that
    sits next to a standalone Highlight inherits the Highlight's anchor text.
    This recovers the reviewer's intent when Acrobat splits "highlight a
    region" and "write a comment" into two separate annotations. See rev-9m5.

    Args:
        pdf_path: Absolute or relative path to an annotated PDF.
        trigger_phrase: SURFACE trigger phrase (default
            :data:`DEFAULT_SURFACE_TRIGGER`).

    Returns:
        List of Annotation dataclasses in document order. May be empty.

    Raises:
        FileNotFoundError: pdf_path does not exist.
        RuntimeError: pdfannots failed to parse the PDF or one of its
            annotations. The message includes guidance on recovering from
            a structurally-corrupt PDF (rev-ze1).
    """
    import pdfplumber

    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    # pdfannots raises bare AssertionError (subclass of Exception) from corrupt
    # content streams. We catch broadly here and again around the per-annotation
    # loop body because the failure point varies: structurally-broken PDFs fail
    # in process_file, while individual broken annotations fail in raw.gettext()
    # or raw.boxes access. Both paths surface the same user-facing guidance.
    pdfannots_logger = logging.getLogger("pdfannots")
    dedupe_filter = _DedupePdfannotsWarnings()
    pdfannots_logger.addFilter(dedupe_filter)
    try:
        try:
            with pdf_path.open("rb") as fh:
                doc = pdfannots.process_file(fh, emit_progress_to=None)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(_corrupt_pdf_message(pdf_path, exc)) from exc

        annotations: list[Annotation] = []
        subtypes_by_id: dict[str, str] = {}
        counter = 0
        # Open the PDF once for the lifetime of the loop so we don't pay the
        # pdfplumber open cost per annotation.
        with pdfplumber.open(str(pdf_path)) as plumb:
            for page in doc.pages:
                page_number = page.pageno + 1
                for raw in page.annots:
                    counter += 1
                    try:
                        highlighted_text = (raw.gettext() or "").strip()
                        comment = (raw.contents or "").strip()
                        author = (getattr(raw, "author", None) or "anonymous").strip() or "anonymous"
                        subtype_name = getattr(getattr(raw, "subtype", None), "name", "") or ""
                        if raw.boxes:
                            xs = [b.x0 for b in raw.boxes] + [b.x1 for b in raw.boxes]
                            ys = [b.y0 for b in raw.boxes] + [b.y1 for b in raw.boxes]
                            bbox: tuple[float, float, float, float] = (
                                float(min(xs)),
                                float(min(ys)),
                                float(max(xs)),
                                float(max(ys)),
                            )
                        else:
                            bbox = (0.0, 0.0, 0.0, 0.0)
                    except Exception as exc:  # noqa: BLE001
                        raise RuntimeError(
                            _corrupt_pdf_message(pdf_path, exc, page=page_number)
                        ) from exc

                    # Bbox fallback for Highlight annotations whose quad points
                    # no longer link to the page text run. Skip for Text/sticky
                    # subtypes: their bbox is a tiny click-point icon, not a
                    # region of source text, so any chars cropped from it would
                    # be stray neighbors that block the spatial-association
                    # pass below from firing.
                    if (
                        not highlighted_text
                        and bbox != (0.0, 0.0, 0.0, 0.0)
                        and subtype_name != "Text"
                    ):
                        highlighted_text = _bbox_recover_text(
                            plumb, page.pageno, bbox
                        )

                    ann_id = f"ann-{counter:03d}"
                    subtypes_by_id[ann_id] = subtype_name
                    # schema-v2 round-trip fields (rev-l2). All best-effort:
                    # `name` is the native /NM id; `in_reply_to` (resolved by
                    # pdfannots.postprocess) carries the parent annotation, whose
                    # /NM id we record in the same namespace as native_id.
                    native_id = getattr(raw, "name", None) or None
                    reply_parent = getattr(raw, "in_reply_to", None)
                    in_reply_to = getattr(reply_parent, "name", None) or None
                    annotations.append(
                        Annotation(
                            id=ann_id,
                            page=page_number,
                            bbox=bbox,
                            highlighted_text=highlighted_text,
                            author=author,
                            comment=comment,
                            created=_format_created(getattr(raw, "created", None)),
                            trigger_match=is_trigger(comment, trigger_phrase),
                            subtype=subtype_name or None,
                            native_id=native_id,
                            in_reply_to=in_reply_to,
                        )
                    )
    finally:
        pdfannots_logger.removeFilter(dedupe_filter)

    _associate_sticky_notes(annotations, subtypes_by_id)
    return annotations


def _corrupt_pdf_message(
    pdf_path: Path, exc: BaseException, page: int | None = None
) -> str:
    """Build the user-facing error string for a pdfannots parse failure.

    pdfannots raises bare ``AssertionError`` (often with no message) on
    structurally-corrupt PDFs — e.g., Adobe-edited files round-tripped through
    multiple tools. Surface the file, the failure location, and concrete
    recovery steps so the user knows what to try next instead of staring at
    ``ERROR: AssertionError:`` (rev-ze1).
    """
    exc_type = type(exc).__name__
    detail = str(exc).strip() or "(no message)"
    where = f" while reading page {page}" if page is not None else ""
    return (
        f"pdfannots failed to parse {pdf_path}{where}: {exc_type}: {detail}\n"
        "The PDF may have corrupted content streams (common after multiple "
        "Adobe/Preview round-trips).\n"
        "Try one of:\n"
        "  1. Re-save the PDF via Preview ('Export as PDF') or Acrobat "
        "('Save As Other > Optimized PDF')\n"
        "  2. Print to PDF, then re-apply highlight annotations onto the "
        "clean copy\n"
        "  3. Reconstruct annotations onto a fresh export from the source "
        "document"
    )


def render_pages(pdf_path: Path, out_dir: Path, dpi: int = 150) -> list[Path]:
    """Render every page of a PDF to a PNG in `out_dir`, named `page-N.png`.

    Shells out to `pdftoppm -r {dpi} -png {pdf_path} {out_dir}/page`. pdftoppm
    zero-pads filenames to the digit count of the total page count; this
    function renames them to drop the padding so that downstream code can
    address pages by 1-based index without knowing the total.

    Lazy cache (spec §15 Q9): if `out_dir` already contains at least one
    `page-N.png` AND every such PNG's mtime is >= the PDF's mtime, skip the
    subprocess and return the existing paths in order. The cache is
    invalidated whenever the PDF is re-saved (mtime advances).

    Args:
        pdf_path: Path to source PDF.
        out_dir: Directory to write PNGs into. Must already exist.
        dpi: Render resolution (default 150).

    Returns:
        List of resulting `Path` objects in page order (page 1 first).

    Raises:
        FileNotFoundError: pdf_path or out_dir missing.
        RuntimeError: pdftoppm exited non-zero (stderr captured in message).
    """
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    if not out_dir.is_dir():
        raise FileNotFoundError(f"output directory not found: {out_dir}")

    # Cache check: collect existing page-N.png files and compare mtimes.
    cache_pattern = re.compile(r"^page-(\d+)\.png$")
    existing: list[tuple[int, Path]] = []
    for entry in out_dir.iterdir():
        m = cache_pattern.match(entry.name)
        if m:
            existing.append((int(m.group(1)), entry))
    if existing:
        pdf_mtime = pdf_path.stat().st_mtime
        if all(p.stat().st_mtime >= pdf_mtime for _, p in existing):
            existing.sort(key=lambda t: t[0])
            return [p for _, p in existing]

    cmd = [
        "pdftoppm",
        "-r",
        str(dpi),
        "-png",
        str(pdf_path),
        str(out_dir / "page"),
    ]
    try:
        proc = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "pdftoppm binary not found on PATH; install Poppler"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"pdftoppm exited {exc.returncode}: {exc.stderr.strip() or exc.stdout.strip()}"
        ) from exc

    # Collect outputs. pdftoppm produces page-NN.png (zero-padded to total
    # digit count). Parse the numeric suffix and rename to page-N.png.
    # Reuse cache_pattern compiled at the top of the function.
    discovered: list[tuple[int, Path]] = []
    for entry in out_dir.iterdir():
        m = cache_pattern.match(entry.name)
        if m:
            discovered.append((int(m.group(1)), entry))
    if not discovered:
        raise RuntimeError(
            f"pdftoppm produced no PNG files in {out_dir} "
            f"(stdout={proc.stdout!r}, stderr={proc.stderr!r})"
        )

    discovered.sort(key=lambda t: t[0])
    renamed: list[Path] = []
    for n, padded_path in discovered:
        target = out_dir / f"page-{n}.png"
        if padded_path != target:
            padded_path.replace(target)
        renamed.append(target)
    return renamed


_LIGATURE_MAP = {
    "ﬁ": "fi",
    "ﬂ": "fl",
    "ﬀ": "ff",
    "ﬃ": "ffi",
    "ﬄ": "ffl",
}

_LATEX_CMD_RE = re.compile(r"\\[a-zA-Z@]+(\{[^}]*\})*", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Normalize text for fuzzy comparison: ligatures + whitespace collapse."""
    for src, dst in _LIGATURE_MAP.items():
        text = text.replace(src, dst)
    return _WHITESPACE_RE.sub(" ", text).strip()


def _strip_latex(text: str) -> str:
    """Strip LaTeX command tokens (e.g., \\section{...}) before scoring."""
    return _LATEX_CMD_RE.sub(" ", text)


def _strip_noop(text: str) -> str:
    """Identity strip — for formats with no markup to remove (rev-l2)."""
    return text


@dataclass(frozen=True)
class FormatProfile:
    """Per-source-format knobs for fuzzy mapping (rev-l2, spec D7 §7).

    The fuzzy resolver is format-agnostic except for exactly two points
    (REVIEW.md reusability note): which files to scan (``glob``) and how to
    strip markup before scoring (``strip``). Parameterizing them here lets the
    same engine map annotations into ``.tex``, ``.md``, ``.html``, … trees as
    the multi-format direction lands, without touching the windowing/scoring
    core. The LaTeX behavior is the default everywhere (:data:`LATEX_PROFILE`),
    so existing callers are unchanged.

    Fields:
        glob: ``rglob`` pattern selecting candidate source files (e.g.
            ``"*.tex"``, ``"*.md"``).
        strip: Callable applied to each window before fuzzy scoring, to remove
            format markup that would otherwise dilute the match.
    """

    glob: str
    strip: Callable[[str], str]


LATEX_PROFILE = FormatProfile(glob="*.tex", strip=_strip_latex)
"""Default mapping profile: scan ``*.tex`` and strip LaTeX command tokens."""


def _enumerate_files(
    root: Path,
    exclude: list[str],
    glob: str = LATEX_PROFILE.glob,
) -> list[Path]:
    """Return all files matching ``glob`` under root, skipping excluded prefixes.

    `exclude` entries are matched as path *prefixes* relative to `root`
    (e.g., "build/" excludes everything under `<root>/build/`).
    """
    norm_exclude = [e.rstrip("/") for e in exclude]
    out: list[Path] = []
    for path in sorted(root.rglob(glob)):
        rel = path.relative_to(root).as_posix()
        if any(rel == e or rel.startswith(e + "/") for e in norm_exclude):
            continue
        out.append(path)
    return out


@dataclass(frozen=True)
class WindowIndex:
    """Cached `.tex` tree contents for fuzzy mapping (rev-l12).

    `fuzzy_map` previously re-enumerated and re-read the entire .tex tree on
    every annotation. The scan (rglob + per-file read/decode) is independent of
    the annotation being mapped, so it is hoisted into this index, built once
    via :func:`build_window_index` and reused by :func:`resolve` for every
    annotation. The per-annotation windowing/scoring still happens in `resolve`
    because the window character budget depends on the target length.

    Fields:
        latex_root: The root the index was built against (resolved Path).
        files: ``(rel_posix_path, lines)`` for every readable, non-empty source
            file, in the same order `_enumerate_files` returns them.
        strip: The markup-strip callable for the format this index was built
            for (rev-l2). Carried on the index so :func:`resolve` strips the
            same way the files were globbed. Defaults to LaTeX stripping.
    """

    latex_root: Path
    files: tuple[tuple[str, tuple[str, ...]], ...]
    strip: Callable[[str], str] = LATEX_PROFILE.strip


def build_window_index(
    latex_root: Path,
    exclude: list[str] | None = None,
    profile: FormatProfile = LATEX_PROFILE,
) -> WindowIndex:
    """Read every source file under `latex_root` once for reuse across mappings.

    This is the annotation-independent half of fuzzy mapping (rev-l12): it
    performs the directory scan and file reads so that mapping a whole batch of
    annotations costs one tree read instead of one read per annotation. Pass the
    result to :func:`resolve`.

    Args:
        latex_root: Project root to search for source files.
        exclude: Path prefixes (relative to latex_root) to skip. Defaults to
            ["build/", ".review-state/"].
        profile: Per-format mapping knobs (rev-l2). Selects the file ``glob``
            and the markup ``strip`` recorded on the returned index. Defaults
            to :data:`LATEX_PROFILE` (``*.tex`` + LaTeX stripping).

    Returns:
        A :class:`WindowIndex` capturing each readable, non-empty source file's
        lines. Files that fail to read/decode or are empty are skipped, matching
        the prior `fuzzy_map` behavior.
    """
    if exclude is None:
        exclude = ["build/", ".review-state/"]
    latex_root = Path(latex_root)

    files: list[tuple[str, tuple[str, ...]]] = []
    for path in _enumerate_files(latex_root, exclude, profile.glob):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        if not lines:
            continue
        rel = path.relative_to(latex_root).as_posix()
        files.append((rel, tuple(lines)))
    return WindowIndex(latex_root=latex_root, files=tuple(files), strip=profile.strip)


def resolve(
    annotation: Annotation,
    index: WindowIndex,
) -> Mapping:
    """Map one annotation against a prebuilt :class:`WindowIndex` (rev-l12).

    Implements spec §12.1: sliding window of consecutive lines whose total
    character count is at most 2x the length of normalized highlighted_text;
    window slides one line at a time; score = rapidfuzz.partial_ratio / 100.

    Thresholds:
      score >= 0.5  -> fuzzy_text, needs_review=False
      0.2 <= score  -> fuzzy_text, needs_review=True, candidates populated
      score < 0.2   -> failed, file=None, line_range=None, candidates=[]

    Args:
        annotation: The Annotation to map.
        index: A :class:`WindowIndex` from :func:`build_window_index`.

    Returns:
        A Mapping. `needs_review` is True for any score < 0.5.
    """
    target_raw = annotation.highlighted_text or ""
    target = _normalize(target_raw)
    target_len = len(target)
    if target_len == 0:
        return Mapping(
            file=None,
            line_range=None,
            confidence=0.0,
            method="failed",
            needs_review=True,
            candidates=[],
        )

    max_window_chars = max(target_len * 2, 1)

    # Score every window in every file; track the global best and per-file best.
    # Each entry: (score, rel_path, (start, end))
    all_windows: list[tuple[float, str, tuple[int, int]]] = []

    for rel, lines in index.files:
        n = len(lines)

        # Sliding window: grow line-by-line up to max_window_chars; slide start
        # forward one line at a time.
        for start in range(n):
            cum_text: list[str] = []
            cum_chars = 0
            for end in range(start, n):
                line = lines[end]
                # +1 for the joining space between lines.
                addition_len = len(line) + (1 if cum_text else 0)
                if cum_chars + addition_len > max_window_chars and cum_text:
                    break
                cum_text.append(line)
                cum_chars += addition_len
                window_raw = " ".join(cum_text)
                window_norm = _normalize(index.strip(window_raw))
                if not window_norm:
                    continue
                score = fuzz.partial_ratio(target, window_norm) / 100.0
                all_windows.append((score, rel, (start + 1, end + 1)))
                if cum_chars >= max_window_chars:
                    break

    if not all_windows:
        return Mapping(
            file=None,
            line_range=None,
            confidence=0.0,
            method="failed",
            needs_review=True,
            candidates=[],
        )

    # Best overall window.
    all_windows.sort(key=lambda t: t[0], reverse=True)
    best_score, best_file, best_range = all_windows[0]

    if best_score >= 0.5:
        return Mapping(
            file=best_file,
            line_range=best_range,
            confidence=float(best_score),
            method="fuzzy_text",
            needs_review=False,
            candidates=[],
        )

    # Build top-3 candidate list: best window per file (so the user picks
    # between distinct locations, not three windows from the same file).
    best_per_file: dict[str, tuple[float, tuple[int, int]]] = {}
    for score, rel, rng in all_windows:
        existing = best_per_file.get(rel)
        if existing is None or score > existing[0]:
            best_per_file[rel] = (score, rng)
    ranked = sorted(
        best_per_file.items(), key=lambda kv: kv[1][0], reverse=True
    )[:3]
    candidates = [
        MappingCandidate(file=rel, line_range=rng, score=float(score))
        for rel, (score, rng) in ranked
    ]

    if best_score < 0.2:
        return Mapping(
            file=None,
            line_range=None,
            confidence=float(best_score),
            method="failed",
            needs_review=True,
            candidates=[],
        )

    # 0.2 <= best_score < 0.5
    return Mapping(
        file=best_file,
        line_range=best_range,
        confidence=float(best_score),
        method="fuzzy_text",
        needs_review=True,
        candidates=candidates,
    )


def fuzzy_map(
    annotation: Annotation,
    latex_root: Path,
    exclude: list[str] | None = None,
    profile: FormatProfile = LATEX_PROFILE,
) -> Mapping:
    """Map a single annotation to a (file, line_range) in `latex_root`.

    Thin wrapper that builds a one-shot :class:`WindowIndex` and resolves
    against it; preserved for callers mapping a single annotation. To map many
    annotations against the same tree, call :func:`build_window_index` once and
    :func:`resolve` per annotation to avoid re-reading the tree (rev-l12).

    ``profile`` selects the per-format glob + strip (rev-l2); defaults to
    :data:`LATEX_PROFILE`.
    """
    index = build_window_index(latex_root, exclude, profile)
    return resolve(annotation, index)


def bootstrap_state(
    annotations: list[Annotation],
    mappings: dict[str, Mapping],
) -> StateFile:
    """Build the initial state.json contents for a freshly-extracted project.

    Phase is "0-setup"; order is "mechanical-first"; no current annotation;
    no builds yet. All other annotation fields are None (no text captured,
    no build yet). Per-annotation initial status is one of:

    - ``surfaced_pending`` when ``highlighted_text == ""`` and ``trigger_match``
      is False (rev-mvd): pdfannots could not extract the source text run and
      bbox recovery also failed, so Phase 1's apply-revert-on-failure has
      nothing to anchor on. Routing these directly to Phase 2b lets the user
      and Claude resolve them via the SURFACE conversation loop instead of
      stranding them in ``needs_review`` after Phase 1 (where the viewer has
      no surface for "you'll need to type the intended edit text here").
      ``trigger_match`` annotations stay on the normal path so the SKILL's
      post-Phase-1 ``set-status surfaced_pending`` transition stays legal.
    - ``needs_review`` when the mapping requires review (and the empty-text
      bypass above does not apply).
    - ``pending`` otherwise.

    Args:
        annotations: The list returned by read_annotations.
        mappings: dict keyed by annotation id; produced by fuzzy_map.

    Returns:
        A StateFile suitable for atomic_write_json to the project's
        .review-state/state.json.
    """
    ann_states: dict[str, AnnotationState] = {}
    for ann in annotations:
        m = mappings.get(ann.id)
        needs_review = bool(m and m.needs_review)
        empty_highlighted = not (ann.highlighted_text or "").strip()
        if empty_highlighted and not ann.trigger_match:
            initial_status: Status = "surfaced_pending"
        elif needs_review:
            initial_status = "needs_review"
        else:
            initial_status = "pending"
        ann_states[ann.id] = AnnotationState(
            status=initial_status,
            before_text=None,
            proposed_text=None,
            applied_text=None,
            applied_at=None,
            last_build_id=None,
            surface_chat_log=None,
            failure_log_path=None,
            failure_edit_text=None,
        )

    return StateFile(
        schema_version=SUPPORTED_SCHEMA,
        phase="0-setup",
        order="mechanical-first",
        current_annotation_id=None,
        annotations=ann_states,
        builds=[],
    )


def ensure_gitignore_entry(
    project_root: Path,
    entry: str = ".review-state/",
) -> None:
    """Idempotently ensure `entry` is on its own line in `project_root/.gitignore`.

    Behavior:
        - No .gitignore exists: create one with a one-line header comment and
          the entry.
        - .gitignore exists, entry not present (line-exact, ignoring surrounding
          whitespace): append the entry on a new line.
        - .gitignore exists and entry is already present: do nothing (mtime
          preserved).

    Substring matches do not count — a commented-out line containing the entry
    does not block appending the literal entry.
    """
    project_root = Path(project_root)
    gi = project_root / ".gitignore"

    if not gi.exists():
        header = "# Local review-pdf-to-latex working state; do not commit.\n"
        gi.write_text(f"{header}{entry}\n", encoding="utf-8")
        return

    existing = gi.read_text(encoding="utf-8")
    lines = existing.splitlines()
    for line in lines:
        if line.strip() == entry:
            return  # already present, leave file (and mtime) untouched

    # Append. Preserve trailing-newline convention: if file ends with \n,
    # append "entry\n"; otherwise prepend a newline so the new entry stands
    # on its own line.
    if existing and not existing.endswith("\n"):
        new_text = existing + "\n" + entry + "\n"
    else:
        new_text = existing + entry + "\n"
    gi.write_text(new_text, encoding="utf-8")


# ---- Task 4.7: extract CLI orchestrator -------------------------------------

import hashlib
import json as _json
import logging as _logging
import sys
from importlib import metadata as _metadata


def _silence_pdfminer_noise() -> None:
    """Quiet pdfminer.six's chatty WARNING-level logs.

    pdfminer (via pdfplumber's bbox text recovery) emits warnings like
    "Cannot set gray non-stroke color" and "Could not find glyph for ..."
    for almost any non-trivial PDF. They are not actionable for our use
    case (we are extracting highlighted text, not faithfully rendering
    fonts), and on a real run they drowned out the real progress output.
    Bumping the package logger to ERROR is the standard fix.
    """
    for name in (
        "pdfminer",
        "pdfminer.pdfinterp",
        "pdfminer.pdfdocument",
        "pdfminer.pdffont",
        "pdfminer.pdfpage",
        "pdfminer.cmapdb",
        "pdfminer.converter",
        "pdfminer.psparser",
        "pdfplumber",
    ):
        _logging.getLogger(name).setLevel(_logging.ERROR)


def _compute_md5(path: Path) -> str:
    """Compute MD5 of a file. Used as ``source_pdf_md5`` per spec §7.1."""
    h = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _pdfannots_version() -> str:
    """Return e.g. 'pdfannots-0.4.1' for the ``extractor`` field in annotations.json."""
    try:
        return f"pdfannots-{_metadata.version('pdfannots')}"
    except _metadata.PackageNotFoundError:
        return "pdfannots-unknown"


def run_extract(
    pdf_path: Path,
    project_dir: Path,
    surface_trigger: str | None = None,
    force: bool = False,
    quiet: bool = False,
    json_output: bool = False,
) -> int:
    """Execute the full Phase 0 pipeline. Returns a CLI exit code.

    Trigger precedence (highest first): explicit ``surface_trigger`` arg
    → ``.review-config.toml``'s ``surface_trigger`` key →
    :data:`DEFAULT_SURFACE_TRIGGER`.

    ``quiet`` suppresses non-error stderr (currently only pdfminer noise,
    which is already silenced unconditionally — the flag exists so future
    verbose output respects it). ``json_output`` emits a one-line JSON
    summary on stdout when the run succeeds; mutually orthogonal to
    ``quiet``.

    Exit codes (per spec §8 extract row):
        0  ok
        2  pdf missing
        3  existing state without --force
        4  pdfannots failed to parse the PDF (or page rendering failed)
    """
    from review_pdf_to_latex.state import atomic_write_json  # local to avoid cycle

    _silence_pdfminer_noise()

    pdf_path = Path(pdf_path)
    project_dir = Path(project_dir)

    if not pdf_path.exists():
        print(f"error: PDF not found: {pdf_path}", file=sys.stderr)
        return EXIT_MISSING_PDF

    state_dir = project_dir / ".review-state"
    annotations_path = state_dir / "annotations.json"
    mapping_path = state_dir / "mapping.json"
    state_path = state_dir / "state.json"
    pages_dir = state_dir / "pages"

    if not force and any(
        p.exists() for p in (annotations_path, mapping_path, state_path)
    ):
        print(
            "error: .review-state/ already contains annotations.json, mapping.json, "
            "or state.json; pass --force to overwrite",
            file=sys.stderr,
        )
        return EXIT_EXISTING_STATE

    state_dir.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)

    # Resolve effective trigger: CLI arg > project config > default.
    effective_trigger = surface_trigger
    if effective_trigger is None:
        effective_trigger = load_project_config(project_dir).get(
            "surface_trigger", DEFAULT_SURFACE_TRIGGER
        )

    # 1. Read annotations.
    try:
        annotations = read_annotations(pdf_path, trigger_phrase=effective_trigger)
    except RuntimeError as exc:
        # read_annotations already formats a multi-line user-facing message
        # (see _corrupt_pdf_message); print it as-is rather than re-prefixing.
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_PDFANNOTS_FAILED

    # 2. Render pages.
    try:
        render_pages(pdf_path, pages_dir)
    except RuntimeError as exc:
        print(f"error: page rendering failed: {exc}", file=sys.stderr)
        return EXIT_PDFANNOTS_FAILED

    # 3. Fuzzy-map every annotation. Build the window index once (one read of
    #    the .tex tree) and resolve each annotation against it (rev-l12).
    window_index = build_window_index(project_dir)
    mappings: dict[str, Mapping] = {}
    for ann in annotations:
        mappings[ann.id] = resolve(ann, window_index)

    # 4. Bootstrap state.
    state = bootstrap_state(annotations, mappings)

    # 5. Write annotations.json (immutable; spec §7.1).
    annotations_doc = {
        "schema_version": SUPPORTED_SCHEMA,
        "source_pdf": str(pdf_path.resolve()),
        "source_pdf_md5": _compute_md5(pdf_path),
        "extracted_at": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "extractor": _pdfannots_version(),
        "annotations": [a.to_dict() for a in annotations],
    }
    atomic_write_json(annotations_path, annotations_doc)

    # 6. Write mapping.json (spec §7.2).
    mapping_doc = {
        "schema_version": SUPPORTED_SCHEMA,
        "mappings": {ann_id: m.to_dict() for ann_id, m in mappings.items()},
    }
    atomic_write_json(mapping_path, mapping_doc)

    # 7. Write initial state.json (spec §7.3).
    atomic_write_json(state_path, state.to_dict())

    # 8. Patch .gitignore.
    ensure_gitignore_entry(project_dir, entry=".review-state/")

    if json_output:
        summary = {
            "ok": True,
            "annotation_count": len(annotations),
            "needs_review": sum(
                1 for m in mappings.values() if m.needs_review
            ),
            "surfaced_pending": sum(
                1 for a in annotations if a.trigger_match
            ),
            "source_pdf_md5": annotations_doc["source_pdf_md5"],
        }
        sys.stdout.write(_json.dumps(summary, sort_keys=True) + "\n")
        sys.stdout.flush()
    elif not quiet:
        # Friendly one-line summary on stderr so it doesn't pollute pipes.
        n_total = len(annotations)
        n_nr = sum(1 for m in mappings.values() if m.needs_review)
        n_surf = sum(1 for a in annotations if a.trigger_match)
        print(
            f"extracted {n_total} annotation(s); {n_nr} needs_review, "
            f"{n_surf} surfaced_pending",
            file=sys.stderr,
        )

    return EXIT_OK
