"""Phase 0 (`extract`) pipeline: PDF -> annotations.json, mapping.json, state.json, pages/.

The functions in this module are wired together by `cli.py`'s `extract` handler
(Task 4.7). Each function is independently tested.
"""

from __future__ import annotations

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
