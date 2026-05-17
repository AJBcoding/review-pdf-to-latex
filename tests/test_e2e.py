"""End-to-end smoke tests against the committed fixture project.

Each test drives all four phases against ``tests/fixtures/e2e-annotated.pdf``
by copying ``e2e-sample-project/`` to a temp dir and invoking the CLI handlers
programmatically. The fixture exercises one annotation per fuzzy-mapping
or trigger-phrase path (see ``tests/fixtures/E2E-EXPECTED.md``).

Acceptance criteria covered: spec §18.1 -- §18.6.

These tests are marked ``slow`` because each subtest re-runs the full
extract -> apply -> build -> commit pipeline against a real pdflatex
binary. Deselect with ``pytest -m 'not slow'`` for faster local runs.
Tests skip gracefully when pdflatex is unavailable.

Note: This module's fixtures (``e2e-annotated.pdf`` + ``e2e-sample-project/``)
are intentionally separate from Task 4's unit-level fixtures
(``sample-annotated.pdf`` + ``make_sample_pdf.py``). Do not consolidate;
the two families exercise different layers of the engine.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from review_pdf_to_latex import cli
from review_pdf_to_latex import state as state_mod


FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE_PROJECT = FIXTURES / "e2e-sample-project"
ANNOTATED_PDF = FIXTURES / "e2e-annotated.pdf"


# Every test in this module is end-to-end (slow). Deselect with -m 'not slow'.
pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(
        shutil.which("pdflatex") is None,
        reason="pdflatex not on PATH; end-to-end tests require a LaTeX install",
    ),
]


@pytest.fixture
def project_copy(tmp_path: Path) -> Path:
    """Copy the fixture project to a fresh temp dir and ``git init`` it.

    Phase 1 requires a clean git working tree (spec §13.1). We init a
    repo and make one baseline commit so the precondition can be met.
    """
    dest = tmp_path / "e2e-sample-project"
    shutil.copytree(SAMPLE_PROJECT, dest)
    # Strip the pre-compiled build/ outputs except the .tex sources so the
    # repo state is clean and reproducible. We keep table-data.tex (a real
    # source file in build/, excluded from fuzzy mapping) and full_report.tex
    # (the main file). The PDF/aux/log are byproducts.
    build_dir = dest / "build"
    for stale in build_dir.iterdir():
        if stale.suffix in {".aux", ".log", ".out", ".pdf"}:
            stale.unlink()
    subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "-m", "baseline"],
        cwd=dest, check=True,
    )
    return dest


def test_phase_0_extract(project_copy: Path):
    """`review-pdf extract` produces the four artifacts and seeds state.json."""
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "extract",
            "--pdf", str(ANNOTATED_PDF),
        ]
    )
    assert rc == 0

    sd = state_mod.StateDir(project_copy)

    # annotations.json: 5 entries with non-null highlighted_text + comment.
    ann = state_mod.read_json(sd.annotations_path)
    assert len(ann["annotations"]) == 5
    for a in ann["annotations"]:
        assert a["highlighted_text"], f"empty highlighted_text on {a['id']}"
        assert a["comment"], f"empty comment on {a['id']}"

    # mapping.json: ann-001, ann-002, ann-003, ann-005 are needs_review False.
    # ann-004 (table cell) is needs_review True.
    mapping = state_mod.read_json(sd.mapping_path)
    m = mapping["mappings"]
    assert m["ann-001"]["needs_review"] is False
    assert m["ann-002"]["needs_review"] is False
    assert m["ann-003"]["needs_review"] is False
    assert m["ann-005"]["needs_review"] is False
    assert m["ann-004"]["needs_review"] is True
    # ann-004 candidates may be empty (method: failed) or up to three entries.
    assert isinstance(m["ann-004"].get("candidates", []), list)

    # state.json: phase 0-setup, ann-004 is needs_review, others pending.
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "0-setup"
    assert st["annotations"]["ann-004"]["status"] == "needs_review"
    for ann_id in ("ann-001", "ann-002", "ann-003", "ann-005"):
        assert st["annotations"][ann_id]["status"] == "pending"

    # pages/page-N.png: one per page in the source PDF.
    pages = sorted((sd.dir / "pages").glob("page-*.png"))
    assert len(pages) >= 1, "no page renders produced"

    # trigger_match: ann-003's comment matches the default trigger phrase.
    ann_by_id = {a["id"]: a for a in ann["annotations"]}
    assert ann_by_id["ann-003"]["trigger_match"] is True
    assert ann_by_id["ann-001"]["trigger_match"] is False
