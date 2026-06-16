from __future__ import annotations

import os
import shutil
import textwrap
from pathlib import Path

import pytest

from review_pdf_to_latex.build import run_latex


pdflatex = pytest.mark.skipif(
    shutil.which("pdflatex") is None,
    reason="pdflatex not on PATH; install TeX Live to run this test",
)
xelatex = pytest.mark.skipif(
    shutil.which("xelatex") is None,
    reason="xelatex not on PATH; install TeX Live to run this test",
)


def _write_minimal_tex(dir_: Path, name: str = "main.tex", body: str = "hi") -> Path:
    src = dir_ / name
    src.write_text(
        textwrap.dedent(
            r"""
            \documentclass{article}
            \begin{document}
            %s
            \end{document}
            """
        ).strip()
        % body,
        encoding="utf-8",
    )
    return src


@pdflatex
def test_run_latex_pdflatex_success(tmp_path: Path) -> None:
    main = _write_minimal_tex(tmp_path, name="main.tex", body="hi")
    log_dir = tmp_path / ".review-state" / "builds"
    log_dir.mkdir(parents=True)
    log_path = log_dir / "build-001.log"

    ok, returned_log = run_latex(
        main_file=main,
        engine="pdflatex",
        log_path=log_path,
        timeout_sec=120,
    )

    assert ok is True
    assert returned_log == log_path
    assert log_path.exists()
    assert (tmp_path / "main.pdf").exists()


@pdflatex
def test_run_latex_pdflatex_failure_returns_false_and_log(tmp_path: Path) -> None:
    # \undefined is not a valid control sequence; pdflatex will error.
    src = tmp_path / "main.tex"
    src.write_text(
        r"""\documentclass{article}
\begin{document}
\undefined
\end{document}
""",
        encoding="utf-8",
    )
    log_path = tmp_path / "build.log"

    ok, returned_log = run_latex(
        main_file=src,
        engine="pdflatex",
        log_path=log_path,
        timeout_sec=120,
    )

    assert ok is False
    assert returned_log == log_path
    # Log captures stdout+stderr from the engine
    log_text = log_path.read_text(encoding="utf-8", errors="replace")
    assert "undefined" in log_text.lower() or "error" in log_text.lower()


def test_run_latex_auto_picks_xelatex_for_fontspec(tmp_path: Path, monkeypatch) -> None:
    main = tmp_path / "main.tex"
    main.write_text(
        r"""\documentclass{article}
\usepackage{fontspec}
\begin{document}
hi
\end{document}
""",
        encoding="utf-8",
    )
    captured: dict[str, str] = {}

    def fake_run(cmd, **kwargs):  # noqa: ANN001
        captured["engine"] = cmd[0]
        # Pretend the engine wrote a .pdf so success path is exercised.
        pdf = main.with_suffix(".pdf")
        pdf.write_bytes(b"%PDF-1.4 fake\n")

        class _Result:
            returncode = 0
            stdout = b""
            stderr = b""

        return _Result()

    import subprocess

    monkeypatch.setattr(subprocess, "run", fake_run)

    log_path = tmp_path / "build.log"
    ok, _ = run_latex(
        main_file=main,
        engine="auto",
        log_path=log_path,
        timeout_sec=120,
    )

    assert ok is True
    assert captured["engine"] == "xelatex"


import warnings as _warnings

from review_pdf_to_latex.build import next_build_id


def _state_with_builds(n: int) -> dict:
    """Synthesize a state dict with n build entries; only the .id field
    matters for the next_build_id contract."""
    width = 3 if n < 999 else 4
    return {
        "builds": [
            {"id": f"build-{i + 1:0{width}d}"} for i in range(n)
        ]
    }


def test_next_build_id_empty() -> None:
    state = {"builds": []}
    assert next_build_id(state) == "build-001"


def test_next_build_id_after_five() -> None:
    state = _state_with_builds(5)
    assert next_build_id(state) == "build-006"


def test_next_build_id_widens_past_999() -> None:
    state = _state_with_builds(999)
    with _warnings.catch_warnings(record=True) as captured:
        _warnings.simplefilter("always")
        result = next_build_id(state)
    assert result == "build-1000"
    assert any("widening" in str(w.message).lower() for w in captured), (
        f"expected widening warning, got {[str(w.message) for w in captured]}"
    )


from review_pdf_to_latex.build import (
    PaginationDiff,
    compute_page_md5s,
    paginate_diff,
)


pdftoppm = pytest.mark.skipif(
    shutil.which("pdftoppm") is None,
    reason="pdftoppm not on PATH; install Poppler",
)


