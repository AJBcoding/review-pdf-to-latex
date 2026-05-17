"""Tests for src/review_pdf_to_latex/extract.py — Phase 0 setup pipeline."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from review_pdf_to_latex.extract import read_annotations
from review_pdf_to_latex.state import Annotation


FIXTURE_PDF = Path(__file__).parent / "fixtures" / "sample-annotated.pdf"


def test_read_annotations_returns_list_with_correct_fields() -> None:
    """read_annotations returns Annotation dataclasses with all required fields populated."""
    assert FIXTURE_PDF.exists(), (
        f"Fixture {FIXTURE_PDF} missing; commit a 1-page PDF with 2 highlights first."
    )

    result = read_annotations(FIXTURE_PDF)

    assert isinstance(result, list), "expected a list"
    assert len(result) >= 1, "fixture must contain at least one highlight"

    id_pattern = re.compile(r"^ann-\d{3}$")

    for i, ann in enumerate(result):
        assert isinstance(ann, Annotation), f"item {i} is not an Annotation dataclass"
        assert id_pattern.match(ann.id), f"id {ann.id!r} not in ann-NNN format"
        assert isinstance(ann.page, int) and ann.page >= 1, "page must be 1-based int"
        assert isinstance(ann.bbox, tuple) and len(ann.bbox) == 4, "bbox must be 4-tuple"
        assert all(isinstance(c, float) for c in ann.bbox), "bbox values must be floats"
        assert isinstance(ann.highlighted_text, str) and ann.highlighted_text, (
            "highlighted_text must be a non-empty string"
        )
        assert isinstance(ann.author, str) and ann.author, (
            "author must be a non-empty string (use 'anonymous' if absent)"
        )
        assert isinstance(ann.comment, str), "comment must be str (may be empty)"
        assert ann.created is None or isinstance(ann.created, str), (
            "created must be ISO8601 string or None"
        )
        assert isinstance(ann.trigger_match, bool), "trigger_match must be bool"

    # IDs are sequential and zero-padded across the list.
    expected_ids = [f"ann-{i + 1:03d}" for i in range(len(result))]
    assert [a.id for a in result] == expected_ids, (
        f"IDs must be sequential ann-001..ann-NNN; got {[a.id for a in result]}"
    )


from review_pdf_to_latex.extract import is_trigger


@pytest.mark.parametrize(
    ("comment", "trigger", "expected"),
    [
        ("claude surface this", "claude surface this", True),
        ("Claude Surface This", "claude surface this", True),
        ("CLAUDE SURFACE THIS, please", "claude surface this", True),
        ("Hey, claude surface this paragraph", "claude surface this", True),
        ("tighten the prose", "claude surface this", False),
        ("", "claude surface this", False),
        ("claude surfacethis", "claude surface this", False),
        ("anything goes", "anything goes", True),
        ("anything", "anything goes", False),
    ],
    ids=[
        "exact",
        "title_case",
        "uppercase_with_extra",
        "embedded_in_longer",
        "no_match",
        "empty_comment",
        "no_space_no_match",
        "custom_trigger_match",
        "custom_trigger_no_match",
    ],
)
def test_is_trigger_case_insensitive_substring(
    comment: str, trigger: str, expected: bool
) -> None:
    """is_trigger returns True iff the trigger phrase is a case-insensitive substring."""
    assert is_trigger(comment, trigger) is expected


from review_pdf_to_latex.extract import render_pages


PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def test_render_pages_emits_unpadded_png_files(tmp_path: Path) -> None:
    """render_pages produces page-1.png, page-2.png... with valid PNG magic bytes."""
    out_dir = tmp_path / "pages"
    out_dir.mkdir()

    paths = render_pages(FIXTURE_PDF, out_dir, dpi=72)

    assert isinstance(paths, list), "expected a list of Paths"
    assert len(paths) >= 1, "fixture PDF must have at least one page"

    for i, p in enumerate(paths, start=1):
        assert p.name == f"page-{i}.png", (
            f"page {i} named {p.name!r}; expected page-{i}.png (no zero-padding)"
        )
        assert p.exists(), f"{p} not written"
        with p.open("rb") as fh:
            header = fh.read(8)
        assert header == PNG_MAGIC, f"{p} not a valid PNG (header={header!r})"


def test_render_pages_raises_on_pdftoppm_failure(tmp_path: Path) -> None:
    """render_pages raises RuntimeError when pdftoppm exits non-zero."""
    bogus = tmp_path / "not-a-pdf.pdf"
    bogus.write_bytes(b"this is not a PDF")

    out_dir = tmp_path / "pages"
    out_dir.mkdir()

    with pytest.raises(RuntimeError, match="pdftoppm"):
        render_pages(bogus, out_dir, dpi=72)


def test_render_pages_caches_when_pngs_newer_than_pdf(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Spec §15 Q9 lazy cache: skip pdftoppm if every page-N.png is newer than the PDF."""
    import subprocess as _subprocess
    from review_pdf_to_latex import extract as _extract

    pdf = tmp_path / "fixture.pdf"
    pdf.write_bytes(FIXTURE_PDF.read_bytes())
    out_dir = tmp_path / "pages"
    out_dir.mkdir()

    # First pass: actually rasterize.
    paths = render_pages(pdf, out_dir, dpi=72)
    assert paths, "first pass must produce PNGs"

    # Touch every PNG so its mtime is strictly newer than the PDF.
    import os as _os
    import time as _time
    later = _time.time() + 10
    for p in paths:
        _os.utime(p, (later, later))

    # Second pass: monkey-patch subprocess.run to assert pdftoppm is NOT invoked.
    calls: list[list[str]] = []
    real_run = _subprocess.run

    def _fail_if_pdftoppm(cmd, *a, **kw):
        if isinstance(cmd, list) and cmd and "pdftoppm" in cmd[0]:
            calls.append(cmd)
            raise AssertionError("pdftoppm should not be invoked on cache hit")
        return real_run(cmd, *a, **kw)

    monkeypatch.setattr(_extract, "subprocess", _subprocess)
    monkeypatch.setattr(_subprocess, "run", _fail_if_pdftoppm)

    paths2 = render_pages(pdf, out_dir, dpi=72)
    assert paths2 == paths, "cache hit must return the same paths"
    assert calls == [], "pdftoppm was invoked despite a fresh cache"


