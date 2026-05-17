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

from review_pdf_to_latex.state import Annotation


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


def is_trigger(comment: str, trigger_phrase: str) -> bool:
    """Return True iff `trigger_phrase` appears in `comment` (case-insensitive substring).

    Per spec §7.1, the SURFACE trigger is a case-insensitive *substring* match,
    not a word-boundary match. Empty comment is always False.
    """
    if not comment or not trigger_phrase:
        return False
    return trigger_phrase.casefold() in comment.casefold()


def read_annotations(
    pdf_path: Path,
    trigger_phrase: str = "claude surface this",
) -> list[Annotation]:
    """Parse PDF highlight annotations into a list of Annotation dataclasses.

    Uses pdfannots' Python API (not the CLI). Each annotation gets a sequential
    zero-padded id `ann-001`, `ann-002`, ... in document order. `trigger_match`
    is True iff the annotation's comment contains `trigger_phrase`
    (case-insensitive substring).

    Args:
        pdf_path: Absolute or relative path to an annotated PDF.
        trigger_phrase: SURFACE trigger phrase (default "claude surface this").

    Returns:
        List of Annotation dataclasses in document order. May be empty.

    Raises:
        FileNotFoundError: pdf_path does not exist.
        RuntimeError: pdfannots failed to parse the PDF.
    """
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
