"""Phase 0 (`extract`) pipeline: PDF -> annotations.json, mapping.json, state.json, pages/.

The functions in this module are wired together by `cli.py`'s `extract` handler
(Task 4.7). Each function is independently tested.
"""

from __future__ import annotations

import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path

import pdfannots
from rapidfuzz import fuzz

from review_pdf_to_latex.state import (
    Annotation,
    AnnotationState,
    Mapping,
    MappingCandidate,
    StateFile,
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


def _bbox_recover_text(
    plumb_pdf, page_index: int, bbox: tuple[float, float, float, float]
) -> str:
    """Extract text from a page region by cropping with pdfplumber.

    Used as a fallback when ``pdfannots.gettext()`` returns empty for a
    Highlight annotation — common for re-saved PDFs and "RESTORED" PDFs
    where annotations were re-injected from a corrupted source, so the
    annotation's quad points no longer line up with the page's text run
    even though the underlying text is intact.

    ``bbox`` is in pdfannots' PDF-coordinate frame: (left, bottom, right, top)
    with origin at the page's bottom-left. pdfplumber uses (x0, top, x1, bottom)
    with origin at the top-left, so we flip ``y`` against page height.

    Returns the recovered text (stripped), or ``""`` if the crop is empty,
    bbox is degenerate, or pdfplumber raises.
    """
    left, bottom, right, top = bbox
    if right - left <= 0 or top - bottom <= 0:
        return ""
    try:
        page = plumb_pdf.pages[page_index]
        crop = page.within_bbox(
            (left, page.height - top, right, page.height - bottom)
        )
        text = crop.extract_text() or ""
    except Exception:  # noqa: BLE001 — recovery is best-effort by design
        return ""
    return text.strip()


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
    crop via pdfplumber so the highlighted text is preserved. Sticky-note
    annotations with no underlying highlight remain ``highlighted_text == ""``
    — there is no text to recover. See rev-fv6.

    Args:
        pdf_path: Absolute or relative path to an annotated PDF.
        trigger_phrase: SURFACE trigger phrase (default
            :data:`DEFAULT_SURFACE_TRIGGER`).

    Returns:
        List of Annotation dataclasses in document order. May be empty.

    Raises:
        FileNotFoundError: pdf_path does not exist.
        RuntimeError: pdfannots failed to parse the PDF.
    """
    import pdfplumber

    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    try:
        with pdf_path.open("rb") as fh:
            doc = pdfannots.process_file(fh, emit_progress_to=None)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"pdfannots failed to parse {pdf_path}: {exc}") from exc

    annotations: list[Annotation] = []
    counter = 0
    # Open the PDF once for the lifetime of the loop so we don't pay the
    # pdfplumber open cost per annotation.
    with pdfplumber.open(str(pdf_path)) as plumb:
        for page in doc.pages:
            page_number = page.pageno + 1
            for raw in page.annots:
                counter += 1
                highlighted_text = (raw.gettext() or "").strip()
                comment = (raw.contents or "").strip()
                author = (getattr(raw, "author", None) or "anonymous").strip() or "anonymous"
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

                # Bbox fallback for Highlight annotations whose quad points
                # no longer link to the page text run.
                if not highlighted_text and bbox != (0.0, 0.0, 0.0, 0.0):
                    highlighted_text = _bbox_recover_text(
                        plumb, page.pageno, bbox
                    )

                annotations.append(
                    Annotation(
                        id=f"ann-{counter:03d}",
                        page=page_number,
                        bbox=bbox,
                        highlighted_text=highlighted_text,
                        author=author,
                        comment=comment,
                        created=_format_created(getattr(raw, "created", None)),
                        trigger_match=is_trigger(comment, trigger_phrase),
                    )
                )

    return annotations


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


def _enumerate_tex_files(
    root: Path,
    exclude: list[str],
) -> list[Path]:
    """Return all `.tex` files under root, skipping any path component in exclude.

    `exclude` entries are matched as path *prefixes* relative to `root`
    (e.g., "build/" excludes everything under `<root>/build/`).
    """
    norm_exclude = [e.rstrip("/") for e in exclude]
    out: list[Path] = []
    for path in sorted(root.rglob("*.tex")):
        rel = path.relative_to(root).as_posix()
        if any(rel == e or rel.startswith(e + "/") for e in norm_exclude):
            continue
        out.append(path)
    return out


def fuzzy_map(
    annotation: Annotation,
    latex_root: Path,
    exclude: list[str] | None = None,
) -> Mapping:
    """Map an annotation's highlighted_text to a (file, line_range) in latex_root.

    Implements spec §12.1: sliding window of consecutive lines whose total
    character count is at most 2x the length of normalized highlighted_text;
    window slides one line at a time; score = rapidfuzz.partial_ratio / 100.

    Thresholds:
      score >= 0.5  -> fuzzy_text, needs_review=False
      0.2 <= score  -> fuzzy_text, needs_review=True, candidates populated
      score < 0.2   -> failed, latex_file=None, line_range=None, candidates=[]

    Args:
        annotation: The Annotation to map.
        latex_root: Project root to search for .tex files.
        exclude: Path prefixes (relative to latex_root) to skip. Defaults to
            ["build/", ".review-state/"].

    Returns:
        A Mapping. `needs_review` is True for any score < 0.5.
    """
    if exclude is None:
        exclude = ["build/", ".review-state/"]
    latex_root = Path(latex_root)

    target_raw = annotation.highlighted_text or ""
    target = _normalize(target_raw)
    target_len = len(target)
    if target_len == 0:
        return Mapping(
            latex_file=None,
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

    for path in _enumerate_tex_files(latex_root, exclude):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        if not lines:
            continue

        rel = path.relative_to(latex_root).as_posix()
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
                window_norm = _normalize(_strip_latex(window_raw))
                if not window_norm:
                    continue
                score = fuzz.partial_ratio(target, window_norm) / 100.0
                all_windows.append((score, rel, (start + 1, end + 1)))
                if cum_chars >= max_window_chars:
                    break

    if not all_windows:
        return Mapping(
            latex_file=None,
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
            latex_file=best_file,
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
            latex_file=None,
            line_range=None,
            confidence=float(best_score),
            method="failed",
            needs_review=True,
            candidates=[],
        )

    # 0.2 <= best_score < 0.5
    return Mapping(
        latex_file=best_file,
        line_range=best_range,
        confidence=float(best_score),
        method="fuzzy_text",
        needs_review=True,
        candidates=candidates,
    )


def bootstrap_state(
    annotations: list[Annotation],
    mappings: dict[str, Mapping],
) -> StateFile:
    """Build the initial state.json contents for a freshly-extracted project.

    Phase is "0-setup"; order is "mechanical-first"; no current annotation;
    no builds yet. Per-annotation status is "needs_review" when the mapping
    requires review, otherwise "pending". All other annotation fields are
    None (no text captured, no build yet).

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
        ann_states[ann.id] = AnnotationState(
            status="needs_review" if needs_review else "pending",
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
        schema_version=1,
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
import sys
from importlib import metadata as _metadata


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
) -> int:
    """Execute the full Phase 0 pipeline. Returns a CLI exit code.

    Trigger precedence (highest first): explicit ``surface_trigger`` arg
    → ``.review-config.toml``'s ``surface_trigger`` key →
    :data:`DEFAULT_SURFACE_TRIGGER`.

    Exit codes (per spec §8 extract row):
        0  ok
        2  pdf missing
        3  existing state without --force
        4  pdfannots failed to parse the PDF (or page rendering failed)
    """
    from review_pdf_to_latex.state import atomic_write_json  # local to avoid cycle

    pdf_path = Path(pdf_path)
    project_dir = Path(project_dir)

    if not pdf_path.exists():
        print(f"error: PDF not found: {pdf_path}", file=sys.stderr)
        return 2

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
        return 3

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
        print(f"error: pdfannots failed: {exc}", file=sys.stderr)
        return 4

    # 2. Render pages.
    try:
        render_pages(pdf_path, pages_dir)
    except RuntimeError as exc:
        print(f"error: page rendering failed: {exc}", file=sys.stderr)
        return 4

    # 3. Fuzzy-map every annotation.
    mappings: dict[str, Mapping] = {}
    for ann in annotations:
        mappings[ann.id] = fuzzy_map(ann, project_dir)

    # 4. Bootstrap state.
    state = bootstrap_state(annotations, mappings)

    # 5. Write annotations.json (immutable; spec §7.1).
    annotations_doc = {
        "schema_version": 1,
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
        "schema_version": 1,
        "mappings": {ann_id: m.to_dict() for ann_id, m in mappings.items()},
    }
    atomic_write_json(mapping_path, mapping_doc)

    # 7. Write initial state.json (spec §7.3).
    atomic_write_json(state_path, state.to_dict())

    # 8. Patch .gitignore.
    ensure_gitignore_entry(project_dir, entry=".review-state/")

    return 0
