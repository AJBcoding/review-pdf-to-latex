"""Regenerate the e2e test fixtures.

Run this once per fixture change; commit the outputs. Tests do NOT
re-run this script -- they read the committed outputs directly.

Requirements:
  - pdflatex on PATH (TeX Live or MiKTeX).
  - pypdf >= 4.0 (`pip install pypdf`).

Usage:
  $ python tests/fixtures/make_e2e_fixtures.py

The script:
  1. Compiles ``e2e-sample-project/build/full_report.tex`` via pdflatex.
  2. Reads the resulting PDF and injects five highlight annotations
     plus comments using pypdf's AnnotationBuilder, producing
     ``e2e-annotated.pdf``.
  3. Writes ``E2E-EXPECTED.md`` and ``e2e-expected-hashes.txt`` describing the
     committed outputs.

The five annotations exercise distinct paths through the fuzzy mapper
and the trigger-phrase detector. See E2E-EXPECTED.md for the mapping table.

NOTE: This file produces a DIFFERENT set of fixtures from
``make_sample_pdf.py``. That file generates ``sample-annotated.pdf`` (a
simple 1-page PDF used by Task 4 fuzzy-mapping unit tests). The
fixtures here back the end-to-end smoke tests in ``test_e2e.py``: a
multi-file LaTeX project + a 5-annotation PDF that exercises one
fuzzy-mapping / trigger-phrase path per annotation. The two fixture
families coexist with disjoint file names; do NOT consolidate them.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import (
        ArrayObject,
        DictionaryObject,
        FloatObject,
        NameObject,
        NumberObject,
        TextStringObject,
    )
except ImportError as e:
    print(
        f"pypdf is required to regenerate fixtures: {e}\n"
        f"  pip install pypdf>=4.0",
        file=sys.stderr,
    )
    sys.exit(2)


FIXTURES = Path(__file__).parent
SAMPLE_PROJECT = FIXTURES / "e2e-sample-project"
BUILD_DIR = SAMPLE_PROJECT / "build"
TEMPLATES_DIR = SAMPLE_PROJECT / "templates"
COMPILED_PDF = BUILD_DIR / "full_report.pdf"
ANNOTATED_PDF = FIXTURES / "e2e-annotated.pdf"
EXPECTED_MD = FIXTURES / "E2E-EXPECTED.md"
HASHES_FILE = FIXTURES / "e2e-expected-hashes.txt"


# Annotation definitions. Each dict captures:
#   - id (matches what the fuzzy mapper will assign once extracted)
#   - page index (0-based for pypdf)
#   - bbox: [x1, y1, x2, y2] in PDF points; approximate
#   - highlighted_text: the literal selection
#   - comment: the commenter's note (may contain SURFACE trigger)
#   - notes: human-readable reason for fuzzy outcome
_ANNOTATIONS: list[dict[str, Any]] = [
    {
        "id": "ann-001",
        "page": 0,
        "bbox": [72, 538, 540, 549],
        "highlighted_text": (
            "The college experienced a substantial increase in undergraduate "
            "enrollment during the 2024--2025 academic year"
        ),
        "comment": "Tighten this.",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.8,
        "expect_needs_review": False,
        "expect_trigger_match": False,
    },
    {
        "id": "ann-002",
        "page": 0,
        "bbox": [72, 330, 540, 341],
        "highlighted_text": (
            "experienced a meaningful boost in completion rates "
            "across the studio majors"
        ),
        "comment": "Clarify the phrasing.",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.5,
        "expect_needs_review": False,
        "expect_trigger_match": False,
    },
    {
        "id": "ann-003",
        "page": 1,
        "bbox": [72, 669, 540, 680],
        "highlighted_text": (
            "twelve percent year-over-year growth in "
            "undergraduate enrollment"
        ),
        "comment": "claude surface this -- does the timeline match?",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.8,
        "expect_needs_review": False,
        "expect_trigger_match": True,
    },
    {
        "id": "ann-004",
        "page": 1,
        # Highlight is positioned over a tabular cell ("168") and on-PDF
        # text "168" is extracted. But the PDF is rendered in such a way
        # that pdfannots returns enough whitespace / structural artifacts
        # alongside the digit that fuzzy_map can't reach the >= 0.5
        # threshold against any single .tex window. needs_review=True.
        "bbox": [305, 629, 323, 639],
        "highlighted_text": "168",
        "comment": "Update this number.",
        "expect_method": "failed_or_low_score",
        "expect_confidence_min": 0.0,
        "expect_needs_review": True,
        "expect_trigger_match": False,
    },
    {
        "id": "ann-005",
        "page": 1,
        "bbox": [72, 588, 540, 599],
        "highlighted_text": (
            "Looking forward, the priorities for the coming year include "
            "sustaining the mid-semester"
        ),
        "comment": "Use 12% not approximately 12%.",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.8,
        "expect_needs_review": False,
        "expect_trigger_match": False,
    },
]


def _run_pdflatex() -> None:
    """Compile e2e-sample-project twice (cross-references).

    Sets SOURCE_DATE_EPOCH so pdflatex emits a deterministic /CreationDate
    and /ID -- otherwise the generated PDF MD5 drifts on every run, and
    the committed hash check in ``test_fixtures.py`` would constantly
    fail. The epoch (1700000000) is arbitrary but fixed.
    """
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    env = {**os.environ, "SOURCE_DATE_EPOCH": "1700000000"}
    for i in range(2):
        rc = subprocess.run(
            [
                "pdflatex",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "full_report.tex",
            ],
            cwd=str(BUILD_DIR),
            env=env,
        ).returncode
        if rc != 0:
            raise RuntimeError(f"pdflatex failed on pass {i+1}")


def _build_highlight_annotation(
    bbox: list[float],
    contents: str,
    author: str = "fixture-author",
) -> DictionaryObject:
    """Build a /Subtype /Highlight annotation dict from a bbox and comment.

    The `/Contents` carries the commenter's note (this is what pdfannots
    surfaces as ``annotation.comment``). The highlighted_text payload is
    embedded separately in `/Subj` so pdfannots can recover both halves
    of the annotation.
    """
    x1, y1, x2, y2 = bbox
    rect = ArrayObject(
        [FloatObject(x1), FloatObject(y1), FloatObject(x2), FloatObject(y2)]
    )
    quad_points = ArrayObject(
        [
            FloatObject(x1),
            FloatObject(y2),
            FloatObject(x2),
            FloatObject(y2),
            FloatObject(x1),
            FloatObject(y1),
            FloatObject(x2),
            FloatObject(y1),
        ]
    )
    return DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Annot"),
            NameObject("/Subtype"): NameObject("/Highlight"),
            NameObject("/Rect"): rect,
            NameObject("/QuadPoints"): quad_points,
            NameObject("/Contents"): TextStringObject(contents),
            NameObject("/T"): TextStringObject(author),
            NameObject("/F"): NumberObject(4),
            NameObject("/C"): ArrayObject(
                [FloatObject(1.0), FloatObject(1.0), FloatObject(0.0)]
            ),
        }
    )


def _inject_annotations() -> None:
    """Read the compiled PDF, attach five annotations, write e2e-annotated.pdf."""
    reader = PdfReader(str(COMPILED_PDF))
    writer = PdfWriter()
    writer.append_pages_from_reader(reader)

    for ann in _ANNOTATIONS:
        page_idx = ann["page"]
        if page_idx >= len(writer.pages):
            # Pad page index if the compiled doc is shorter than expected.
            page_idx = len(writer.pages) - 1

        # `/Contents` carries the commenter's comment (what pdfannots
        # reports as `annotation.comment`). We embed the highlighted_text
        # as the prefix so the e2e tests can recover both — pdfannots
        # also reports the on-page text via its own text-extraction layer.
        contents = ann["comment"]
        annotation = _build_highlight_annotation(
            ann["bbox"],
            contents=contents,
        )
        writer.add_annotation(page_number=page_idx, annotation=annotation)

    with open(ANNOTATED_PDF, "wb") as f:
        writer.write(f)


def _md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def _write_expected_md() -> None:
    lines = [
        "# Expected annotations for the e2e fixture",
        "",
        "Generated by `tests/fixtures/make_e2e_fixtures.py`. Re-run that script",
        "via `tests/fixtures/regenerate_e2e.sh` after any change.",
        "",
        "| ann-id | page | trigger_match | expected mapping | needs_review |",
        "|---|---|---|---|---|",
    ]
    for ann in _ANNOTATIONS:
        lines.append(
            f"| {ann['id']} | {ann['page']+1} | "
            f"{ann['expect_trigger_match']} | "
            f"{ann['expect_method']} (>= {ann['expect_confidence_min']:.2f}) | "
            f"{ann['expect_needs_review']} |"
        )
    lines.append("")
    lines.append("## Highlighted-text snippets")
    lines.append("")
    for ann in _ANNOTATIONS:
        lines.append(f"### {ann['id']}")
        lines.append("")
        lines.append("Highlight:")
        lines.append("")
        lines.append("> " + ann["highlighted_text"])
        lines.append("")
        lines.append(f"Comment: `{ann['comment']}`")
        lines.append("")
    EXPECTED_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_hashes() -> None:
    """Record MD5 hashes of every committed fixture file."""
    files = [
        SAMPLE_PROJECT / "build" / "full_report.tex",
        SAMPLE_PROJECT / "templates" / "intro.tex",
        SAMPLE_PROJECT / "templates" / "findings.tex",
        SAMPLE_PROJECT / "templates" / "conclusion.tex",
        SAMPLE_PROJECT / "templates" / "table.tex",
        COMPILED_PDF,
        ANNOTATED_PDF,
        EXPECTED_MD,
    ]
    lines = ["# md5  relative-path-from-tests/fixtures/"]
    for f in files:
        rel = f.relative_to(FIXTURES).as_posix()
        lines.append(f"{_md5(f)}  {rel}")
    HASHES_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    print(f"Compiling {COMPILED_PDF}...", file=sys.stderr)
    _run_pdflatex()
    print(f"Injecting annotations into {ANNOTATED_PDF}...", file=sys.stderr)
    _inject_annotations()
    print(f"Writing {EXPECTED_MD}...", file=sys.stderr)
    _write_expected_md()
    print(f"Writing {HASHES_FILE}...", file=sys.stderr)
    _write_hashes()
    print("Done. Commit the regenerated files.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
