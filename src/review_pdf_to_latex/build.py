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


def next_build_id(state: dict) -> str:
    """Return the next zero-padded build ID for the given state file.

    IDs are 3-digit decimal (`build-001` .. `build-999`). On the 1000th build
    we widen to 4 digits (`build-1000`) and emit a UserWarning per spec §8
    `build` row commentary / §19 Glossary "Build ID".
    """
    existing = state.get("builds") or []
    n = len(existing)
    next_n = n + 1
    if next_n >= 1000:
        warnings.warn(
            "Project exceeded 999 builds; widening to 4-digit IDs",
            stacklevel=2,
        )
        return f"build-{next_n:04d}"
    return f"build-{next_n:03d}"


@dataclass(frozen=True)
class PaginationDiff:
    """Result of comparing two builds' per-page MD5 lists.

    Fields:
        prev_count: Page count of the previous successful build (0 if none).
        curr_count: Page count of the current build.
        first_changed_page: 1-indexed page where the two builds first diverge,
            or None if they are identical.
        summary: Human-readable indicator string suitable for the viewer's
            pagination pane (see spec §10.1, §11.2). Examples:
                "3 → 3 pages, no shift"
                "3 → 3 pages, content shift at p.2"
                "3 → 4 pages, shift at p.3"
                "initial build, 2 pages" (cold start, no prior)
    """

    prev_count: int
    curr_count: int
    first_changed_page: int | None
    summary: str


def compute_page_md5s(pdf_path: Path) -> list[str]:
    """Render each page of pdf_path to PNG via pdftoppm; return MD5 hex digests.

    Renders into a temp directory that is deleted on return. The choice of PNG
    (rather than text via pdftotext) is for fidelity per spec §11.2: a page that
    only changes a figure caption width would not change its text content but
    would change its rendered image.

    Resolution is 100 DPI — high enough that font hinting variation does not
    flip pixels, low enough that a 24-page report renders in < 1s.
    """
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(pdf_path)

    with tempfile.TemporaryDirectory(prefix="review-pdf-pages-") as td:
        out_root = Path(td) / "page"
        # pdftoppm writes page-1.png, page-2.png, ... with -png and a numeric suffix.
        subprocess.run(  # noqa: S603
            [
                "pdftoppm",
                "-r",
                "100",
                "-png",
                str(pdf_path),
                str(out_root),
            ],
            check=True,
            capture_output=True,
        )
        pages = sorted(
            Path(td).glob("page-*.png"),
            key=lambda p: int(p.stem.rsplit("-", 1)[1]),
        )
        return [hashlib.md5(p.read_bytes()).hexdigest() for p in pages]


def paginate_diff(prev: list[str], curr: list[str]) -> PaginationDiff:
    """Compare two per-page MD5 lists; return a PaginationDiff per spec §11.2.

    Cases (matching spec §11.2):
        - No prior build: `summary = "initial build, N pages"`,
          `first_changed_page = None`.
        - Same count, identical hashes: `"N → N pages, no shift"`.
        - Same count, hashes differ at page k (1-indexed):
          `"N → N pages, content shift at p.k"`.
        - Page count differs: walk forward to find the first index where
          hashes diverge (or where one list runs out); report
          `"M → N pages, shift at p.k"`.
    """
    pc, cc = len(prev), len(curr)
    if pc == 0:
        return PaginationDiff(0, cc, None, f"initial build, {cc} pages")

    if pc == cc:
        for i, (a, b) in enumerate(zip(prev, curr)):
            if a != b:
                return PaginationDiff(
                    pc,
                    cc,
                    i + 1,
                    f"{pc} → {cc} pages, content shift at p.{i + 1}",
                )
        return PaginationDiff(pc, cc, None, f"{pc} → {cc} pages, no shift")

    # Page count delta: find first divergence
    first: int | None = None
    for i in range(min(pc, cc)):
        if prev[i] != curr[i]:
            first = i + 1
            break
    if first is None:
        # One is a strict prefix of the other; divergence is at min+1
        first = min(pc, cc) + 1
    return PaginationDiff(pc, cc, first, f"{pc} → {cc} pages, shift at p.{first}")


# ---- Task 5.4: main-file discovery + CLI orchestration ----------------------

# Spec §15-Q5: heuristic order is (1) any *.tex under build/ that contains
# \documentclass, (2) any *.tex under project_root with \documentclass.
# We additionally require \begin{document} to co-occur, matching §14-risk-7.
_DOCCLASS_RE = re.compile(r"\\documentclass\b")
_BEGINDOC_RE = re.compile(r"\\begin\{document\}")


