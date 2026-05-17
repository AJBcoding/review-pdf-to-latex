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


from tests.fixtures.template_contexts import normal_context, mapping_context


def test_frame_renders_top_bar_in_normal_mode():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context(
        annotation_index=3,
        total_annotations=7,
        project_root="/Users/me/cota",
        phase="2a-ratify",
    ))
    assert "<!DOCTYPE html>" in out
    assert "<title>review-pdf-to-latex</title>" in out
    # Top bar substrings:
    assert "/Users/me/cota" in out
    assert "2a-ratify" in out
    assert "3 of 7" in out
    assert "ann-001" in out
    assert 'id="status"' in out  # status line element used by JS handler


def test_frame_renders_mapping_mode_banner_when_mode_mapping():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**mapping_context())
    assert "Mapping mode" in out
    # The 3-pane content must NOT render in mapping mode:
    assert 'class="three-pane"' not in out


def test_frame_includes_script_block_with_send_action():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    # Defer detailed assertions to Task 9.4; minimal sanity here:
    assert "<script>" in out
    assert "sendAction" in out


def test_frame_renders_no_build_yet_when_current_build_is_none():
    env = _env()
    tpl = env.get_template("frame.html")
    ctx = normal_context()
    ctx["current_build"] = None
    out = tpl.render(**ctx)
    # Top bar should still render; the 3-pane handles the missing build itself.
    assert "ann-001" in out
