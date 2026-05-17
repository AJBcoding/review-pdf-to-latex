"""Verify the committed e2e fixtures exist and match the recorded hashes.

The generator (`tests/fixtures/make_e2e_fixtures.py`) writes the LaTeX
project, compiles it, and produces ``e2e-annotated.pdf``. Its outputs
are committed to git so tests do not require pdflatex / pypdf to run.
This test re-checks the on-disk hashes against
``e2e-expected-hashes.txt``; if they drift, either the generator changed
(run ``regenerate_e2e.sh``) or a committed fixture was edited by hand.

Note: these fixtures coexist alongside Task 4's
``sample-annotated.pdf`` / ``make_sample_pdf.py`` — two separate
fixture families backing different test layers (unit-fuzzy-mapping
vs end-to-end smoke tests). Do not consolidate them.
"""

from __future__ import annotations

import hashlib
from pathlib import Path


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _file_md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def _load_expected_hashes() -> dict[str, str]:
    """Parse ``e2e-expected-hashes.txt`` (one line per file: ``<md5>  <path>``)."""
    hashes: dict[str, str] = {}
    text = (FIXTURES_DIR / "e2e-expected-hashes.txt").read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        md5, _, rel = line.partition("  ")
        hashes[rel.strip()] = md5.strip()
    return hashes


def test_all_committed_fixtures_exist():
    """Every file named in e2e-expected-hashes.txt is present on disk."""
    expected = _load_expected_hashes()
    missing = [rel for rel in expected if not (FIXTURES_DIR / rel).exists()]
    assert not missing, f"missing fixture files: {missing}"


def test_committed_fixture_hashes_match():
    """Every committed fixture's MD5 matches the recorded hash.

    On drift: run ``bash tests/fixtures/regenerate_e2e.sh`` to re-generate
    the outputs and update ``e2e-expected-hashes.txt``.
    """
    expected = _load_expected_hashes()
    drifted: list[tuple[str, str, str]] = []
    for rel, want in expected.items():
        got = _file_md5(FIXTURES_DIR / rel)
        if got != want:
            drifted.append((rel, want, got))
    assert not drifted, f"fixture drift: {drifted}"


def test_expected_md_describes_all_five_annotations():
    """E2E-EXPECTED.md must enumerate ann-001 through ann-005."""
    expected_md = (FIXTURES_DIR / "E2E-EXPECTED.md").read_text(encoding="utf-8")
    for ann_id in ("ann-001", "ann-002", "ann-003", "ann-004", "ann-005"):
        assert ann_id in expected_md, f"{ann_id} not described in E2E-EXPECTED.md"
