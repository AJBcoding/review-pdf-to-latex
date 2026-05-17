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


import re
from html.parser import HTMLParser


class _ButtonCollector(HTMLParser):
    """Collect <button> elements and their data-action attrs."""

    def __init__(self) -> None:
        super().__init__()
        self.buttons: list[dict[str, str]] = []

    def handle_starttag(self, tag, attrs):
        if tag == "button":
            d = dict(attrs)
            self.buttons.append(d)


def test_annotation_left_pane_has_page_image_and_overlay():
    env = _env()
    tpl = env.get_template("annotation.html")
    out = tpl.render(**normal_context())
    assert 'src="/pages/page-4.png"' in out
    assert "highlight-overlay" in out
    # Sanity: the overlay must use px positioning.
    assert re.search(r"left:\s*\d+(?:\.\d+)?px", out)
    assert re.search(r"top:\s*\d+(?:\.\d+)?px", out)
    assert re.search(r"width:\s*\d+(?:\.\d+)?px", out)
    assert re.search(r"height:\s*\d+(?:\.\d+)?px", out)


def test_annotation_center_pane_has_snippet_and_six_buttons():
    env = _env()
    tpl = env.get_template("annotation.html")
    out = tpl.render(**normal_context())
    # Snippet with line numbers
    assert "latex-snippet" in out
    assert "The college experienced a substantial increase" in out
    # Six action buttons
    p = _ButtonCollector()
    p.feed(out)
    actions = [b.get("data-action") for b in p.buttons if "data-action" in b]
    assert sorted(actions) == sorted(["preview", "approve", "reject", "redraft", "skip", "surface"])
    # All carry the current annotation id
    for b in p.buttons:
        if "data-action" in b:
            assert b.get("data-annotation-id") == "ann-001"


def test_annotation_disables_approve_when_status_pending():
    env = _env()
    tpl = env.get_template("annotation.html")
    ctx = normal_context()
    ctx["current_state"]["annotations"]["ann-001"]["status"] = "pending"
    out = tpl.render(**ctx)
    p = _ButtonCollector()
    p.feed(out)
    approve = next(b for b in p.buttons if b.get("data-action") == "approve")
    assert "disabled" in approve  # html.parser yields disabled with value None or empty string


def test_annotation_right_pane_uses_current_build_path():
    env = _env()
    tpl = env.get_template("annotation.html")
    out = tpl.render(**normal_context())
    assert 'src="/builds/build-007/page-4.png"' in out
    assert "24 → 24 pages, no shift" in out


def test_annotation_right_pane_no_build_yet():
    env = _env()
    tpl = env.get_template("annotation.html")
    ctx = normal_context()
    ctx["current_build"] = None
    out = tpl.render(**ctx)
    assert "No build yet" in out


def test_annotation_proposed_block_falls_back_to_pre_when_no_diff2html():
    env = _env()
    tpl = env.get_template("annotation.html")
    out = tpl.render(**normal_context(diff2html_present=False))
    assert "Before" in out
    assert "Proposed" in out
    assert "diff2html" not in out.lower()


def test_annotation_proposed_block_uses_diff2html_when_present():
    env = _env()
    tpl = env.get_template("annotation.html")
    out = tpl.render(**normal_context(diff2html_present=True))
    assert 'id="diff-container"' in out
    assert "Diff2Html" in out


def test_annotation_overlay_position_correct_for_known_bbox():
    """Verify the bbox→CSS scaling. Spec §10.1: PDF origin is bottom-left."""
    env = _env()
    tpl = env.get_template("annotation.html")
    # bbox [72.0, 510.5, 540.0, 542.5] on a 612×792 pt page rendered at 1275×1650 px
    # scale_x = 1275/612 = 2.0833..., scale_y = 1650/792 = 2.0833...
    # left_px = 72.0 * 2.0833 = 150.0
    # top_px = (792 - 542.5) * 2.0833 = 249.5 * 2.0833 = 519.79
    # width_px = (540 - 72) * 2.0833 = 468 * 2.0833 = 975.0
    # height_px = (542.5 - 510.5) * 2.0833 = 32 * 2.0833 = 66.67
    out = tpl.render(**normal_context())
    # Use loose float matching: extract numeric values and check within tolerance.
    m_left = re.search(r"left:\s*([\d.]+)px", out)
    m_top = re.search(r"top:\s*([\d.]+)px", out)
    m_width = re.search(r"width:\s*([\d.]+)px;[^}]*background", out) or re.search(r"width:\s*([\d.]+)px", out)
    assert m_left and abs(float(m_left.group(1)) - 150.0) < 0.5
    assert m_top and abs(float(m_top.group(1)) - 519.79) < 0.5
