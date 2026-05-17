"""Smoke test: package is importable and version is exposed."""

import review_pdf_to_latex


def test_package_importable():
    """The package imports without error and exposes __version__."""
    assert review_pdf_to_latex.__version__ == "0.1.0"
