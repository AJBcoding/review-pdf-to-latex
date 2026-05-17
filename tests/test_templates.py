"""Tests for Jinja2 viewer templates.

These tests render the templates with hand-built context dicts and assert
substring / structural properties of the rendered HTML. They do not
exercise browser behavior — that is covered by the end-to-end fixture in
chunk F (Task 12).
"""

from __future__ import annotations

import importlib.resources
from pathlib import Path

import pytest
from jinja2 import Environment, FileSystemLoader, select_autoescape


def _templates_dir() -> Path:
    """Locate the installed templates directory."""
    pkg_root = Path(__file__).resolve().parent.parent / "src" / "review_pdf_to_latex" / "templates"
    assert pkg_root.is_dir(), f"templates dir not found: {pkg_root}"
    return pkg_root


def _env() -> Environment:
    return Environment(
        loader=FileSystemLoader(str(_templates_dir())),
        autoescape=select_autoescape(["html"]),
        keep_trailing_newline=True,
    )


def test_templates_directory_exists():
    """The templates directory must exist at the expected location."""
    d = _templates_dir()
    assert d.is_dir()
    assert (d / "static").is_dir(), "static/ subdir must exist for optional deps"
