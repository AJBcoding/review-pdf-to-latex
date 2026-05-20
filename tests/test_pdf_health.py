"""Tests for the pdf-health subcommand and underlying module.

The behavior under test is documented in
``src/review_pdf_to_latex/pdf_health.py`` and ``design-spec §8`` /
``ux-spec §5.2``. Validated end-to-end against the corrupted COTA PDF
during the 2026-05-20 spike (see
``docs/research/2026-05-20-pdf-text-layer-spike/README.md``).
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from review_pdf_to_latex import cli
from review_pdf_to_latex.pdf_health import (
    EXIT_MISSING,
    EXIT_OK,
    SCHEMA_VERSION,
    cid_density,
    detect_ligature_loss,
    health_check,
    run_pdf_health,
)

FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE_PDF = FIXTURES / "sample-annotated.pdf"


# ---------- Ligature-loss heuristic -----------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "the report is veri ed against records",          # verified
        "as the data refreshes, our con dence grows",     # confidence
        "sacri cing capacity was the wrong call",         # sacrificing
        "Equity Without Sacri cing Standards",            # sacrificing (title case)
        "an ef cient classroom is also a busy classroom", # efficient
        "this metric was de ned in the appendix",         # defined
        "of cial enrollment numbers",                     # official
    ],
)
def test_detect_ligature_loss_positive(text: str) -> None:
    """Each pattern in the heuristic catches its target stem."""
    assert detect_ligature_loss(text) is True, f"missed: {text!r}"


@pytest.mark.parametrize(
    "text",
    [
        "The report is verified against records.",
        "Sacrificing capacity was the wrong call.",
        "An efficient classroom is also a busy classroom.",
        "Official enrollment numbers.",
        "Plain English with no ligature words.",
        "",
    ],
)
def test_detect_ligature_loss_negative(text: str) -> None:
    """Properly-extracted text doesn't trip the heuristic."""
    assert detect_ligature_loss(text) is False, f"false positive: {text!r}"


# ---------- CID-density heuristic ------------------------------------------


def test_cid_density_empty_text() -> None:
    assert cid_density("") == 0.0


def test_cid_density_zero_on_clean_text() -> None:
    assert cid_density("verified and significant") == 0.0


def test_cid_density_high_on_cid_only_text() -> None:
    """Fully CID-encoded text scores ~1.0 (each (cid:NN) artifact is text)."""
    text = "(cid:67)(cid:111)(cid:108)(cid:108)(cid:101)(cid:103)(cid:101)"
    assert cid_density(text) == 1.0


def test_cid_density_partial() -> None:
    """A mix of real text and CID artifacts produces a fractional density."""
    text = "hello (cid:67)(cid:111)"  # 6 real + 1 space + 16 CID chars = 23 total
    density = cid_density(text)
    assert 0.6 < density < 0.8  # ~16/23


# ---------- health_check() — clean PDF -------------------------------------


def test_health_check_sample_pdf_clean() -> None:
    """The repo's clean sample PDF passes the health check with all pages readable."""
    exit_code, report = health_check(SAMPLE_PDF)

    assert exit_code == EXIT_OK
    assert report["schema_version"] == SCHEMA_VERSION
    assert report["pdf_path"] == str(SAMPLE_PDF.resolve())
    assert report["encrypted"] is False
    assert report["error"] is None

    assert report["total_pages"] is not None and report["total_pages"] >= 1
    # Every page should be readable on a clean fixture.
    assert report["unreadable_pages"] == []
    assert report["page_errors"] == []
    assert report["readable_pages"] == list(range(1, report["total_pages"] + 1))

    # No ligature loss on a freshly built fixture.
    assert report["ligature_loss_detected"] is False

    # Producer field should be populated (the make_sample_pdf script uses reportlab).
    assert report["producer"] is None or isinstance(report["producer"], str)


# ---------- health_check() — missing / bad files ---------------------------


def test_health_check_missing_file(tmp_path: Path) -> None:
    """Non-existent path → exit 2 with a 'file not found' error string."""
    bogus = tmp_path / "does-not-exist.pdf"
    exit_code, report = health_check(bogus)

    assert exit_code == EXIT_MISSING
    assert report["error"] == "file not found"
    assert report["total_pages"] is None
    assert report["readable_pages"] == []
    assert report["unreadable_pages"] == []


def test_health_check_directory_instead_of_file(tmp_path: Path) -> None:
    """A directory path → exit 2 with the 'not a regular file' error."""
    exit_code, report = health_check(tmp_path)

    assert exit_code == EXIT_MISSING
    assert "not a regular file" in (report["error"] or "")


def test_health_check_non_pdf_file(tmp_path: Path) -> None:
    """Random bytes pretending to be a PDF → exit 2 with a generic open error."""
    bogus = tmp_path / "fake.pdf"
    bogus.write_bytes(b"definitely not a PDF\n" * 100)

    exit_code, report = health_check(bogus)

    assert exit_code == EXIT_MISSING
    assert report["error"] is not None
    assert "failed to open PDF" in report["error"] or "encrypt" not in report["error"].lower()


# ---------- run_pdf_health() — stream serialization ------------------------


def test_run_pdf_health_emits_valid_json_on_clean() -> None:
    """The CLI entry point writes a JSON object + trailing newline to its stream."""
    buf = io.StringIO()
    exit_code = run_pdf_health(SAMPLE_PDF, stream=buf)

    assert exit_code == EXIT_OK
    output = buf.getvalue()
    assert output.endswith("\n")

    parsed = json.loads(output)
    assert parsed["schema_version"] == SCHEMA_VERSION
    assert parsed["pdf_path"] == str(SAMPLE_PDF.resolve())
    assert isinstance(parsed["readable_pages"], list)
    assert isinstance(parsed["unreadable_pages"], list)
    assert isinstance(parsed["ligature_loss_detected"], bool)
    assert isinstance(parsed["encrypted"], bool)


def test_run_pdf_health_emits_json_even_on_missing_file(tmp_path: Path) -> None:
    """Missing files still produce a parseable JSON report (exit 2)."""
    bogus = tmp_path / "missing.pdf"
    buf = io.StringIO()
    exit_code = run_pdf_health(bogus, stream=buf)

    assert exit_code == EXIT_MISSING
    parsed = json.loads(buf.getvalue())
    assert parsed["error"] == "file not found"
    assert parsed["pdf_path"] == str(bogus.resolve())


# ---------- CLI integration -------------------------------------------------


def test_cli_dispatches_pdf_health(capsys: pytest.CaptureFixture, tmp_path: Path) -> None:
    """`review-pdf pdf-health --pdf X` routes through the dispatch table."""
    bogus = tmp_path / "missing.pdf"

    exit_code = cli.main(["pdf-health", "--pdf", str(bogus)])

    assert exit_code == EXIT_MISSING
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["schema_version"] == SCHEMA_VERSION
    assert parsed["error"] == "file not found"


def test_cli_pdf_health_on_clean_fixture(capsys: pytest.CaptureFixture) -> None:
    """End-to-end CLI run against the clean sample fixture."""
    exit_code = cli.main(["pdf-health", "--pdf", str(SAMPLE_PDF)])

    assert exit_code == EXIT_OK
    out = capsys.readouterr().out
    parsed = json.loads(out)
    assert parsed["unreadable_pages"] == []
    assert parsed["ligature_loss_detected"] is False
