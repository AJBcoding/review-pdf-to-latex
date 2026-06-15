"""PDF pre-flight health check (spec design-spec §8, ux-spec §5.2).

Walks a PDF page-by-page and emits a JSON report describing how well its
text layer can be extracted. The Electron renderer calls this at PDF-load
time to drive the §5.2 load-time banner ("⚠ this PDF appears partially
damaged: pages 3–10 contain no readable text…"). Headless callers can use
it for triage.

The detection heuristics were validated against the corrupted COTA PDF
during the 2026-05-20 PDF text-layer spike
(`docs/research/2026-05-20-pdf-text-layer-spike/README.md`). The documented
failure modes are:

* image-only / scanned (every page reports zero glyphs)
* partially-corrupted (some pages report zero glyphs)
* missing ToUnicode maps, total (extracted text is mostly ``(cid:NNN)``
  artifacts — the font has glyphs but no glyph→unicode mapping; pages
  marked unreadable)
* missing ToUnicode maps, ligatures only (extracted text has
  ligature-replacement spaces; pages stay readable but flagged)
* encrypted (open fails with password / encryption error)
* unparseable (open fails for any other reason)

Each maps to a distinct shape in the returned JSON.

Output JSON schema (v1)::

    {
      "schema_version": 1,
      "pdf_path": "/abs/path/to.pdf",
      "total_pages": int | None,
      "readable_pages": [int],          # 1-indexed; pages with usable text
      "unreadable_pages": [int],        # 1-indexed; no text, or CID-only, or errored
      "ligature_loss_detected": bool,   # any readable page's text trips the ligature heuristic
      "encrypted": bool,
      "producer": str | None,           # from document metadata
      "creator": str | None,            # ditto, useful for diagnostics
      "page_errors": [
        {"page": int, "error": str}     # one entry per unreadable page explaining why
      ],
      "error": str | None               # set when the whole document failed to open
    }

Exit codes::

    0   ok (report emitted; unreadable_pages may still be non-empty)
    2   PDF path missing or unreadable as a PDF at all
    21  PDF encrypted (partial report emitted with encrypted=true)

Code ``21`` is shared with the mutator family's ``EXIT_SOURCE_PDF_CHANGED`` by
deliberate per-subcommand namespace reuse — see ``exit_codes.py`` for why this
is not a collision. The constants below are single-sourced from that module.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any

import pdfplumber

from .exit_codes import EXIT_ENCRYPTED, EXIT_MISSING_PDF, EXIT_OK

# Local alias kept for readability at the call sites in this module; the value
# is single-sourced from exit_codes.py (spec §8 "2 pdf path missing").
EXIT_MISSING = EXIT_MISSING_PDF

SCHEMA_VERSION = 1

# Ligature-loss heuristic. When a PDF font dictionary is missing its ToUnicode
# entry for an ``fi`` / ``fl`` / ``ffi`` ligature glyph, every reader (poppler,
# pdfminer, PDF.js, Acrobat) falls back to a space — so ``verified`` extracts
# as ``veri ed``, ``efficient`` as ``e cient``, etc.
#
# These patterns are intentionally narrow English-stem matches rather than a
# generic ``\b\w+ \w+\b`` because the latter has too many false positives.
# Add more stems when real PDFs surface them.
_LIGATURE_PATTERNS: tuple[re.Pattern[str], ...] = tuple(
    re.compile(p, re.IGNORECASE)
    for p in (
        r"\bveri \w",     # verified, verify, verifies
        r"\bef ci",       # efficient, efficiency, efficacy-adjacent
        r"\bcon de",      # confidence, confide, confidential
        r"\bcon den",     # confident, confidently
        r"\bsigni \w",    # significant, significance
        r"\bde n\w",      # define, defined, definition
        r"\bof ce",       # office
        r"\bof cial",     # official
        r"\bsacri c",     # sacrifice, sacrificing
        r"\bre ect",      # reflect, reflection
        r"\bre ne",       # refine, refinement
        r"\b ll(ed|ing)?\b",  # filled, filling, fill
        r"\b\w+ci ent\b",     # efficient, sufficient (caught above too)
        r"\bsuf ci",      # sufficient, suffice
        r"\b oat",        # float, floating
    )
)


def detect_ligature_loss(text: str) -> bool:
    """Return True if `text` contains likely ligature-replacement spaces.

    The heuristic is conservative — it errs toward false negatives on weird
    inputs and toward false positives on text that legitimately contains the
    fragments (rare in normal English).
    """
    return any(p.search(text) for p in _LIGATURE_PATTERNS)


# Pattern matches PDF's "character ID" placeholders that pdfplumber / pdfminer
# emit when a font lacks a ToUnicode map — e.g. ``(cid:67)(cid:111)``. PDF.js
# applies a best-effort fallback to *some* unicode codepoint; pdfminer just
# passes the CID through as text. Either way the text is unusable to a reader.
_CID_PATTERN = re.compile(r"\(cid:\d+\)")

# Threshold above which a page is "CID-only" rather than partially readable.
# Empirical: the corrupted COTA PDF has pages 1–2 at ~100% CID density;
# clean LaTeX-built PDFs have 0%. A wide margin is safe.
_CID_DENSITY_UNREADABLE = 0.5


def cid_density(text: str) -> float:
    """Fraction of `text`'s characters that are inside ``(cid:NNN)`` placeholders.

    Returns 0.0 for empty input; 1.0 for fully CID-encoded text.
    """
    if not text:
        return 0.0
    cid_chars = sum(len(m.group(0)) for m in _CID_PATTERN.finditer(text))
    return cid_chars / len(text)


def _is_encryption_error(exc: BaseException) -> bool:
    """Best-effort match for encryption-related exceptions across pdfminer
    versions and pdfplumber wrappers.
    """
    msg = (str(exc) or type(exc).__name__).lower()
    return "encrypt" in msg or "password" in msg


def _build_empty_report(pdf_path: Path) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "pdf_path": str(pdf_path.resolve()) if pdf_path else None,
        "total_pages": None,
        "readable_pages": [],
        "unreadable_pages": [],
        "ligature_loss_detected": False,
        "encrypted": False,
        "producer": None,
        "creator": None,
        "page_errors": [],
        "error": None,
    }


def _normalize_metadata_str(value: Any) -> str | None:
    """PDF metadata values can be bytes, strings, or PDF-spec literals."""
    if value is None:
        return None
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8", errors="replace").strip() or None
        except Exception:
            return repr(value)
    return str(value).strip() or None


def health_check(pdf_path: Path) -> tuple[int, dict[str, Any]]:
    """Run the health check. Returns ``(exit_code, report_dict)``.

    Pure function — does not write to stdout or touch state. The CLI handler
    is responsible for serializing and printing.
    """
    report = _build_empty_report(pdf_path)

    if not pdf_path.exists():
        report["error"] = "file not found"
        return EXIT_MISSING, report
    if not pdf_path.is_file():
        report["error"] = "path is not a regular file"
        return EXIT_MISSING, report

    # Try to open the PDF. pdfplumber raises various exceptions depending on
    # the failure mode; we collapse the encryption case into its own exit code
    # and emit a partial report so the renderer can show a useful banner.
    try:
        pdf = pdfplumber.open(str(pdf_path))
    except Exception as exc:
        if _is_encryption_error(exc):
            report["encrypted"] = True
            report["error"] = f"encrypted: {exc}"
            return EXIT_ENCRYPTED, report
        report["error"] = f"failed to open PDF: {exc}"
        return EXIT_MISSING, report

    try:
        metadata = pdf.metadata or {}
        report["producer"] = _normalize_metadata_str(metadata.get("Producer"))
        report["creator"] = _normalize_metadata_str(metadata.get("Creator"))
        report["total_pages"] = len(pdf.pages)

        ligature_hit = False
        for idx, page in enumerate(pdf.pages, start=1):
            # Glyph-level probe first. Empty `chars` ⇔ no glyphs drawn at all
            # (image-only / scanned page, or a corrupted page that produced
            # no content stream output).
            try:
                chars = page.chars
            except Exception as exc:
                report["unreadable_pages"].append(idx)
                report["page_errors"].append({"page": idx, "error": f"{type(exc).__name__}: {exc}"})
                continue

            if not chars:
                report["unreadable_pages"].append(idx)
                report["page_errors"].append({"page": idx, "error": "no glyphs on page (image-only or content stream produced no text)"})
                continue

            # Extract text now (rather than after bucketing) so we can run
            # both the CID-density and ligature-loss heuristics on the same
            # string. Bail gracefully if extract_text itself raises.
            try:
                text = page.extract_text() or ""
            except Exception as exc:
                report["unreadable_pages"].append(idx)
                report["page_errors"].append({"page": idx, "error": f"extract_text failed: {type(exc).__name__}: {exc}"})
                continue

            # Total-ToUnicode-loss: every glyph came through as a (cid:N)
            # placeholder. The text is technically there but unusable for any
            # downstream reader/AI. Mark unreadable.
            density = cid_density(text)
            if density > _CID_DENSITY_UNREADABLE:
                report["unreadable_pages"].append(idx)
                report["page_errors"].append({
                    "page": idx,
                    "error": f"CID-encoded text without ToUnicode map ({density:.0%} of extracted text is (cid:NNN) artifacts)",
                })
                continue

            report["readable_pages"].append(idx)

            # Partial ligature loss — page is readable but flagged. Bail early
            # once any page trips it; one positive is enough for the banner.
            if not ligature_hit and text and detect_ligature_loss(text):
                ligature_hit = True

        report["ligature_loss_detected"] = ligature_hit
    finally:
        pdf.close()

    return EXIT_OK, report


def run_pdf_health(pdf_path: Path, *, stream=None) -> int:
    """CLI entry point. Serializes the report to ``stream`` (default stdout)
    and returns the exit code.
    """
    if stream is None:
        stream = sys.stdout
    exit_code, report = health_check(pdf_path)
    json.dump(report, stream, indent=2, sort_keys=True)
    stream.write("\n")
    return exit_code