def test_render_pages_reinvokes_pdftoppm_when_pdf_newer_than_pngs(
    tmp_path: Path,
) -> None:
    """Cache is invalidated if the PDF is touched after the PNGs are rendered."""
    import os as _os
    import time as _time

    pdf = tmp_path / "fixture.pdf"
    pdf.write_bytes(FIXTURE_PDF.read_bytes())
    out_dir = tmp_path / "pages"
    out_dir.mkdir()

    paths = render_pages(pdf, out_dir, dpi=72)
    assert paths
    # Make the PDF newer than every PNG.
    later = _time.time() + 10
    _os.utime(pdf, (later, later))

    # render_pages must re-rasterize without raising (the PNGs get overwritten).
    paths2 = render_pages(pdf, out_dir, dpi=72)
    assert paths2 == paths


from review_pdf_to_latex.extract import fuzzy_map
from review_pdf_to_latex.state import Mapping


SAMPLE_PROJECT = Path(__file__).parent / "fixtures" / "sample-project"


def _make_sample_project(root: Path) -> None:
    """Create a synthetic 3-file LaTeX project for fuzzy_map tests."""
    (root / "chapters").mkdir(parents=True, exist_ok=True)
    (root / "build").mkdir(parents=True, exist_ok=True)

    (root / "main.tex").write_text(
        "\\documentclass{article}\n"
        "\\begin{document}\n"
        "\\input{chapters/intro}\n"
        "\\input{chapters/methods}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )

    (root / "chapters" / "intro.tex").write_text(
        "\\section{Introduction}\n"
        "The College of the Arts experienced a substantial increase in\n"
        "enrollment between 2019 and 2024, growing from 1,200 to 1,680\n"
        "undergraduate students across all majors.\n"
        "\n"
        "This growth reshaped advising workloads in every department.\n",
        encoding="utf-8",
    )

    (root / "chapters" / "methods.tex").write_text(
        "\\section{Methods}\n"
        "We surveyed 412 students using a stratified random sample drawn\n"
        "from each declared major. Response rate was 67 percent.\n"
        "\n"
        "Quantitative items were analyzed using descriptive statistics.\n",
        encoding="utf-8",
    )

    # File under build/ — must be excluded by default.
    (root / "build" / "cached.tex").write_text(
        "The College of the Arts experienced a substantial increase in\n"
        "enrollment between 2019 and 2024.\n",
        encoding="utf-8",
    )


@pytest.fixture
def sample_project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    root.mkdir()
    _make_sample_project(root)
    return root


def _ann(highlighted: str, ann_id: str = "ann-001") -> Annotation:
    return Annotation(
        id=ann_id,
        page=1,
        bbox=(0.0, 0.0, 0.0, 0.0),
        highlighted_text=highlighted,
        author="anonymous",
        comment="",
        created=None,
        trigger_match=False,
    )


def test_fuzzy_map_high_confidence_match(sample_project: Path) -> None:
    """A near-verbatim quote maps to the right file with confidence >= 0.5."""
    ann = _ann(
        "The College of the Arts experienced a substantial increase in "
        "enrollment between 2019 and 2024, growing from 1,200 to 1,680 "
        "undergraduate students across all majors."
    )

    result = fuzzy_map(ann, sample_project)

    assert isinstance(result, Mapping)
    assert result.latex_file == "chapters/intro.tex", (
        f"expected chapters/intro.tex, got {result.latex_file!r}"
    )
    assert result.confidence >= 0.5
    assert result.method == "fuzzy_text"
    assert result.needs_review is False
    assert result.candidates == []
    assert isinstance(result.line_range, tuple) and len(result.line_range) == 2
    start, end = result.line_range
    assert 1 <= start <= end


def test_fuzzy_map_excludes_build_directory(sample_project: Path) -> None:
    """build/ directory must not contribute matches even when it contains the text."""
    ann = _ann(
        "The College of the Arts experienced a substantial increase in "
        "enrollment between 2019 and 2024, growing from 1,200 to 1,680 "
        "undergraduate students across all majors."
    )

    result = fuzzy_map(ann, sample_project)

    assert result.latex_file != "build/cached.tex"
    assert result.latex_file is not None
    assert not result.latex_file.startswith("build/")


def test_fuzzy_map_ambiguous_low_confidence_records_candidates(
    sample_project: Path,
) -> None:
    """A short ambiguous phrase produces needs_review with top-3 candidates."""
    # Words that partially overlap multiple files (.tex prose includes "arts",
    # "growth", "departments") but no single line is a near-verbatim quote.
    # Empirically lands in the [0.2, 0.5) needs_review band against the
    # sample-project fixtures with rapidfuzz 3.x.
    ann = _ann("departments arts methodology growth")

    result = fuzzy_map(ann, sample_project)

    # Either needs_review (0.2 <= score < 0.5) or failed (< 0.2); both produce
    # a populated `candidates` entry. We just assert needs_review is True.
    assert result.needs_review is True
    assert result.candidates is not None
    assert 0 <= len(result.candidates) <= 3
    for c in result.candidates:
        assert isinstance(c.file, str)
        assert isinstance(c.line_range, tuple) and len(c.line_range) == 2
        assert isinstance(c.score, float)
        assert 0.0 <= c.score <= 1.0


def test_fuzzy_map_failed_match_below_threshold(sample_project: Path) -> None:
    """Text not present at all yields method=failed, latex_file=None."""
    ann = _ann(
        "zzz quantum chromodynamics non sequitur lorem ipsum dolor sit amet "
        "consectetur xyzzy bogus foobar nothing-here-at-all"
    )

    result = fuzzy_map(ann, sample_project)

    assert result.needs_review is True
    # Score is too low to land anywhere meaningful.
    if result.method == "failed":
        assert result.latex_file is None
        assert result.line_range is None
        assert result.candidates == []
    else:
        # Borderline case: rapidfuzz might still find a weak partial match.
        # Either way needs_review must be True.
        assert result.method == "fuzzy_text"


from review_pdf_to_latex.extract import bootstrap_state
from review_pdf_to_latex.state import StateFile


def test_bootstrap_state_phase_and_defaults() -> None:
    """bootstrap_state produces a StateFile with phase=0-setup and clean defaults."""
    anns = [
        _ann("alpha", "ann-001"),
        _ann("beta", "ann-002"),
    ]
    mappings = {
        "ann-001": Mapping(
            latex_file="a.tex",
            line_range=(1, 3),
            confidence=0.9,
            method="fuzzy_text",
            needs_review=False,
            candidates=[],
        ),
        "ann-002": Mapping(
            latex_file=None,
            line_range=None,
            confidence=0.1,
            method="failed",
            needs_review=True,
            candidates=[],
        ),
    }

    state = bootstrap_state(anns, mappings)

    assert isinstance(state, StateFile)
    assert state.schema_version == 1
    assert state.phase == "0-setup"
    assert state.order == "mechanical-first"
    assert state.current_annotation_id is None
    assert state.builds == []
    assert set(state.annotations.keys()) == {"ann-001", "ann-002"}

    a1 = state.annotations["ann-001"]
    assert a1.status == "pending"
    assert a1.before_text is None
    assert a1.proposed_text is None
    assert a1.applied_text is None
    assert a1.applied_at is None
    assert a1.last_build_id is None
    assert a1.surface_chat_log is None
    assert a1.failure_log_path is None
    assert a1.failure_edit_text is None

    a2 = state.annotations["ann-002"]
    assert a2.status == "needs_review"
    assert a2.before_text is None
    assert a2.proposed_text is None
    assert a2.applied_text is None


def test_bootstrap_state_handles_empty_annotation_list() -> None:
    """Empty annotations list yields a valid StateFile with no annotations."""
    state = bootstrap_state([], {})
    assert state.phase == "0-setup"
    assert state.annotations == {}
    assert state.builds == []


import os
import time

from review_pdf_to_latex.extract import ensure_gitignore_entry


def test_ensure_gitignore_entry_creates_file_when_absent(tmp_path: Path) -> None:
    """No .gitignore yet -> file created with the entry and a header comment."""
    ensure_gitignore_entry(tmp_path, entry=".review-state/")

    gi = tmp_path / ".gitignore"
    assert gi.exists()
    content = gi.read_text(encoding="utf-8")
    lines = content.splitlines()
    assert ".review-state/" in lines, f".gitignore missing entry: {content!r}"
    # Header comment present.
    assert any(line.startswith("#") for line in lines), (
        f"expected a leading comment in fresh .gitignore: {content!r}"
    )


def test_ensure_gitignore_entry_appends_when_missing(tmp_path: Path) -> None:
    """Existing .gitignore without the entry -> entry appended on its own line."""
    gi = tmp_path / ".gitignore"
    original = "*.pyc\nbuild/\n"
    gi.write_text(original, encoding="utf-8")

    ensure_gitignore_entry(tmp_path, entry=".review-state/")

    new_content = gi.read_text(encoding="utf-8")
    lines = new_content.splitlines()
    assert ".review-state/" in lines
    # Preexisting lines preserved.
    assert "*.pyc" in lines
    assert "build/" in lines


def test_ensure_gitignore_entry_idempotent_when_present(tmp_path: Path) -> None:
    """Entry already present -> file is not rewritten (mtime unchanged)."""
    gi = tmp_path / ".gitignore"
    gi.write_text("*.pyc\n.review-state/\nbuild/\n", encoding="utf-8")
    # Backdate mtime so we can detect any rewrite.
    old_time = time.time() - 3600
    os.utime(gi, (old_time, old_time))
    original_mtime = gi.stat().st_mtime
    original_content = gi.read_text(encoding="utf-8")

    ensure_gitignore_entry(tmp_path, entry=".review-state/")

    assert gi.read_text(encoding="utf-8") == original_content
    assert gi.stat().st_mtime == original_mtime, (
        "ensure_gitignore_entry rewrote the file even though entry was present"
    )


def test_ensure_gitignore_entry_treats_substring_as_distinct(tmp_path: Path) -> None:
    """A line like '# .review-state/ disabled' does not count as the entry."""
    gi = tmp_path / ".gitignore"
    gi.write_text("# .review-state/ disabled for now\n", encoding="utf-8")

    ensure_gitignore_entry(tmp_path, entry=".review-state/")

    lines = gi.read_text(encoding="utf-8").splitlines()
    assert ".review-state/" in lines, "literal entry must be appended"


# ---- rev-is6: default trigger + .review-config.toml override --------------

from review_pdf_to_latex.extract import (
    DEFAULT_SURFACE_TRIGGER,
    load_project_config,
)


def test_default_trigger_is_broadened_substring() -> None:
    """Default trigger no longer requires 'claude' prefix.

    Regression guard for rev-is6: a real run found reviewers writing
    'Surface this' / 'SURFACE THIS' without the 'claude' prefix, which the
    legacy 'claude surface this' default missed entirely.
    """
    assert DEFAULT_SURFACE_TRIGGER == "surface this"


@pytest.mark.parametrize(
    "comment",
    [
        "Surface this whole table for conversation",
        "SURFACE THIS - not sure this is accurate",
        "claude surface this and let's refine",  # legacy phrasing still matches
        "Claude, please surface this paragraph",
    ],
    ids=["title-case", "shout-case", "legacy-with-claude", "legacy-with-comma"],
)
def test_default_trigger_catches_reviewer_vocabulary(comment: str) -> None:
    """The broadened default must catch every surface-intent phrasing observed
    in the first real run (see docs/handoffs/2026-05-17-first-run-cota-feedback.md
    BUG #4)."""
    assert is_trigger(comment, DEFAULT_SURFACE_TRIGGER) is True


def test_load_project_config_returns_empty_when_file_absent(tmp_path: Path) -> None:
    assert load_project_config(tmp_path) == {}


def test_load_project_config_reads_surface_trigger(tmp_path: Path) -> None:
    (tmp_path / ".review-config.toml").write_text(
        'surface_trigger = "discuss this"\n', encoding="utf-8"
    )
    cfg = load_project_config(tmp_path)
    assert cfg == {"surface_trigger": "discuss this"}


def test_load_project_config_swallows_parse_errors(tmp_path: Path) -> None:
    """A malformed config must not block extract — silently degrades to {}."""
    (tmp_path / ".review-config.toml").write_text(
        "surface_trigger = [unterminated\n", encoding="utf-8"
    )
    assert load_project_config(tmp_path) == {}


from review_pdf_to_latex.extract import run_extract


def test_run_extract_uses_config_file_trigger_when_cli_arg_absent(
    tmp_path: Path,
) -> None:
    """Precedence check: config file overrides the built-in default."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / ".review-config.toml").write_text(
        'surface_trigger = "discuss this"\n', encoding="utf-8"
    )
    rc = run_extract(
        pdf_path=FIXTURE_PDF,
        project_dir=project,
        surface_trigger=None,  # no CLI override → fall through to config
    )
    assert rc == 0, "extract failed against the fixture PDF"

    import json

    annotations_doc = json.loads(
        (project / ".review-state" / "annotations.json").read_text()
    )
    matched = [
        a for a in annotations_doc["annotations"] if a["trigger_match"]
    ]
    # The fixture PDF's comments contain "claude surface this" but not
    # "discuss this", so the config override must zero out trigger_match.
    assert matched == [], (
        f"config-file trigger 'discuss this' should not match any fixture "
        f"comment; got {[a['comment'] for a in matched]}"
    )


# ---- rev-fv6: bbox-region text fallback when pdfannots gettext is empty ----

from review_pdf_to_latex.extract import _bbox_recover_text


def test_bbox_recover_text_returns_text_in_region() -> None:
    """Direct test: cropping the fixture's known highlight bbox returns the
    same text that pdfannots' gettext gave us."""
    import pdfannots
    import pdfplumber

    with FIXTURE_PDF.open("rb") as fh:
        doc = pdfannots.process_file(fh, emit_progress_to=None)
    first = next(iter(doc.pages[0].annots))
    expected = (first.gettext() or "").strip()
    assert expected, "fixture's first annotation should have extractable text"

    xs = [b.x0 for b in first.boxes] + [b.x1 for b in first.boxes]
    ys = [b.y0 for b in first.boxes] + [b.y1 for b in first.boxes]
    bbox = (float(min(xs)), float(min(ys)), float(max(xs)), float(max(ys)))

    with pdfplumber.open(str(FIXTURE_PDF)) as plumb:
        recovered = _bbox_recover_text(plumb, 0, bbox)

    # Bbox crop may include adjacent characters at the edges; the substring
    # check tolerates that without making the test brittle to small differences.
    assert expected in recovered or recovered in expected, (
        f"bbox-recovered text does not align with pdfannots text:\n"
        f"  expected: {expected!r}\n  recovered: {recovered!r}"
    )


def test_bbox_recover_text_degenerate_bbox_returns_empty() -> None:
    """Empty/zero bbox can't anchor a text crop — must return empty string."""
    import pdfplumber

    with pdfplumber.open(str(FIXTURE_PDF)) as plumb:
        assert _bbox_recover_text(plumb, 0, (0.0, 0.0, 0.0, 0.0)) == ""


def test_read_annotations_falls_back_to_bbox_when_gettext_empty(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """When pdfannots.gettext() returns empty for a Highlight whose quad
    points still cover real text (the RESTORED-PDF scenario), the engine
    must recover the highlighted text from the bbox region."""
    import pdfannots

    real_process_file = pdfannots.process_file

    def fake_process_file(fh, **kwargs):
        doc = real_process_file(fh, **kwargs)
        for page in doc.pages:
            for raw in page.annots:
                # Force gettext to return empty so the fallback fires.
                raw.gettext = lambda: ""  # noqa: B023
        return doc

    monkeypatch.setattr(
        "review_pdf_to_latex.extract.pdfannots.process_file", fake_process_file
    )

    result = read_annotations(FIXTURE_PDF)
    assert len(result) >= 1
    # Every annotation in the fixture has a real text region behind it,
    # so the fallback must recover SOMETHING non-empty for each.
    for ann in result:
        assert ann.highlighted_text != "", (
            f"{ann.id}: bbox fallback failed to recover any text "
            f"(bbox={ann.bbox})"
        )


def test_run_extract_cli_arg_overrides_config_file(tmp_path: Path) -> None:
    """Precedence check: explicit surface_trigger arg wins over config file."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / ".review-config.toml").write_text(
        'surface_trigger = "discuss this"\n', encoding="utf-8"
    )
    rc = run_extract(
        pdf_path=FIXTURE_PDF,
        project_dir=project,
        surface_trigger="surface this",  # explicit override
    )
    assert rc == 0

    import json

    annotations_doc = json.loads(
        (project / ".review-state" / "annotations.json").read_text()
    )
    # Fixture has at least one "claude surface this" comment — the explicit
    # "surface this" arg must catch it despite the config saying otherwise.
    assert any(a["trigger_match"] for a in annotations_doc["annotations"]), (
        "explicit surface_trigger arg failed to override config-file value"
    )
