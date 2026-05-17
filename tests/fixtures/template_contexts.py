"""Sample Jinja2 context dicts for template tests.

Build these with helpers so each test can override one field without
restating the whole tree.
"""

from __future__ import annotations

from typing import Any


def sample_annotation(
    *,
    annotation_id: str = "ann-001",
    page: int = 4,
    bbox: tuple[float, float, float, float] = (72.0, 510.5, 540.0, 542.5),
    highlighted_text: str = "The college experienced a substantial increase",
    author: str = "anonymous",
    comment: str = "Tighten this",
) -> dict[str, Any]:
    return {
        "id": annotation_id,
        "page": page,
        "bbox": list(bbox),
        "highlighted_text": highlighted_text,
        "author": author,
        "comment": comment,
        "trigger_match": False,
    }


def sample_mapping_entry(
    *,
    latex_file: str | None = "templates/enrollment_growth.tex",
    line_range: tuple[int, int] | None = (47, 52),
    confidence: float = 0.92,
    method: str = "fuzzy_text",
    needs_review: bool = False,
    candidates: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "latex_file": latex_file,
        "line_range": list(line_range) if line_range is not None else None,
        "confidence": confidence,
        "method": method,
        "needs_review": needs_review,
    }
    if candidates is not None:
        entry["candidates"] = candidates
    return entry


def sample_state_annotation(
    *,
    status: str = "applied",
    before_text: str | None = "The college experienced a substantial increase",
    proposed_text: str | None = "COTA enrollment grew 12% YoY",
    applied_text: str | None = "COTA enrollment grew 12% YoY",
) -> dict[str, Any]:
    return {
        "status": status,
        "before_text": before_text,
        "proposed_text": proposed_text,
        "applied_text": applied_text,
        "applied_at": "2026-05-16T20:45:12Z" if status == "applied" else None,
        "last_build_id": "build-007",
        "surface_chat_log": None,
        "failure_log_path": None,
        "failure_edit_text": None,
    }


def sample_build(
    *,
    build_id: str = "build-007",
    page_count: int = 24,
    ok: bool = True,
) -> dict[str, Any]:
    return {
        "id": build_id,
        "pdf_path": f".review-state/builds/{build_id}.pdf",
        "page_count": page_count,
        "compiled_at": "2026-05-16T20:50:00Z",
        "log_path": f".review-state/builds/{build_id}.log",
        "ok": ok,
        "page_md5": ["abc"] * page_count,
    }


def normal_context(
    *,
    annotation_id: str = "ann-001",
    annotation_index: int = 1,
    total_annotations: int = 7,
    project_root: str = "/abs/path/to/project",
    phase: str = "2a-ratify",
    order: str = "mechanical-first",
    latex_snippet: str = (
        "% line 47\n"
        "The college experienced a substantial increase\n"
        "in enrollment over the past three years.\n"
        "% line 52\n"
    ),
    snippet_start_line: int = 47,
    proposed_text: str | None = "COTA enrollment grew 12% YoY",
    pagination_indicator: str = "24 → 24 pages, no shift",
    target_page: int = 4,
    image_width_px: int = 1275,
    image_height_px: int = 1650,
    pdf_page_width_pt: float = 612.0,
    pdf_page_height_pt: float = 792.0,
    diff2html_present: bool = False,
) -> dict[str, Any]:
    """Build a complete Jinja context for the normal (3-pane) view."""
    ann = sample_annotation(annotation_id=annotation_id)
    return {
        "mode": "normal",
        "project_root": project_root,
        "phase": phase,
        "order": order,
        "current_state": {
            "schema_version": 1,
            "phase": phase,
            "order": order,
            "current_annotation_id": annotation_id,
            "annotations": {annotation_id: sample_state_annotation()},
            "builds": [sample_build()],
        },
        "current_annotation": ann,
        "current_mapping": sample_mapping_entry(),
        "current_build": sample_build(),
        "latex_snippet": latex_snippet,
        "snippet_start_line": snippet_start_line,
        "proposed_text": proposed_text,
        "pagination_indicator": pagination_indicator,
        "target_page": target_page,
        "annotation_index": annotation_index,
        "total_annotations": total_annotations,
        "image_width_px": image_width_px,
        "image_height_px": image_height_px,
        "pdf_page_width_pt": pdf_page_width_pt,
        "pdf_page_height_pt": pdf_page_height_pt,
        "diff2html_present": diff2html_present,
    }


def mapping_context(
    *,
    needs_review_annotations: list[dict[str, Any]] | None = None,
    tex_files: list[str] | None = None,
    project_root: str = "/abs/path/to/project",
) -> dict[str, Any]:
    """Build a complete Jinja context for the manual-mapping view."""
    if needs_review_annotations is None:
        needs_review_annotations = [
            {
                "annotation": sample_annotation(annotation_id="ann-013", page=7),
                "mapping": sample_mapping_entry(
                    latex_file=None,
                    line_range=None,
                    confidence=0.0,
                    method="failed",
                    needs_review=True,
                    candidates=[
                        {"file": "templates/equity.tex", "line_range": [22, 28], "score": 0.34},
                        {"file": "templates/success.tex", "line_range": [88, 91], "score": 0.31},
                    ],
                ),
            },
            {
                "annotation": sample_annotation(annotation_id="ann-027", page=11),
                "mapping": sample_mapping_entry(
                    latex_file=None,
                    line_range=None,
                    confidence=0.0,
                    method="failed",
                    needs_review=True,
                    candidates=[],
                ),
            },
        ]
    if tex_files is None:
        tex_files = ["main.tex", "templates/equity.tex", "templates/success.tex"]
    return {
        "mode": "mapping",
        "project_root": project_root,
        "phase": "0-setup",
        "order": "mechanical-first",
        "needs_review_annotations": needs_review_annotations,
        "tex_files": tex_files,
        "diff2html_present": False,
    }
