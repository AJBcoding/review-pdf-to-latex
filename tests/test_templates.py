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
    # rev-s1o: counter labels the default "unresolved" view and exposes the
    # ?include=terminal toggle when there are decided annotations to include.
    assert "unresolved" in out


def test_frame_counter_shows_include_terminal_toggle_when_decided_exist():
    """Default 'unresolved' view must offer a toggle when totals differ."""
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context(
        annotation_index=1,
        total_annotations=2,
    ) | {"total_all_annotations": 10})
    assert "?include=terminal" in out
    assert "all 10" in out


def test_frame_counter_shows_all_view_label_when_include_terminal():
    env = _env()
    tpl = env.get_template("frame.html")
    ctx = normal_context(annotation_index=3, total_annotations=7)
    ctx["view_filter"] = "all"
    ctx["total_all_annotations"] = 7
    out = tpl.render(**ctx)
    assert "3 of 7" in out
    assert "unresolved only" in out  # toggle label back to default view
    assert ">unresolved<" not in out  # the counter itself does not say "unresolved"


def test_frame_navigate_passes_view_filter_to_server():
    """rev-3pm: the Prev/Next click handler embeds the active view_filter so
    the server's auto-dispatch resolves within the correct visible set."""
    env = _env()
    tpl = env.get_template("frame.html")
    ctx = normal_context()
    ctx["view_filter"] = "all"
    ctx["total_all_annotations"] = ctx["total_annotations"]
    out = tpl.render(**ctx)
    assert 'var NAV_VIEW = "all"' in out


def test_frame_includes_no_consumer_watchdog_wiring():
    """rev-3pm: the watchdog timer + warning copy must be present in the
    embedded script so status-mutating clicks aren't silent no-ops."""
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    assert "NO_CONSUMER_DELAY_MS" in out
    assert "No consumer attached" in out
    assert "status-warning" in out


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


def test_frame_has_grid_layout_rules():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    # Top bar height
    assert "height: 48px" in out
    # 3-column grid
    assert "grid-template-columns" in out
    assert "minmax(280px, 1fr)" in out
    assert "minmax(360px, 1.6fr)" in out
    # Button row gap
    assert "gap: 12px" in out
    # Highlight overlay rules
    assert "rgba(255, 200, 0, 0.7)" in out
    assert "rgba(255, 240, 0, 0.18)" in out


def test_frame_has_no_external_stylesheet_link():
    """v1 decision: inline CSS only, no external <link rel='stylesheet'>."""
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    assert 'rel="stylesheet"' not in out


def test_frame_script_posts_to_api_events():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    assert 'fetch("/api/events"' in out
    assert '"method": "POST"' in out or "method: \"POST\"" in out


def test_frame_script_handles_redraft_with_prompt():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    # The handler must prompt when action is "redraft" and send speculative_text.
    assert "redraft" in out
    assert "prompt(" in out
    assert "speculative_text" in out


def test_frame_script_polls_state_and_reloads_on_change():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    assert "setInterval" in out
    assert '"/api/state"' in out or "'/api/state'" in out
    assert "location.reload" in out


def test_frame_script_disables_buttons_after_send():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context())
    # After a successful POST, buttons should be disabled so the user can't double-click.
    assert "button[data-action]" in out
    assert "disabled = true" in out or "b.disabled" in out


def test_mapping_renders_one_row_per_needs_review_annotation():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**mapping_context())
    # Two rows from the default mapping_context() fixture
    assert out.count('class="mapping-row"') == 2
    assert "ann-013" in out
    assert "ann-027" in out


def test_mapping_renders_candidate_buttons():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**mapping_context())
    # ann-013 has two candidates; ann-027 has none.
    p = _ButtonCollector()
    p.feed(out)
    confirm_btns = [b for b in p.buttons if b.get("data-confirm-candidate") is not None or "data-confirm-candidate" in b]
    # Two candidates for ann-013 → two confirm-candidate buttons.
    candidate_confirms = [b for b in p.buttons if b.get("data-annotation-id") == "ann-013" and "data-confirm-candidate" in b]
    assert len(candidate_confirms) == 2
    # Each candidate button carries file + line numbers
    files = sorted(b.get("data-file") for b in candidate_confirms)
    assert files == ["templates/equity.tex", "templates/success.tex"]


def test_mapping_renders_manual_override_form_per_row():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**mapping_context())
    # One form per row, each with the right hidden annotation_id
    assert out.count('class="manual-override"') == 2
    assert 'value="ann-013"' in out
    assert 'value="ann-027"' in out
    # File <select> populated from tex_files
    assert "<option" in out
    assert "main.tex" in out
    assert "templates/equity.tex" in out


def test_mapping_renders_all_resolved_message_when_list_empty():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**mapping_context(needs_review_annotations=[]))
    assert "All mappings resolved" in out


def test_mapping_does_not_render_three_pane():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**mapping_context())
    assert 'class="three-pane"' not in out


def test_mapping_renders_excerpt_and_comment():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**mapping_context())
    assert "The college experienced a substantial increase" in out
    assert "Tighten this" in out


def test_frame_emits_diff2html_link_when_present():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context(diff2html_present=True))
    assert 'href="/static/diff2html.min.css"' in out
    assert 'src="/static/diff2html.min.js"' in out


def test_frame_omits_diff2html_link_when_absent():
    env = _env()
    tpl = env.get_template("frame.html")
    out = tpl.render(**normal_context(diff2html_present=False))
    assert "diff2html.min.css" not in out
    assert "diff2html.min.js" not in out


from tests.fixtures.template_contexts import sample_annotation, sample_mapping_entry


ALL_STATUSES = [
    "pending", "applied", "accepted", "rejected", "redrafted",
    "deferred", "surfaced_pending", "surfaced_resolved", "needs_review",
]


@pytest.mark.parametrize("status", ALL_STATUSES)
def test_frame_renders_for_every_status(status):
    env = _env()
    tpl = env.get_template("frame.html")
    ctx = normal_context()
    ctx["current_state"]["annotations"]["ann-001"]["status"] = status
    # Must not raise; output must contain the status string.
    out = tpl.render(**ctx)
    assert status in out


def test_frame_renders_mapping_mode_with_three_candidates():
    env = _env()
    tpl = env.get_template("frame.html")
    ctx = mapping_context(
        needs_review_annotations=[{
            "annotation": sample_annotation(annotation_id="ann-099", page=22),
            "mapping": sample_mapping_entry(
                latex_file=None,
                line_range=None,
                confidence=0.0,
                method="failed",
                needs_review=True,
                candidates=[
                    {"file": "a.tex", "line_range": [1, 5], "score": 0.45},
                    {"file": "b.tex", "line_range": [10, 14], "score": 0.40},
                    {"file": "c.tex", "line_range": [20, 24], "score": 0.35},
                ],
            ),
        }],
    )
    out = tpl.render(**ctx)
    p = _ButtonCollector()
    p.feed(out)
    candidate_confirms = [b for b in p.buttons if "data-confirm-candidate" in b]
    assert len(candidate_confirms) == 3
    assert "a.tex" in out and "b.tex" in out and "c.tex" in out


def test_frame_renders_without_proposed_text():
    env = _env()
    tpl = env.get_template("frame.html")
    ctx = normal_context(proposed_text=None)
    ctx["current_state"]["annotations"]["ann-001"]["proposed_text"] = None
    out = tpl.render(**ctx)
    assert "(no proposal yet)" in out
