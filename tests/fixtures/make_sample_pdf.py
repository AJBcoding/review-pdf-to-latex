"""One-off generator for tests/fixtures/sample-annotated.pdf.

Run from repo root:
    .venv/bin/python tests/fixtures/make_sample_pdf.py

Requires `reportlab` and `pypdf` in the venv (dev-only, not declared in
pyproject.toml). Produces a 1-page PDF with two highlight annotations:

  - "The College of the Arts experienced a substantial increase" with comment
    "claude surface this" (trigger match).
  - "Quantitative items were analyzed" with comment "tighten the prose"
    (non-trigger).

The PDF is committed to the repo as a binary fixture. This script is kept
for reproducibility but is NOT invoked by tests.
"""

from __future__ import annotations

from pathlib import Path

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Highlight
from pypdf.generic import (
    ArrayObject,
    DictionaryObject,
    FloatObject,
    NameObject,
    NumberObject,
    TextStringObject,
)
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


HERE = Path(__file__).parent
RAW_PDF = HERE / "_sample-raw.pdf"
OUT_PDF = HERE / "sample-annotated.pdf"


# Lines in document order; index = approx y position from top.
LINES = [
    "Introduction",
    "The College of the Arts experienced a substantial increase",
    "in enrollment between 2019 and 2024.",
    "",
    "Methods",
    "Quantitative items were analyzed using descriptive statistics.",
]

# (line_idx, text-to-highlight-prefix, comment)
HIGHLIGHTS = [
    (1, "The College of the Arts experienced a substantial increase", "claude surface this"),
    (5, "Quantitative items were analyzed", "tighten the prose"),
]


def build_raw_pdf() -> None:
    c = canvas.Canvas(str(RAW_PDF), pagesize=letter)
    c.setFont("Helvetica", 12)
    page_height = letter[1]
    x = 72.0
    line_h = 18.0
    y_top = page_height - 72.0
    for i, line in enumerate(LINES):
        c.drawString(x, y_top - i * line_h, line)
    c.showPage()
    c.save()


def add_highlights() -> None:
    reader = PdfReader(str(RAW_PDF))
    writer = PdfWriter()
    writer.append_pages_from_reader(reader)

    page = writer.pages[0]
    page_height = float(letter[1])
    line_h = 18.0
    y_top = page_height - 72.0
    x = 72.0
    char_w = 6.5  # approximate width for Helvetica 12pt

    for line_idx, prefix, comment in HIGHLIGHTS:
        text_width = len(prefix) * char_w
        y_center = y_top - line_idx * line_h
        y0 = y_center - 4
        y1 = y_center + 12
        x0 = x
        x1 = x + text_width
        # Build the Highlight annotation dict by hand.
        quad_points = ArrayObject(
            [
                FloatObject(x0),
                FloatObject(y1),
                FloatObject(x1),
                FloatObject(y1),
                FloatObject(x0),
                FloatObject(y0),
                FloatObject(x1),
                FloatObject(y0),
            ]
        )
        rect = ArrayObject(
            [FloatObject(x0), FloatObject(y0), FloatObject(x1), FloatObject(y1)]
        )
        ann = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Annot"),
                NameObject("/Subtype"): NameObject("/Highlight"),
                NameObject("/Rect"): rect,
                NameObject("/QuadPoints"): quad_points,
                NameObject("/Contents"): TextStringObject(comment),
                NameObject("/T"): TextStringObject("test-author"),
                NameObject("/F"): NumberObject(4),
                NameObject("/C"): ArrayObject(
                    [FloatObject(1.0), FloatObject(1.0), FloatObject(0.0)]
                ),
            }
        )
        writer.add_annotation(page_number=0, annotation=ann)

    with OUT_PDF.open("wb") as fh:
        writer.write(fh)


def main() -> None:
    build_raw_pdf()
    add_highlights()
    RAW_PDF.unlink(missing_ok=True)
    print(f"wrote {OUT_PDF} ({OUT_PDF.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