def _file_is_main(path: Path) -> bool:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return False
    return bool(_DOCCLASS_RE.search(text) and _BEGINDOC_RE.search(text))


def discover_main_file(project_dir: Path) -> Path:
    """Find the LaTeX entry point under ``project_dir``.

    Search order:
        1. ``project_dir/build/*.tex`` with both ``\\documentclass`` and
           ``\\begin{document}``.
        2. ``project_dir/**/*.tex`` (recursive) with both markers, excluding
           the ``.review-state`` directory and any ``*.tex`` under
           ``templates/`` (those are typically ``\\input`` fragments).

    Raises:
        FileNotFoundError: no candidate file found.
    """
    project_dir = Path(project_dir)
    build_dir = project_dir / "build"
    if build_dir.is_dir():
        for candidate in sorted(build_dir.glob("*.tex")):
            if _file_is_main(candidate):
                return candidate

    for candidate in sorted(project_dir.rglob("*.tex")):
        if ".review-state" in candidate.parts:
            continue
        if "templates" in candidate.parts:
            continue
        if _file_is_main(candidate):
            return candidate

    raise FileNotFoundError(
        f"No LaTeX main file found under {project_dir!s}: looked for files "
        "containing both \\documentclass and \\begin{document}"
    )


def run_build_command(
    project_dir: Path,
    main_file: Path | None,
    engine: str,
    quiet: bool,
    benchmark: bool,
) -> int:
    """CLI handler for ``review-pdf build``. Returns the process exit code.

    Side effects:
        - Runs run_latex on the discovered (or supplied) main file.
        - Copies output PDF + log into .review-state/builds/build-NNN.{pdf,log}.
        - Computes per-page MD5s and pagination diff vs. previous successful build.
        - Appends a build record to state.json.builds[] via atomic_write_json.
        - Emits pagination summary to stdout (unless --quiet for ID-only output).

    Exit codes per spec §8:
        0: build succeeded.
        11: build failed (log path printed to stderr).
        12: main file not found.
        6: state.json missing.
    """
    import sys

    from review_pdf_to_latex.state import atomic_write_json, read_json

    project_dir = Path(project_dir).resolve()
    state_dir = project_dir / ".review-state"
    state_path = state_dir / "state.json"
    if not state_path.exists():
        print(f"error: state.json not found at {state_path}", file=sys.stderr)
        return 6

    if main_file is None:
        try:
            main_file = discover_main_file(project_dir)
        except FileNotFoundError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 12
    else:
        main_file = Path(main_file).resolve()
        if not main_file.exists():
            print(f"error: main file not found: {main_file}", file=sys.stderr)
            return 12

    state = read_json(state_path)
    build_id = next_build_id(state)

    builds_dir = state_dir / "builds"
    builds_dir.mkdir(parents=True, exist_ok=True)
    log_target = builds_dir / f"{build_id}.log"

    start = time.monotonic()
    ok, log_path = run_latex(
        main_file=main_file,
        engine=engine,
        log_path=log_target,
        timeout_sec=120,
    )
    elapsed = time.monotonic() - start

    if benchmark:
        print(f"Compile took {elapsed:.1f}s", file=sys.stderr)

    pdf_target = builds_dir / f"{build_id}.pdf"
    page_md5: list[str] = []
    page_count = 0
    if ok:
        produced_pdf = main_file.with_suffix(".pdf")
        if produced_pdf.exists():
            shutil.copy2(produced_pdf, pdf_target)
            page_md5 = compute_page_md5s(pdf_target)
            page_count = len(page_md5)

    prev_md5s: list[str] = []
    for prior in reversed(state.get("builds", [])):
        if prior.get("ok") and prior.get("page_md5"):
            prev_md5s = list(prior["page_md5"])
            break

    diff = (
        paginate_diff(prev_md5s, page_md5)
        if ok
        else PaginationDiff(len(prev_md5s), 0, None, "build failed")
    )

    entry = {
        "id": build_id,
        "pdf_path": (
            str(pdf_target.relative_to(project_dir)) if pdf_target.exists() else None
        ),
        "log_path": str(log_path.relative_to(project_dir)),
        "page_count": page_count,
        "page_md5": page_md5,
        "ok": ok,
        "compiled_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "elapsed_sec": round(elapsed, 3),
        "pagination_summary": diff.summary,
    }
    state.setdefault("builds", []).append(entry)
    atomic_write_json(state_path, state)

    if not quiet:
        print(f"{build_id}: {diff.summary}")
    if not ok:
        print(f"build failed; see {log_path}", file=sys.stderr)
        return 11
    return 0