@pdftoppm
@pdflatex
def test_compute_page_md5s_returns_one_per_page(tmp_path: Path) -> None:
    # Produce a 2-page PDF via pdflatex.
    src = tmp_path / "two.tex"
    src.write_text(
        r"""\documentclass{article}
\begin{document}
page one
\newpage
page two
\end{document}
""",
        encoding="utf-8",
    )
    ok, _ = run_latex(main_file=src, engine="pdflatex", log_path=tmp_path / "l.log")
    assert ok is True
    md5s = compute_page_md5s(tmp_path / "two.pdf")
    assert len(md5s) == 2
    # MD5 hex digests are 32 chars
    assert all(len(h) == 32 and int(h, 16) >= 0 for h in md5s)
    # Two visually distinct pages → distinct hashes
    assert md5s[0] != md5s[1]


@pytest.mark.parametrize(
    "prev, curr, expected_count, expected_first, expected_summary_contains",
    [
        # Identical builds → no shift
        (["a", "b", "c"], ["a", "b", "c"], (3, 3), None, "no shift"),
        # Same count, content shift on page 2
        (["a", "b", "c"], ["a", "X", "c"], (3, 3), 2, "content shift at p.2"),
        # Page count increases; shift starts where divergence first appears
        (["a", "b", "c"], ["a", "b", "Y", "c"], (3, 4), 3, "3 → 4 pages"),
        # Page count decreases
        (["a", "b", "c", "d"], ["a", "b"], (4, 2), 3, "4 → 2 pages"),
        # No prior build (cold start)
        ([], ["a", "b"], (0, 2), None, "initial build"),
    ],
)
def test_paginate_diff_cases(
    prev, curr, expected_count, expected_first, expected_summary_contains
) -> None:
    diff = paginate_diff(prev, curr)
    assert isinstance(diff, PaginationDiff)
    assert (diff.prev_count, diff.curr_count) == expected_count
    assert diff.first_changed_page == expected_first
    assert expected_summary_contains in diff.summary


# ---- Task 5.4: discover_main_file + run_build_command -----------------------

import json

from review_pdf_to_latex.build import discover_main_file, run_build_command


def test_discover_main_file_prefers_build_subdir(tmp_path: Path) -> None:
    (tmp_path / "build").mkdir()
    main = tmp_path / "build" / "full_report.tex"
    main.write_text(
        r"""\documentclass{article}
\begin{document}
\end{document}
""",
        encoding="utf-8",
    )
    other = tmp_path / "other.tex"
    other.write_text(
        r"""\documentclass{article}
\begin{document}
\end{document}
""",
        encoding="utf-8",
    )
    discovered = discover_main_file(tmp_path)
    assert discovered == main


def test_discover_main_file_falls_back_to_project_root(tmp_path: Path) -> None:
    main = tmp_path / "report.tex"
    main.write_text(
        r"""\documentclass{article}
\begin{document}
\end{document}
""",
        encoding="utf-8",
    )
    assert discover_main_file(tmp_path) == main


def test_discover_main_file_raises_when_none_found(tmp_path: Path) -> None:
    (tmp_path / "stub.tex").write_text("just a fragment", encoding="utf-8")
    with pytest.raises(FileNotFoundError):
        discover_main_file(tmp_path)


@pdflatex
@pdftoppm
def test_run_build_command_appends_state_entry(tmp_path: Path) -> None:
    # Construct a minimal project tree with .review-state already extracted.
    project = tmp_path / "proj"
    (project / "build").mkdir(parents=True)
    main = project / "build" / "full_report.tex"
    main.write_text(
        r"""\documentclass{article}
\begin{document}
hello
\end{document}
""",
        encoding="utf-8",
    )

    state_dir = project / ".review-state"
    (state_dir / "builds").mkdir(parents=True)
    state_path = state_dir / "state.json"
    state_path.write_text(
        json.dumps(
            {
                "schema_version": 2,
                "phase": "1-batch",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {},
                "builds": [],
            }
        ),
        encoding="utf-8",
    )

    exit_code = run_build_command(
        project_dir=project,
        main_file=None,
        engine="auto",
        quiet=True,
        benchmark=False,
    )

    assert exit_code == 0
    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert len(state["builds"]) == 1
    entry = state["builds"][0]
    assert entry["id"] == "build-001"
    assert entry["ok"] is True
    assert entry["page_count"] >= 1
    assert isinstance(entry["page_md5"], list)
    assert entry["pdf_path"].endswith("build-001.pdf")
    assert entry["log_path"].endswith("build-001.log")
    assert (state_dir / "builds" / "build-001.pdf").exists()
    assert (state_dir / "builds" / "build-001.log").exists()


def test_run_build_command_exits_12_when_main_missing(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    project.mkdir()
    state_dir = project / ".review-state"
    state_dir.mkdir()
    (state_dir / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 2,
                "phase": "1-batch",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {},
                "builds": [],
            }
        ),
        encoding="utf-8",
    )
    exit_code = run_build_command(
        project_dir=project,
        main_file=None,
        engine="auto",
        quiet=True,
        benchmark=False,
    )
    assert exit_code == 12


def test_run_build_command_exits_6_when_state_missing(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    project.mkdir()
    exit_code = run_build_command(
        project_dir=project,
        main_file=None,
        engine="auto",
        quiet=True,
        benchmark=False,
    )
    assert exit_code == 6
