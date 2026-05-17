"""LaTeX compilation orchestration and per-build artifact capture.

Implements spec §8 (build row), §11.1 (build strategy), §11.2 (pagination diff),
§11.3 (compile-time benchmark). See `apply.py` for .tex mutation; this module
only reads .tex files and writes PDF + log artifacts.
"""
from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
import tempfile
import time
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


# Number of pdflatex/xelatex passes to ensure cross-references resolve.
_LATEX_PASSES = 2

# Regex on the first 50 lines that flips engine auto-detect to xelatex.
# Spec §10 / §14-risk-10: xelatex needed if fontspec / xeCJK / unicode-math present.
_XELATEX_HINTS = re.compile(
    r"\\usepackage(?:\[[^\]]*\])?\{(?:fontspec|xeCJK|unicode-math)\}"
)


def _detect_engine(main_file: Path) -> str:
    """Peek at the first 50 lines of main_file; return 'xelatex' if a hint is
    found, otherwise 'pdflatex'. Used when caller passes engine='auto'."""
    try:
        with main_file.open("r", encoding="utf-8", errors="replace") as f:
            head = "".join(next_line for _, next_line in zip(range(50), f))
    except FileNotFoundError:
        return "pdflatex"
    if _XELATEX_HINTS.search(head):
        return "xelatex"
    return "pdflatex"


def run_latex(
    main_file: Path,
    engine: str = "auto",
    log_path: Path | None = None,
    timeout_sec: int = 120,
) -> tuple[bool, Path]:
    """Run the LaTeX engine `_LATEX_PASSES` times in the main file's directory.

    Args:
        main_file: Absolute path to the LaTeX entry point (`.tex`).
        engine: 'pdflatex', 'xelatex', or 'auto' (default).
        log_path: Where to write combined stdout+stderr from all passes.
            If None, writes to a sibling of main_file: main_file.with_suffix('.review-log').
        timeout_sec: Per-pass timeout in seconds.

    Returns:
        (ok, log_path): ok is True iff every pass exited 0 AND the expected
        .pdf was produced; log_path is the path the log was written to.
    """
    main_file = Path(main_file).resolve()
    if engine == "auto":
        engine = _detect_engine(main_file)
    if engine not in ("pdflatex", "xelatex"):
        raise ValueError(f"unknown engine: {engine!r}")

    if log_path is None:
        log_path = main_file.with_suffix(".review-log")
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    work_dir = main_file.parent
    job = main_file.stem

    log_chunks: list[bytes] = []
    ok = True
    for pass_index in range(_LATEX_PASSES):
        cmd = [
            engine,
            "-interaction=nonstopmode",
            "-halt-on-error",
            "-file-line-error",
            f"-jobname={job}",
            main_file.name,
        ]
        try:
            result = subprocess.run(  # noqa: S603 -- engine paths come from PATH lookup
                cmd,
                cwd=str(work_dir),
                capture_output=True,
                timeout=timeout_sec,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            log_chunks.append(
                f"\n=== pass {pass_index} TIMED OUT after {timeout_sec}s ===\n".encode()
            )
            log_chunks.append(exc.stdout or b"")
            log_chunks.append(exc.stderr or b"")
            ok = False
            break

        log_chunks.append(f"\n=== pass {pass_index} ===\n".encode())
        log_chunks.append(result.stdout or b"")
        log_chunks.append(result.stderr or b"")
        if result.returncode != 0:
            ok = False
            break

    if ok:
        pdf_path = work_dir / f"{job}.pdf"
        if not pdf_path.exists():
            log_chunks.append(b"\n=== engine exited 0 but no PDF produced ===\n")
            ok = False

    log_path.write_bytes(b"".join(log_chunks))
    return ok, log_path
