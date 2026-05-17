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
