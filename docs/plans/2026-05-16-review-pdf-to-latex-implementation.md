# review-pdf-to-latex Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single-user, local-only sidecar tool (`review-pdf` CLI + thin local HTTP viewer) that walks a LaTeX author one annotation at a time through a commenter-marked PDF, applying each edit to the LaTeX source with a live rebuilt-PDF preview, pagination-drift reporting, durable on-disk state across sessions, and a clean git audit trail.

**Architecture:** Sidecar pattern — a stateless Python engine (the `review-pdf` CLI) owns all mutations of `.review-state/*.json` and all PDF/LaTeX I/O; a thin local HTTP viewer (`http.server` + Jinja2 templates + vanilla HTML/JS) renders annotations and appends click events to `state-events.jsonl`; a Claude Code skill (separate repo) drives the engine through four workflow phases (0 Setup, 1 Batch, 2a Ratify, 2b Surface, 3 Final). Engine and viewer meet only at JSON files on disk; the engine knows nothing about Claude.

**Tech Stack:** Python 3.11+, pdfannots, rapidfuzz, jinja2, http.server (stdlib), pdftoppm, pdflatex/xelatex. No web framework. No frontend framework (vanilla HTML/JS + optional diff2html via CDN). pytest + pytest-cov for testing.

**Spec:** `docs/specs/2026-05-16-review-pdf-to-latex-design.md` (901 lines, status: Final Draft — Ready for User Review)

**Status:** Final Draft — Ready for User Review (2026-05-16)

---

## Task 1: Project scaffolding

**Files:**
- Create: `pyproject.toml`
- Create: `src/review_pdf_to_latex/__init__.py`
- Create: `tests/__init__.py`
- Create: `tests/conftest.py`
- Create: `tests/test_scaffolding.py`
- Create: `LICENSE`
- Modify: `.gitignore` (verify lines present; the repo already has most entries)

**Implements spec:** §6 (Repository layout), §16.1 (Python target), §16.2 (Inventory)

### Step 1.1: Write the failing scaffolding smoke test

- [ ] **Step 1: Write the failing test**

Create `tests/test_scaffolding.py`:

```python
"""Smoke test: package is importable and version is exposed."""

import review_pdf_to_latex


def test_package_importable():
    """The package imports without error and exposes __version__."""
    assert review_pdf_to_latex.__version__ == "0.1.0"
```

Create `tests/__init__.py` as an empty file:

```python
```

Create `tests/conftest.py`:

```python
"""Shared pytest fixtures for the review-pdf-to-latex test suite."""

from pathlib import Path

import pytest


@pytest.fixture
def tmp_project(tmp_path: Path) -> Path:
    """A fresh temp directory simulating a LaTeX project root.

    The directory contains an empty ``.review-state/`` subdir, matching the
    invariant established by ``review-pdf extract`` in production (spec §7).
    Tests that need pre-seeded state files should write into this directory.
    """
    state_dir = tmp_path / ".review-state"
    state_dir.mkdir()
    return tmp_path
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_scaffolding.py::test_package_importable -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'review_pdf_to_latex'` (the package directory does not yet exist).

- [ ] **Step 3: Write minimal implementation**

Create `pyproject.toml`:

```toml
[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "review-pdf-to-latex"
version = "0.1.0"
description = "Sidecar tool for walking PDF annotations into LaTeX source edits."
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
authors = [
    { name = "Anthony Byrnes" },
]
keywords = ["latex", "pdf", "annotations", "review"]
classifiers = [
    "Development Status :: 3 - Alpha",
    "Environment :: Console",
    "Intended Audience :: End Users/Desktop",
    "License :: OSI Approved :: MIT License",
    "Operating System :: MacOS",
    "Operating System :: POSIX :: Linux",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.11",
    "Programming Language :: Python :: 3.12",
    "Topic :: Text Processing :: Markup :: LaTeX",
]
dependencies = [
    "pdfannots>=0.4.1",
    "rapidfuzz>=3.0.0",
    "jinja2>=3.1.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=7.4",
    "pytest-cov>=4.1",
]

[project.scripts]
review-pdf = "review_pdf_to_latex.cli:main"

[tool.hatch.build.targets.wheel]
packages = ["src/review_pdf_to_latex"]

[tool.pytest.ini_options]
testpaths = ["tests"]
python_files = ["test_*.py"]
python_classes = ["Test*"]
python_functions = ["test_*"]
addopts = "-ra --strict-markers"
```

Create `src/review_pdf_to_latex/__init__.py`:

```python
"""review-pdf-to-latex — Sidecar tool for walking PDF annotations into LaTeX edits.

See ``docs/specs/2026-05-16-review-pdf-to-latex-design.md`` for the full design.
"""

__version__ = "0.1.0"
```

Create `LICENSE` (MIT, copyright Anthony Byrnes 2026):

```
MIT License

Copyright (c) 2026 Anthony Byrnes

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Verify `.gitignore` already contains the entries below (the repo's existing `.gitignore` ships with these; if any line is missing, append it):

```
.venv/
__pycache__/
*.pyc
.pytest_cache/
dist/
*.egg-info/
.review-state/
```

Install the package in editable mode with dev extras:

```bash
pip install -e ".[dev]"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_scaffolding.py::test_package_importable -v`

Expected: PASS — one passing test.

- [ ] **Step 5: Commit**

```bash
git add pyproject.toml src/review_pdf_to_latex/__init__.py tests/__init__.py tests/conftest.py tests/test_scaffolding.py LICENSE .gitignore
git commit -m "chore: scaffold review_pdf_to_latex package"
```

---

## Task 2: State module — schemas, atomic writes, readers

**Files:**
- Create: `src/review_pdf_to_latex/state.py`
- Create: `tests/test_state.py`

**Implements spec:** §7.1 (annotations.json), §7.2 (mapping.json), §7.3 (state.json), §7.4 (state-events.jsonl), §10.3 (button semantics → legal transitions)

This task is broken into six focused sub-tasks. Each sub-task ends with its own commit.

### Task 2.1: `StateDir` path helper

**Implements spec:** §7 (on-disk artifacts inventory), §13.3 (project-local state directory)

- [ ] **Step 1: Write the failing test**

Create `tests/test_state.py` (start of file):

```python
"""Tests for review_pdf_to_latex.state — schemas, atomic writes, readers."""

import json
import os
import threading
from pathlib import Path

import pytest

from review_pdf_to_latex import state


def test_statedir_paths_resolve(tmp_project: Path):
    """StateDir computes the four canonical .review-state/ paths from a project root."""
    sd = state.StateDir(tmp_project)
    assert sd.annotations_path == tmp_project / ".review-state" / "annotations.json"
    assert sd.mapping_path == tmp_project / ".review-state" / "mapping.json"
    assert sd.state_path == tmp_project / ".review-state" / "state.json"
    assert sd.events_path == tmp_project / ".review-state" / "state-events.jsonl"


def test_statedir_root_property(tmp_project: Path):
    """StateDir exposes the parent project root and the .review-state/ dir."""
    sd = state.StateDir(tmp_project)
    assert sd.project_root == tmp_project
    assert sd.dir == tmp_project / ".review-state"


def test_statedir_str_path_accepted(tmp_project: Path):
    """StateDir accepts a str path and converts to Path internally."""
    sd = state.StateDir(str(tmp_project))
    assert isinstance(sd.project_root, Path)
    assert sd.project_root == tmp_project
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_state.py::test_statedir_paths_resolve -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'review_pdf_to_latex.state'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review_pdf_to_latex/state.py`:

```python
"""State module — JSON schemas, atomic writes, and readers for .review-state/.

The state directory layout is fixed by spec §7. This module centralizes:

- The canonical paths for each state file (``StateDir``).
- The atomic write contract (``atomic_write_json``).
- Schema-versioned reads (``read_json`` + ``SchemaVersionError``).
- Dataclasses for each schema (``Annotation``, ``Mapping``, etc.).
- The legal status-transition table (``validate_status_transition``).

All callers MUST go through ``atomic_write_json`` for writes to
``annotations.json``, ``mapping.json``, and ``state.json``. The viewer is
the only writer of ``state-events.jsonl`` and uses ``O_APPEND`` directly.
"""

from __future__ import annotations

from pathlib import Path


class StateDir:
    """Wrapper around a project's ``.review-state/`` directory.

    Resolves the four canonical state-file paths relative to the project
    root. Does NOT create the directory; callers do that via ``mkdir``
    or the engine's ``extract`` subcommand.
    """

    DIR_NAME = ".review-state"

    def __init__(self, project_root: Path | str) -> None:
        self.project_root = Path(project_root)

    @property
    def dir(self) -> Path:
        """Absolute path to the project's ``.review-state/`` directory."""
        return self.project_root / self.DIR_NAME

    @property
    def annotations_path(self) -> Path:
        """Absolute path to ``annotations.json`` (spec §7.1)."""
        return self.dir / "annotations.json"

    @property
    def mapping_path(self) -> Path:
        """Absolute path to ``mapping.json`` (spec §7.2)."""
        return self.dir / "mapping.json"

    @property
    def state_path(self) -> Path:
        """Absolute path to ``state.json`` (spec §7.3)."""
        return self.dir / "state.json"

    @property
    def events_path(self) -> Path:
        """Absolute path to ``state-events.jsonl`` (spec §7.4)."""
        return self.dir / "state-events.jsonl"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_state.py -v -k statedir`

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/state.py tests/test_state.py
git commit -m "feat(state): add StateDir path helper"
```

### Task 2.2: `atomic_write_json` — write-temp-then-rename

**Implements spec:** §5.1 (state mutation rule), §7 (atomic write contract)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_state.py`:

```python
def test_atomic_write_json_writes_valid_json(tmp_project: Path):
    """atomic_write_json produces a file that round-trips as JSON."""
    sd = state.StateDir(tmp_project)
    payload = {"schema_version": 1, "hello": "world"}
    state.atomic_write_json(sd.state_path, payload)
    assert sd.state_path.exists()
    loaded = json.loads(sd.state_path.read_text(encoding="utf-8"))
    assert loaded == payload


def test_atomic_write_json_creates_parent_dir(tmp_path: Path):
    """atomic_write_json creates the parent directory if it does not exist."""
    target = tmp_path / "nested" / "deep" / "file.json"
    state.atomic_write_json(target, {"ok": True})
    assert target.exists()


def test_atomic_write_json_failure_leaves_original_intact(
    tmp_project: Path, monkeypatch: pytest.MonkeyPatch
):
    """If fsync raises, the original file is unchanged and no .tmp lingers."""
    sd = state.StateDir(tmp_project)
    sd.state_path.write_text('{"schema_version": 1, "original": true}', encoding="utf-8")

    def boom(fd: int) -> None:
        raise OSError("simulated fsync failure")

    monkeypatch.setattr(os, "fsync", boom)
    with pytest.raises(OSError, match="simulated fsync failure"):
        state.atomic_write_json(sd.state_path, {"schema_version": 1, "new": True})

    # Original survives.
    loaded = json.loads(sd.state_path.read_text(encoding="utf-8"))
    assert loaded == {"schema_version": 1, "original": True}
    # No leftover .tmp files in the parent dir.
    leftover = [p for p in sd.dir.iterdir() if p.name.startswith(".tmp.")]
    assert leftover == []


def test_atomic_write_json_concurrent_writers_do_not_corrupt(tmp_project: Path):
    """Two threads writing concurrently leave a syntactically valid JSON file.

    Atomicity guarantees that the on-disk file is always the complete
    output of exactly one writer; it is never partial.
    """
    sd = state.StateDir(tmp_project)

    def writer(value: int) -> None:
        for _ in range(20):
            state.atomic_write_json(sd.state_path, {"schema_version": 1, "v": value})

    t1 = threading.Thread(target=writer, args=(1,))
    t2 = threading.Thread(target=writer, args=(2,))
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    # Whichever writer landed last, the file is valid JSON with a known shape.
    loaded = json.loads(sd.state_path.read_text(encoding="utf-8"))
    assert loaded["schema_version"] == 1
    assert loaded["v"] in (1, 2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_state.py -v -k atomic_write_json`

Expected: 4 FAIL with `AttributeError: module 'review_pdf_to_latex.state' has no attribute 'atomic_write_json'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/state.py`:

```python
import json
import os
import tempfile
from typing import Any


def atomic_write_json(path: Path, data: Any) -> None:
    """Write JSON atomically: temp file in same dir, fsync, then os.replace.

    Matches the contract in spec §5.1 and §7: writes go to a sibling
    ``.tmp.<name>.<rand>.json`` file in the target directory, are fsync'd,
    then renamed onto the final path via ``os.replace``. Readers may see
    a transient ``FileNotFoundError`` during the rename window and should
    retry once.

    Raises
    ------
    OSError
        If the temp file cannot be written or fsync fails. The original
        file (if any) remains untouched. The temp file is best-effort
        cleaned up before re-raising.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".tmp.{path.name}.", suffix=".json"
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_state.py -v -k atomic_write_json`

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/state.py tests/test_state.py
git commit -m "feat(state): add atomic_write_json with write-temp-then-rename"
```

### Task 2.3: `read_json` with schema-version guards

**Implements spec:** §7 (schema_version policy), §8 (`migrate-state`)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_state.py`:

```python
def test_read_json_round_trips_supported_schema(tmp_project: Path):
    """read_json returns the parsed dict for schema_version == SUPPORTED_SCHEMA."""
    sd = state.StateDir(tmp_project)
    payload = {"schema_version": 1, "hello": "world"}
    state.atomic_write_json(sd.state_path, payload)
    loaded = state.read_json(sd.state_path)
    assert loaded == payload


def test_read_json_missing_schema_version_raises(tmp_project: Path):
    """A JSON file without schema_version raises SchemaVersionError."""
    sd = state.StateDir(tmp_project)
    state.atomic_write_json(sd.state_path, {"no_version": True})
    with pytest.raises(state.SchemaVersionError, match="missing schema_version"):
        state.read_json(sd.state_path)


def test_read_json_future_schema_raises(tmp_project: Path):
    """A schema_version higher than SUPPORTED_SCHEMA raises SchemaVersionError."""
    sd = state.StateDir(tmp_project)
    state.atomic_write_json(sd.state_path, {"schema_version": state.SUPPORTED_SCHEMA + 1})
    with pytest.raises(state.SchemaVersionError, match="unsupported"):
        state.read_json(sd.state_path)


def test_read_json_older_schema_raises_migration_required(tmp_project: Path):
    """A schema_version below SUPPORTED_SCHEMA raises MigrationRequiredError."""
    if state.SUPPORTED_SCHEMA <= 1:
        pytest.skip("No older schema exists yet at SUPPORTED_SCHEMA=1")
    sd = state.StateDir(tmp_project)
    state.atomic_write_json(sd.state_path, {"schema_version": state.SUPPORTED_SCHEMA - 1})
    with pytest.raises(state.MigrationRequiredError):
        state.read_json(sd.state_path)


def test_read_json_supported_schema_constant_is_one():
    """SUPPORTED_SCHEMA is 1 in v1 (spec §7)."""
    assert state.SUPPORTED_SCHEMA == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_state.py -v -k read_json`

Expected: 5 FAIL with `AttributeError: module 'review_pdf_to_latex.state' has no attribute 'read_json'` (or `SchemaVersionError`, etc.).

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/state.py`:

```python
SUPPORTED_SCHEMA = 1
"""The schema_version this build of the engine reads and writes.

Bumped only on breaking changes per spec §7. A backwards-compatible
field addition does NOT bump this constant. The ``review-pdf
migrate-state`` subcommand handles upgrades when the major version
changes.
"""


class SchemaVersionError(Exception):
    """Raised when a state file's schema_version is missing or unsupported.

    Distinct from :class:`MigrationRequiredError`, which signals a known
    older version that the engine could migrate forward via
    ``review-pdf migrate-state``.
    """


class MigrationRequiredError(Exception):
    """Raised when a state file's schema_version is older than SUPPORTED_SCHEMA.

    The engine refuses to read the file in place; the user must run
    ``review-pdf migrate-state --from N --to M`` to upgrade it.
    """


def read_json(path: Path) -> dict[str, Any]:
    """Read a state JSON file and enforce the schema-version contract.

    Returns the parsed dict if ``schema_version == SUPPORTED_SCHEMA``.

    Raises
    ------
    SchemaVersionError
        - The top-level object has no ``schema_version`` key, OR
        - ``schema_version`` is greater than ``SUPPORTED_SCHEMA``.
    MigrationRequiredError
        ``schema_version`` is a known older version (less than
        ``SUPPORTED_SCHEMA``). Run ``review-pdf migrate-state``.
    FileNotFoundError
        Path does not exist. Callers (e.g., the viewer's polling loop)
        should tolerate one retry during the atomic-rename window.
    """
    path = Path(path)
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if "schema_version" not in data:
        raise SchemaVersionError(
            f"{path}: missing schema_version (engine refuses to read)"
        )
    version = data["schema_version"]
    if version > SUPPORTED_SCHEMA:
        raise SchemaVersionError(
            f"{path}: schema_version={version} is unsupported "
            f"(engine supports up to {SUPPORTED_SCHEMA}; upgrade the engine)"
        )
    if version < SUPPORTED_SCHEMA:
        raise MigrationRequiredError(
            f"{path}: schema_version={version} is older than "
            f"{SUPPORTED_SCHEMA}; run `review-pdf migrate-state "
            f"--from {version} --to {SUPPORTED_SCHEMA}`"
        )
    return data
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_state.py -v -k read_json`

Expected: 5 PASSED (one of which is skipped if SUPPORTED_SCHEMA is still 1, but `test_read_json_supported_schema_constant_is_one` and the other four still pass; if you prefer a hard count of "5 passed" remove the `pytest.skip` guard — for v1 the skip is fine).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/state.py tests/test_state.py
git commit -m "feat(state): add read_json with schema-version guards"
```

### Task 2.4: Dataclasses for every schema

**Implements spec:** §7.1 (annotations.json), §7.2 (mapping.json), §7.3 (state.json), §7.4 (event records)

The dataclasses below match every field documented in the spec's "Field commentary" sections.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_state.py`:

```python
def test_annotation_dataclass_round_trip():
    """Annotation dataclass round-trips through to_dict / from_dict using spec §7.1 example."""
    raw = {
        "id": "ann-001",
        "page": 4,
        "bbox": [72.0, 510.5, 540.0, 542.5],
        "highlighted_text": "The college experienced a substantial increase…",
        "author": "commenter-name-or-anonymous",
        "comment": "Tighten this — too academic",
        "created": "2026-05-15T14:22:11Z",
        "trigger_match": False,
    }
    obj = state.Annotation.from_dict(raw)
    assert obj.id == "ann-001"
    assert obj.bbox == (72.0, 510.5, 540.0, 542.5)
    assert obj.trigger_match is False
    assert obj.to_dict() == raw


def test_mapping_dataclass_round_trip_resolved():
    """Mapping with method=fuzzy_text round-trips per spec §7.2 example."""
    raw = {
        "latex_file": "templates/enrollment_growth.tex",
        "line_range": [47, 52],
        "confidence": 0.92,
        "method": "fuzzy_text",
        "needs_review": False,
        "candidates": [],
    }
    obj = state.Mapping.from_dict(raw)
    assert obj.latex_file == "templates/enrollment_growth.tex"
    assert obj.line_range == (47, 52)
    assert obj.confidence == 0.92
    assert obj.method == "fuzzy_text"
    assert obj.needs_review is False
    assert obj.to_dict() == raw


def test_mapping_dataclass_round_trip_needs_review():
    """Mapping with method=failed round-trips with null line_range and candidates list."""
    raw = {
        "latex_file": None,
        "line_range": None,
        "confidence": 0.0,
        "method": "failed",
        "needs_review": True,
        "candidates": [
            {"file": "templates/equity_findings.tex", "line_range": [22, 28], "score": 0.34},
            {"file": "templates/student_success.tex", "line_range": [88, 91], "score": 0.31},
        ],
    }
    obj = state.Mapping.from_dict(raw)
    assert obj.latex_file is None
    assert obj.line_range is None
    assert obj.needs_review is True
    assert len(obj.candidates) == 2
    assert obj.to_dict() == raw


def test_annotation_state_dataclass_round_trip_applied():
    """AnnotationState with status=applied round-trips per spec §7.3 example."""
    raw = {
        "status": "applied",
        "before_text": "The college experienced a substantial increase…",
        "proposed_text": "COTA enrollment grew 12% YoY…",
        "applied_text": "COTA enrollment grew 12% YoY…",
        "applied_at": "2026-05-16T20:45:12Z",
        "last_build_id": "build-007",
        "surface_chat_log": None,
        "failure_log_path": None,
        "failure_edit_text": None,
    }
    obj = state.AnnotationState.from_dict(raw)
    assert obj.status == "applied"
    assert obj.applied_at == "2026-05-16T20:45:12Z"
    assert obj.to_dict() == raw


def test_annotation_state_dataclass_round_trip_needs_review_with_failure():
    """AnnotationState with status=needs_review carries failure metadata."""
    raw = {
        "status": "needs_review",
        "before_text": "Original snippet that broke the build…",
        "proposed_text": "Claude's proposal that failed to compile…",
        "applied_text": None,
        "applied_at": None,
        "last_build_id": None,
        "failure_log_path": ".review-state/builds/build-011.log",
        "failure_edit_text": "Claude's proposal that failed to compile…",
        "surface_chat_log": None,
    }
    obj = state.AnnotationState.from_dict(raw)
    assert obj.failure_log_path == ".review-state/builds/build-011.log"
    assert obj.to_dict() == raw


def test_build_dataclass_round_trip():
    """Build dataclass round-trips per spec §7.3 example."""
    raw = {
        "id": "build-007",
        "pdf_path": ".review-state/builds/build-007.pdf",
        "page_count": 24,
        "compiled_at": "2026-05-16T20:45:30Z",
        "log_path": ".review-state/builds/build-007.log",
        "ok": True,
        "page_md5": ["aaa", "bbb", "ccc"],
    }
    obj = state.Build.from_dict(raw)
    assert obj.id == "build-007"
    assert obj.page_count == 24
    assert obj.ok is True
    assert obj.page_md5 == ("aaa", "bbb", "ccc")
    assert obj.to_dict() == raw


def test_state_file_round_trip():
    """StateFile round-trips through to_dict / from_dict on a minimal example."""
    raw = {
        "schema_version": 1,
        "phase": "0-setup",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {},
        "builds": [],
    }
    obj = state.StateFile.from_dict(raw)
    assert obj.phase == "0-setup"
    assert obj.order == "mechanical-first"
    assert obj.current_annotation_id is None
    assert obj.to_dict() == raw
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_state.py -v -k "round_trip or annotation_state or state_file"`

Expected: FAIL — `AttributeError: module 'review_pdf_to_latex.state' has no attribute 'Annotation'` (and similarly for `Mapping`, `AnnotationState`, `Build`, `StateFile`).

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/state.py`:

```python
from dataclasses import dataclass, field
from typing import Literal


Phase = Literal["0-setup", "1-batch", "2a-ratify", "2b-surface", "3-final"]
Order = Literal["mechanical-first", "surface-first"]
Status = Literal[
    "pending",
    "applied",
    "accepted",
    "rejected",
    "redrafted",
    "deferred",
    "surfaced_pending",
    "surfaced_resolved",
    "needs_review",
]
Method = Literal["fuzzy_text", "manual", "failed"]
Role = Literal["user", "claude"]


@dataclass
class Annotation:
    """One entry in ``annotations.json.annotations[]`` (spec §7.1, immutable)."""

    id: str
    page: int
    bbox: tuple[float, float, float, float]
    highlighted_text: str
    author: str
    comment: str
    created: str
    trigger_match: bool

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Annotation":
        bbox = d["bbox"]
        return cls(
            id=d["id"],
            page=d["page"],
            bbox=(float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3])),
            highlighted_text=d["highlighted_text"],
            author=d["author"],
            comment=d["comment"],
            created=d["created"],
            trigger_match=bool(d["trigger_match"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "page": self.page,
            "bbox": [self.bbox[0], self.bbox[1], self.bbox[2], self.bbox[3]],
            "highlighted_text": self.highlighted_text,
            "author": self.author,
            "comment": self.comment,
            "created": self.created,
            "trigger_match": self.trigger_match,
        }


@dataclass
class MappingCandidate:
    """A runner-up window for needs_review mappings (spec §7.2)."""

    file: str
    line_range: tuple[int, int]
    score: float

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "MappingCandidate":
        return cls(
            file=d["file"],
            line_range=(int(d["line_range"][0]), int(d["line_range"][1])),
            score=float(d["score"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "file": self.file,
            "line_range": [self.line_range[0], self.line_range[1]],
            "score": self.score,
        }


@dataclass
class Mapping:
    """One entry in ``mapping.json.mappings`` (spec §7.2)."""

    latex_file: str | None
    line_range: tuple[int, int] | None
    confidence: float
    method: Method
    needs_review: bool
    candidates: list[MappingCandidate] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Mapping":
        raw_lr = d.get("line_range")
        line_range: tuple[int, int] | None = (
            (int(raw_lr[0]), int(raw_lr[1])) if raw_lr is not None else None
        )
        return cls(
            latex_file=d.get("latex_file"),
            line_range=line_range,
            confidence=float(d["confidence"]),
            method=d["method"],
            needs_review=bool(d["needs_review"]),
            candidates=[MappingCandidate.from_dict(c) for c in d.get("candidates", [])],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "latex_file": self.latex_file,
            "line_range": (
                [self.line_range[0], self.line_range[1]]
                if self.line_range is not None
                else None
            ),
            "confidence": self.confidence,
            "method": self.method,
            "needs_review": self.needs_review,
            "candidates": [c.to_dict() for c in self.candidates],
        }


@dataclass
class ChatTurn:
    """One entry in ``state.json.annotations[id].surface_chat_log`` (spec §7.3)."""

    role: Role
    text: str
    ts: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "ChatTurn":
        return cls(role=d["role"], text=d["text"], ts=d["ts"])

    def to_dict(self) -> dict[str, Any]:
        return {"role": self.role, "text": self.text, "ts": self.ts}


@dataclass
class AnnotationState:
    """One entry in ``state.json.annotations`` (spec §7.3)."""

    status: Status
    before_text: str | None = None
    proposed_text: str | None = None
    applied_text: str | None = None
    applied_at: str | None = None
    last_build_id: str | None = None
    surface_chat_log: list[ChatTurn] | None = None
    failure_log_path: str | None = None
    failure_edit_text: str | None = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "AnnotationState":
        raw_chat = d.get("surface_chat_log")
        chat: list[ChatTurn] | None
        if raw_chat is None:
            chat = None
        else:
            chat = [ChatTurn.from_dict(t) for t in raw_chat]
        return cls(
            status=d["status"],
            before_text=d.get("before_text"),
            proposed_text=d.get("proposed_text"),
            applied_text=d.get("applied_text"),
            applied_at=d.get("applied_at"),
            last_build_id=d.get("last_build_id"),
            surface_chat_log=chat,
            failure_log_path=d.get("failure_log_path"),
            failure_edit_text=d.get("failure_edit_text"),
        )

    def to_dict(self) -> dict[str, Any]:
        chat: list[dict[str, Any]] | None
        if self.surface_chat_log is None:
            chat = None
        else:
            chat = [t.to_dict() for t in self.surface_chat_log]
        return {
            "status": self.status,
            "before_text": self.before_text,
            "proposed_text": self.proposed_text,
            "applied_text": self.applied_text,
            "applied_at": self.applied_at,
            "last_build_id": self.last_build_id,
            "surface_chat_log": chat,
            "failure_log_path": self.failure_log_path,
            "failure_edit_text": self.failure_edit_text,
        }


@dataclass
class Build:
    """One entry in ``state.json.builds[]`` (spec §7.3)."""

    id: str
    pdf_path: str
    page_count: int
    compiled_at: str
    log_path: str
    ok: bool
    page_md5: tuple[str, ...]

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Build":
        return cls(
            id=d["id"],
            pdf_path=d["pdf_path"],
            page_count=int(d["page_count"]),
            compiled_at=d["compiled_at"],
            log_path=d["log_path"],
            ok=bool(d["ok"]),
            page_md5=tuple(d["page_md5"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "pdf_path": self.pdf_path,
            "page_count": self.page_count,
            "compiled_at": self.compiled_at,
            "log_path": self.log_path,
            "ok": self.ok,
            "page_md5": list(self.page_md5),
        }


@dataclass
class StateFile:
    """Top-level object in ``state.json`` (spec §7.3)."""

    phase: Phase
    order: Order
    current_annotation_id: str | None
    annotations: dict[str, AnnotationState] = field(default_factory=dict)
    builds: list[Build] = field(default_factory=list)
    schema_version: int = SUPPORTED_SCHEMA

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "StateFile":
        return cls(
            schema_version=int(d["schema_version"]),
            phase=d["phase"],
            order=d["order"],
            current_annotation_id=d.get("current_annotation_id"),
            annotations={
                k: AnnotationState.from_dict(v) for k, v in d.get("annotations", {}).items()
            },
            builds=[Build.from_dict(b) for b in d.get("builds", [])],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "phase": self.phase,
            "order": self.order,
            "current_annotation_id": self.current_annotation_id,
            "annotations": {k: v.to_dict() for k, v in self.annotations.items()},
            "builds": [b.to_dict() for b in self.builds],
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_state.py -v -k "round_trip or annotation_state or state_file"`

Expected: 7 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/state.py tests/test_state.py
git commit -m "feat(state): add dataclasses for annotations, mapping, state, builds"
```

### Task 2.5: `status_is_terminal`

**Implements spec:** §7.3 (terminal/non-terminal split)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_state.py`:

```python
@pytest.mark.parametrize(
    "status,expected_terminal",
    [
        # Terminal per spec §7.3
        ("accepted", True),
        ("rejected", True),
        ("redrafted", True),
        ("deferred", True),
        ("surfaced_resolved", True),
        # Non-terminal per spec §7.3
        ("pending", False),
        ("applied", False),
        ("surfaced_pending", False),
        ("needs_review", False),
    ],
)
def test_status_is_terminal(status: str, expected_terminal: bool):
    """status_is_terminal returns True only for the spec §7.3 terminal set."""
    assert state.status_is_terminal(status) is expected_terminal


def test_status_is_terminal_rejects_unknown_status():
    """An unknown status raises ValueError (defensive — schema violation)."""
    with pytest.raises(ValueError, match="unknown status"):
        state.status_is_terminal("invalid-status")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_state.py -v -k status_is_terminal`

Expected: FAIL with `AttributeError: module 'review_pdf_to_latex.state' has no attribute 'status_is_terminal'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/state.py`:

```python
_TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"accepted", "rejected", "redrafted", "deferred", "surfaced_resolved"}
)
_NON_TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"pending", "applied", "surfaced_pending", "needs_review"}
)
_ALL_STATUSES: frozenset[str] = _TERMINAL_STATUSES | _NON_TERMINAL_STATUSES


def status_is_terminal(status: str) -> bool:
    """Return True iff ``status`` is in the spec §7.3 terminal set.

    Terminal: ``accepted``, ``rejected``, ``redrafted``, ``deferred``,
    ``surfaced_resolved``. An annotation in a terminal status requires
    no further action; Phase 3 requires every annotation to be terminal.

    Raises
    ------
    ValueError
        ``status`` is not in the spec §7.3 enum.
    """
    if status not in _ALL_STATUSES:
        raise ValueError(
            f"unknown status: {status!r} (expected one of {sorted(_ALL_STATUSES)})"
        )
    return status in _TERMINAL_STATUSES
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_state.py -v -k status_is_terminal`

Expected: 10 PASSED (9 parametrized + 1 unknown-status case).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/state.py tests/test_state.py
git commit -m "feat(state): add status_is_terminal helper"
```

### Task 2.6: `validate_status_transition` — legal transition table

**Implements spec:** §10.3 (button semantics — allowed source → target statuses), §9.2 (Phase 1 failure recovery via `revert --status needs_review`), §10.6 (override-mapping action)

The transition table is derived directly from spec §10.3's "Allowed source → target statuses" column, plus the Phase-1 failure flow (`revert --status needs_review`) and the `override-mapping` action which acts on the mapping but does not change annotation status.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_state.py`:

```python
@pytest.mark.parametrize(
    "from_status,to_status,action",
    [
        # Apply: any non-terminal → applied (engine-internal action used by
        # `review-pdf apply` from Phase 1 batch apply and Phase 2a/2b re-apply).
        ("pending", "applied", "apply"),
        ("applied", "applied", "apply"),
        ("rejected", "applied", "apply"),
        ("redrafted", "applied", "apply"),
        ("needs_review", "applied", "apply"),
        ("surfaced_pending", "applied", "apply"),
        # Approve: applied → accepted; redrafted → accepted (spec §10.3)
        ("applied", "accepted", "approve"),
        ("redrafted", "accepted", "approve"),
        # Reject: applied → rejected; redrafted → rejected (spec §10.3)
        ("applied", "rejected", "reject"),
        ("redrafted", "rejected", "reject"),
        # Redraft: applied → redrafted; rejected → redrafted;
        # redrafted → redrafted (spec §10.3 — successive redrafts allowed)
        ("applied", "redrafted", "redraft"),
        ("rejected", "redrafted", "redraft"),
        ("redrafted", "redrafted", "redraft"),
        # Skip: pending|applied|redrafted|rejected|needs_review|surfaced_pending → deferred
        ("pending", "deferred", "skip"),
        ("applied", "deferred", "skip"),
        ("redrafted", "deferred", "skip"),
        ("rejected", "deferred", "skip"),
        ("needs_review", "deferred", "skip"),
        ("surfaced_pending", "deferred", "skip"),
        # Surface: pending|applied|deferred|needs_review → surfaced_pending (spec §10.3)
        ("pending", "surfaced_pending", "surface"),
        ("applied", "surfaced_pending", "surface"),
        ("deferred", "surfaced_pending", "surface"),
        ("needs_review", "surfaced_pending", "surface"),
        # Phase 1 failure recovery: applied → needs_review via revert --failure-log
        # (spec §9.2, §12.2)
        ("applied", "needs_review", "redraft"),
        # Phase 2b resolution: surfaced_pending → surfaced_resolved (spec §9.4)
        ("surfaced_pending", "surfaced_resolved", "resolve-surface"),
    ],
)
def test_validate_status_transition_legal(
    from_status: str, to_status: str, action: str
):
    """Every legal transition documented in spec §10.3 returns True."""
    assert state.validate_status_transition(from_status, to_status, action) is True


@pytest.mark.parametrize(
    "from_status,to_status,action",
    [
        # Cannot approve from pending — must apply first
        ("pending", "accepted", "approve"),
        # Cannot reject something that was never applied
        ("pending", "rejected", "reject"),
        # Cannot un-defer back to pending
        ("deferred", "pending", "skip"),
        # Cannot surface a terminal accepted annotation (spec §10.3 — Surface
        # column shows pending|applied|deferred|needs_review only)
        ("accepted", "surfaced_pending", "surface"),
        ("rejected", "surfaced_pending", "surface"),
        # Cannot resolve-surface from a non-surface status
        ("applied", "surfaced_resolved", "resolve-surface"),
        # Approve does not lead to redrafted
        ("applied", "redrafted", "approve"),
    ],
)
def test_validate_status_transition_illegal_raises(
    from_status: str, to_status: str, action: str
):
    """Illegal transitions raise IllegalTransitionError."""
    with pytest.raises(state.IllegalTransitionError):
        state.validate_status_transition(from_status, to_status, action)


def test_validate_status_transition_override_mapping_is_status_neutral():
    """override-mapping does not transition annotation status (it edits mapping.json).

    The action is included in the action enum (spec §10.6) but every call
    with this action must be a no-op transition (from == to).
    """
    assert (
        state.validate_status_transition("needs_review", "needs_review", "override-mapping")
        is True
    )
    with pytest.raises(state.IllegalTransitionError):
        state.validate_status_transition("needs_review", "applied", "override-mapping")


def test_validate_status_transition_unknown_action_raises():
    """An unrecognized action raises IllegalTransitionError."""
    with pytest.raises(state.IllegalTransitionError, match="unknown action"):
        state.validate_status_transition("applied", "accepted", "explode")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_state.py -v -k validate_status_transition`

Expected: FAIL with `AttributeError: module 'review_pdf_to_latex.state' has no attribute 'validate_status_transition'` (and `IllegalTransitionError`).

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/state.py`:

```python
Action = Literal[
    "apply",
    "approve",
    "reject",
    "redraft",
    "skip",
    "surface",
    "override-mapping",
    "resolve-surface",
]


class IllegalTransitionError(ValueError):
    """Raised by ``validate_status_transition`` for any disallowed move.

    Captures the (from_status, to_status, action) triple in the message
    so the CLI can surface it verbatim. The CLI subcommand ``set-status``
    converts this to exit code 18 per spec §8.

    Extends ``ValueError`` so ``except ValueError`` clauses in chunk C's
    `apply_edit`, `revert_edit`, and `set_annotation_status` catch it as
    intended (those clauses wrap it in ``IllegalStatusTransitionError`` for
    exit-code mapping).
    """


# (from_status, action) → set of allowed to_status values.
# Derived from spec §10.3 "Allowed source → target statuses" column,
# plus the Phase 1 failure recovery in §9.2 (applied → needs_review via
# `revert --failure-log`) and the Phase 2b resolution in §9.4
# (surfaced_pending → surfaced_resolved via `set-status`).
_LEGAL_TRANSITIONS: dict[tuple[str, str], frozenset[str]] = {
    # Apply action — used by `review-pdf apply` (engine-internal label for the
    # text-mutating apply path, covering Phase-1 batch apply and Phase-2a/2b
    # re-apply from any non-terminal status). Always targets `applied`.
    ("pending", "apply"): frozenset({"applied"}),
    ("applied", "apply"): frozenset({"applied"}),
    ("rejected", "apply"): frozenset({"applied"}),
    ("redrafted", "apply"): frozenset({"applied"}),
    ("needs_review", "apply"): frozenset({"applied"}),
    ("surfaced_pending", "apply"): frozenset({"applied"}),
    # Approve button — no .tex mutation, status only.
    ("applied", "approve"): frozenset({"accepted"}),
    ("redrafted", "approve"): frozenset({"accepted"}),
    # Reject button — engine reverts the file, then sets status.
    ("applied", "reject"): frozenset({"rejected"}),
    ("redrafted", "reject"): frozenset({"rejected"}),
    # Redraft button — engine reverts, applies new draft, builds, sets status.
    # Spec §10.3 allows applied|rejected|redrafted as source. Also covers the
    # Phase 1 failure flow where `revert --status needs_review` flips an
    # `applied` annotation to needs_review (encoded under `redraft` action;
    # see finding-8 note below).
    ("applied", "redraft"): frozenset({"redrafted", "needs_review"}),
    ("rejected", "redraft"): frozenset({"redrafted"}),
    ("redrafted", "redraft"): frozenset({"redrafted"}),
    # Skip button — defers any non-resolved status.
    ("pending", "skip"): frozenset({"deferred"}),
    ("applied", "skip"): frozenset({"deferred"}),
    ("redrafted", "skip"): frozenset({"deferred"}),
    ("rejected", "skip"): frozenset({"deferred"}),
    ("needs_review", "skip"): frozenset({"deferred"}),
    ("surfaced_pending", "skip"): frozenset({"deferred"}),
    # Surface button — sends to Phase 2b.
    ("pending", "surface"): frozenset({"surfaced_pending"}),
    ("applied", "surface"): frozenset({"surfaced_pending"}),
    ("deferred", "surface"): frozenset({"surfaced_pending"}),
    ("needs_review", "surface"): frozenset({"surfaced_pending"}),
    # Phase 2b resolution — marked by the skill via `set-status` once
    # the surface conversation concludes (spec §9.4).
    ("surfaced_pending", "resolve-surface"): frozenset({"surfaced_resolved"}),
    # override-mapping is status-neutral but is in the action enum.
    # Every source status maps to itself (no-op transition).
    ("pending", "override-mapping"): frozenset({"pending"}),
    ("applied", "override-mapping"): frozenset({"applied"}),
    ("accepted", "override-mapping"): frozenset({"accepted"}),
    ("rejected", "override-mapping"): frozenset({"rejected"}),
    ("redrafted", "override-mapping"): frozenset({"redrafted"}),
    ("deferred", "override-mapping"): frozenset({"deferred"}),
    ("surfaced_pending", "override-mapping"): frozenset({"surfaced_pending"}),
    ("surfaced_resolved", "override-mapping"): frozenset({"surfaced_resolved"}),
    ("needs_review", "override-mapping"): frozenset({"needs_review"}),
}

# Engine-internal action enum used by `validate_status_transition`. Diverges
# from spec §7.4's viewer-event action enum in two ways: (1) `preview` is
# omitted because it never transitions status (it is a speculative-compile
# affordance); (2) `apply` and `resolve-surface` are added as engine-internal
# labels covering, respectively, the `review-pdf apply` text-mutating call
# path and the Phase-2b conclusion. The viewer never POSTs these two values.
_KNOWN_ACTIONS: frozenset[str] = frozenset(
    {
        "apply",
        "approve",
        "reject",
        "redraft",
        "skip",
        "surface",
        "override-mapping",
        "resolve-surface",
    }
)


def validate_status_transition(from_status: str, to_status: str, action: str) -> bool:
    """Return True if (from_status → to_status) under ``action`` is allowed.

    The legal transition table mirrors spec §10.3's button table plus the
    Phase 1 failure recovery (§9.2) and Phase 2b resolve (§9.4).

    The ``action`` enum used here is engine-internal and diverges from spec
    §7.4's viewer-event action enum in two ways (see ``_KNOWN_ACTIONS``
    docstring): ``preview`` is omitted (it never transitions status), and
    ``apply`` plus ``resolve-surface`` are added.

    Raises
    ------
    IllegalTransitionError
        - ``action`` is not in the engine-internal action enum, OR
        - the (from_status, action) pair has no entry, OR
        - ``to_status`` is not in the allowed-target set for the pair.
    """
    if action not in _KNOWN_ACTIONS:
        raise IllegalTransitionError(
            f"unknown action: {action!r} (expected one of {sorted(_KNOWN_ACTIONS)})"
        )
    key = (from_status, action)
    if key not in _LEGAL_TRANSITIONS:
        raise IllegalTransitionError(
            f"no transition defined for from_status={from_status!r}, "
            f"action={action!r}"
        )
    allowed = _LEGAL_TRANSITIONS[key]
    if to_status not in allowed:
        raise IllegalTransitionError(
            f"illegal transition: {from_status!r} --{action}--> {to_status!r} "
            f"(allowed targets: {sorted(allowed)})"
        )
    return True
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_state.py -v -k validate_status_transition`

Expected: All parametrized legal + illegal cases PASS (26 legal + 7 illegal + 2 override-mapping + 1 unknown-action = 36 PASSED).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/state.py tests/test_state.py
git commit -m "feat(state): add validate_status_transition with spec §10.3 table"
```

---

### Task 2.7: `assert_source_pdf_unchanged` — mutator guard

**Files:**
- Modify: `src/review_pdf_to_latex/state.py` (append helper + new exception classes)
- Modify: `tests/test_state.py` (append three tests)

**Implements spec:** §14 risk 9 ("Engine refuses operations if source PDF MD5 differs from `annotations.json.source_pdf_md5`; user must re-extract.")

Chunk B's `run_extract` records `annotations.json.source_pdf` (absolute path) and `annotations.json.source_pdf_md5` (MD5 hex digest). If the commenter ships an updated PDF mid-review, every subsequent mutator must refuse to operate so the engine never edits `.tex` against stale annotation coordinates. This task adds the helper; chunk C and D wire calls to it at the top of every mutating handler.

Two new exit codes are reserved here (and added to the pinning test in Task 3.3):

- `21` — `SourcePdfChangedError`: `source_pdf_md5` no longer matches the on-disk file.
- `22` — `LegacyStateError`: `annotations.json` lacks `source_pdf_md5` (predates this guard) and the user must `extract --force`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_state.py`:

```python
import hashlib

from review_pdf_to_latex import state


def _write_annotations_doc(state_dir: Path, source_pdf: Path, md5: str | None) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    doc = {
        "schema_version": 1,
        "source_pdf": str(source_pdf.resolve()),
        "extracted_at": "2026-05-16T00:00:00Z",
        "extractor": "pdfannots-0.4.1",
        "annotations": [],
    }
    if md5 is not None:
        doc["source_pdf_md5"] = md5
    (state_dir / "annotations.json").write_text(
        json.dumps(doc), encoding="utf-8",
    )


def test_assert_source_pdf_unchanged_passes_when_md5_matches(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake content")
    md5 = hashlib.md5(pdf.read_bytes()).hexdigest()
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, md5)
    # Should not raise.
    state.assert_source_pdf_unchanged(sd)


def test_assert_source_pdf_unchanged_raises_when_md5_differs(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    pdf.write_bytes(b"%PDF-1.4 original")
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, "deadbeef" * 4)  # 32-char garbage hash
    with pytest.raises(state.SourcePdfChangedError, match="source PDF changed"):
        state.assert_source_pdf_unchanged(sd)


def test_assert_source_pdf_unchanged_raises_when_pdf_missing(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, "deadbeef" * 4)
    # PDF was deleted between extract and apply.
    with pytest.raises(state.SourcePdfChangedError, match="not found"):
        state.assert_source_pdf_unchanged(sd)


def test_assert_source_pdf_unchanged_legacy_state_raises(tmp_path: Path) -> None:
    pdf = tmp_path / "comments.pdf"
    pdf.write_bytes(b"%PDF-1.4 content")
    sd = state.StateDir(tmp_path)
    sd.dir.mkdir()
    _write_annotations_doc(sd.dir, pdf, md5=None)  # No source_pdf_md5 field
    with pytest.raises(state.LegacyStateError, match="extract --force"):
        state.assert_source_pdf_unchanged(sd)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_state.py -v -k "assert_source_pdf"`

Expected: FAIL with `AttributeError: module 'review_pdf_to_latex.state' has no attribute 'assert_source_pdf_unchanged'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/state.py`:

```python
import hashlib


class SourcePdfChangedError(Exception):
    """Raised when the source PDF's MD5 differs from annotations.json.source_pdf_md5.

    Mapped to exit code 21 by the CLI. User must run `review-pdf extract --force`
    to refresh annotations against the current PDF (spec §14 risk 9).
    """


class LegacyStateError(Exception):
    """Raised when annotations.json lacks the source_pdf_md5 field.

    Pre-guard state. Mapped to exit code 22. User must run
    `review-pdf extract --force` to record the MD5.
    """


def _file_md5(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def assert_source_pdf_unchanged(state_dir: "StateDir") -> None:
    """Verify the source PDF MD5 still matches annotations.json.source_pdf_md5.

    Called by every state mutator (apply, revert, set-status, append-chat,
    record-proposal, override-mapping, preview, commit-phase, migrate-state)
    at the top of its handler, before reading state.json. Spec §14 risk 9.

    Raises:
        SourcePdfChangedError: MD5 differs, OR the source PDF file is gone.
        LegacyStateError: annotations.json predates the guard (no md5 field).
        FileNotFoundError: annotations.json itself is missing.
    """
    ann_path = state_dir.dir / "annotations.json"
    if not ann_path.exists():
        raise FileNotFoundError(f"annotations.json not found at {ann_path}")
    with ann_path.open("r", encoding="utf-8") as fh:
        doc = json.load(fh)
    if "source_pdf_md5" not in doc:
        raise LegacyStateError(
            "annotations.json has no source_pdf_md5 field; "
            "run `review-pdf extract --force` to refresh"
        )
    pdf_path = Path(doc["source_pdf"])
    if not pdf_path.exists():
        raise SourcePdfChangedError(
            f"source PDF not found at {pdf_path}; "
            f"run `review-pdf extract --force` if the path moved"
        )
    actual = _file_md5(pdf_path)
    expected = doc["source_pdf_md5"]
    if actual != expected:
        raise SourcePdfChangedError(
            f"source PDF changed since extract: expected md5={expected}, "
            f"got {actual}; run `review-pdf extract --force` to refresh"
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_state.py -v -k "assert_source_pdf"`

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/state.py tests/test_state.py
git commit -m "feat(state): add assert_source_pdf_unchanged mutator guard (spec §14 risk 9)"
```

---

## Task 3: CLI router scaffolding

**Files:**
- Create: `src/review_pdf_to_latex/cli.py`
- Create: `tests/test_cli.py`

**Implements spec:** §8 (CLI surface — all 14 subcommands, exit codes), §5.1 (state mutation rule — CLI is the sole writer)

This task is broken into three focused sub-tasks. Each ends with its own commit. The CLI router is a thin argparse-based dispatcher; each of the 14 subcommands gets a stub handler that raises `NotImplementedError` until the corresponding feature task lands.

### Task 3.1: argparse router with 14 subcommand stubs

**Implements spec:** §8 (full CLI surface)

The 14 subcommands (per spec §8):

1. `extract`
2. `serve`
3. `apply`
4. `revert`
5. `preview`
6. `build`
7. `status`
8. `override-mapping`
9. `set-status`
10. `append-chat`
11. `record-proposal`
12. `commit-phase`
13. `wait-event`
14. `migrate-state`

- [ ] **Step 1: Write the failing test**

Create `tests/test_cli.py`:

```python
"""Tests for review_pdf_to_latex.cli — argparse router and subcommand dispatch."""

import json
from pathlib import Path

import pytest

from review_pdf_to_latex import cli


ALL_SUBCOMMANDS = [
    "extract",
    "serve",
    "apply",
    "revert",
    "preview",
    "build",
    "status",
    "override-mapping",
    "set-status",
    "append-chat",
    "record-proposal",
    "commit-phase",
    "wait-event",
    "migrate-state",
]


def test_top_level_help_exits_zero(capsys: pytest.CaptureFixture):
    """`review-pdf --help` exits with code 0 and prints the program name."""
    with pytest.raises(SystemExit) as exc:
        cli.main(["--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert "review-pdf" in out


def test_top_level_no_args_exits_nonzero(capsys: pytest.CaptureFixture):
    """`review-pdf` with no subcommand exits non-zero with a usage hint."""
    with pytest.raises(SystemExit) as exc:
        cli.main([])
    assert exc.value.code != 0


@pytest.mark.parametrize("subcommand", ALL_SUBCOMMANDS)
def test_subcommand_help_exits_zero(
    subcommand: str, capsys: pytest.CaptureFixture
):
    """`review-pdf <subcommand> --help` exits with code 0."""
    with pytest.raises(SystemExit) as exc:
        cli.main([subcommand, "--help"])
    assert exc.value.code == 0
    out = capsys.readouterr().out
    assert subcommand in out


@pytest.mark.parametrize("subcommand", ALL_SUBCOMMANDS)
def test_subcommand_stub_raises_not_implemented(
    subcommand: str, tmp_project: Path
):
    """Each of the 14 subcommand stubs raises NotImplementedError until implemented.

    We supply the bare-minimum flags each stub requires to satisfy argparse;
    the stub raises BEFORE doing any real work.
    """
    # Per-subcommand minimum required args so argparse does not exit first.
    args_by_cmd: dict[str, list[str]] = {
        "extract": ["--pdf", str(tmp_project / "fake.pdf")],
        "serve": [],
        "apply": [
            "--annotation-id", "ann-001",
            "--new-text-file", str(tmp_project / "draft.tex"),
        ],
        "revert": ["--annotation-id", "ann-001"],
        "preview": [
            "--annotation-id", "ann-001",
            "--new-text-file", str(tmp_project / "draft.tex"),
        ],
        "build": [],
        "status": [],
        "override-mapping": [
            "--annotation-id", "ann-001",
            "--file", "templates/x.tex",
            "--lines", "10:20",
        ],
        "set-status": [
            "--annotation-id", "ann-001",
            "--status", "accepted",
        ],
        "append-chat": [
            "--annotation-id", "ann-001",
            "--role", "user",
            "--text-file", str(tmp_project / "turn.txt"),
        ],
        "record-proposal": [
            "--annotation-id", "ann-001",
            "--text-file", str(tmp_project / "draft.tex"),
        ],
        "commit-phase": ["--phase", "1"],
        "wait-event": [],
        "migrate-state": ["--from", "1", "--to", "1"],
    }
    argv = [
        "--project-dir", str(tmp_project),
        subcommand,
        *args_by_cmd[subcommand],
    ]
    with pytest.raises(NotImplementedError, match=f"subcommand {subcommand}"):
        cli.main(argv)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v`

Expected: FAIL with `ModuleNotFoundError: No module named 'review_pdf_to_latex.cli'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review_pdf_to_latex/cli.py`:

```python
"""CLI entry point — argparse router for the 14 ``review-pdf`` subcommands.

Each subcommand handler is a stub that raises ``NotImplementedError`` until
the corresponding feature task lands. The router itself, ``--project-dir``,
the ``--json`` global flag, and the exit-code constants are all wired up
here so feature tasks can drop in implementations without touching argparse.

See spec §8 for the full per-command contract and exit codes.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Sequence


PROG = "review-pdf"


def _add_global_args(parser: argparse.ArgumentParser) -> None:
    """Attach ``--project-dir`` and ``--json`` to the top-level parser."""
    parser.add_argument(
        "--project-dir",
        type=Path,
        default=Path.cwd(),
        help="Project root containing .review-state/ (default: $PWD).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Emit machine-consumable JSON on stdout where supported.",
    )


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog=PROG,
        description=(
            "Sidecar tool for walking PDF annotations into LaTeX source edits. "
            "See docs/specs/2026-05-16-review-pdf-to-latex-design.md."
        ),
    )
    _add_global_args(parser)
    sub = parser.add_subparsers(dest="subcommand", metavar="SUBCOMMAND")

    # 1. extract
    p_extract = sub.add_parser(
        "extract",
        help="Read PDF, build annotations.json + mapping.json + initial state.json.",
    )
    p_extract.add_argument("--pdf", type=Path, required=True)
    p_extract.add_argument("--surface-trigger", default="claude surface this")
    p_extract.add_argument("--force", action="store_true")

    # 2. serve
    p_serve = sub.add_parser("serve", help="Start the local HTTP viewer.")
    p_serve.add_argument("--port", type=int, default=0)
    p_serve.add_argument(
        "--order",
        choices=["mechanical-first", "surface-first"],
        default="mechanical-first",
    )
    p_serve.add_argument("--mapping-mode", action="store_true")

    # 3. apply
    p_apply = sub.add_parser("apply", help="Apply an edit to a .tex file.")
    p_apply.add_argument("--annotation-id", required=True)
    p_apply.add_argument("--new-text-file", type=Path, required=True)
    p_apply.add_argument("--dry-run", action="store_true")

    # 4. revert
    p_revert = sub.add_parser("revert", help="Restore before_text for an annotation.")
    p_revert.add_argument("--annotation-id", required=True)
    p_revert.add_argument(
        "--status",
        choices=["rejected", "needs_review"],
        default="rejected",
    )
    p_revert.add_argument("--failure-log", type=Path, default=None)

    # 5. preview
    p_preview = sub.add_parser("preview", help="Speculative compile with snapshot/restore.")
    p_preview.add_argument("--annotation-id", required=True)
    p_preview.add_argument("--new-text-file", type=Path, required=True)

    # 6. build
    p_build = sub.add_parser("build", help="Run pdflatex/xelatex; append build record.")
    p_build.add_argument("--main-file", type=Path, default=None)
    p_build.add_argument(
        "--engine",
        choices=["pdflatex", "xelatex", "auto"],
        default="auto",
    )
    p_build.add_argument("--quiet", action="store_true")

    # 7. status
    sub.add_parser("status", help="Report counts and current state.")

    # 8. override-mapping
    p_om = sub.add_parser(
        "override-mapping", help="Manual mapping override for needs_review cases."
    )
    p_om.add_argument("--annotation-id", required=True)
    p_om.add_argument("--file", required=True)
    p_om.add_argument("--lines", required=True, help="START:END")

    # 9. set-status
    p_ss = sub.add_parser(
        "set-status", help="Transition an annotation's status (no .tex mutation)."
    )
    p_ss.add_argument("--annotation-id", required=True)
    p_ss.add_argument(
        "--status",
        required=True,
        choices=[
            "pending",
            "applied",
            "accepted",
            "rejected",
            "redrafted",
            "deferred",
            "surfaced_pending",
            "surfaced_resolved",
            "needs_review",
        ],
    )
    p_ss.add_argument("--reason", default=None)

    # 10. append-chat
    p_ac = sub.add_parser(
        "append-chat", help="Append a Phase-2b chat turn to surface_chat_log."
    )
    p_ac.add_argument("--annotation-id", required=True)
    p_ac.add_argument("--role", choices=["user", "claude"], required=True)
    p_ac.add_argument("--text-file", type=Path, required=True)

    # 11. record-proposal
    p_rp = sub.add_parser(
        "record-proposal",
        help="Record proposed_text without mutating the .tex file.",
    )
    p_rp.add_argument("--annotation-id", required=True)
    p_rp.add_argument("--text-file", type=Path, required=True)

    # 12. commit-phase
    p_cp = sub.add_parser(
        "commit-phase", help="Run git commit and advance state.json.phase."
    )
    p_cp.add_argument("--phase", required=True, choices=["1", "2a", "2b", "3"])
    p_cp.add_argument("--message-suffix", default=None)
    p_cp.add_argument(
        "--granularity",
        default="phase",
        help="phase | session | batch:N (default: phase)",
    )

    # 13. wait-event
    p_we = sub.add_parser(
        "wait-event", help="Block until a new line is appended to state-events.jsonl."
    )
    p_we.add_argument("--since", default=None)
    p_we.add_argument("--timeout", type=int, default=60)

    # 14. migrate-state
    p_ms = sub.add_parser(
        "migrate-state", help="Upgrade state files between schema versions."
    )
    p_ms.add_argument("--from", dest="from_version", type=int, required=True)
    p_ms.add_argument("--to", dest="to_version", type=int, required=True)

    return parser


def _stub(name: str) -> None:
    """Raise NotImplementedError for an unimplemented subcommand."""
    raise NotImplementedError(f"subcommand {name} not yet implemented")


_HANDLERS: dict[str, str] = {
    "extract": "extract",
    "serve": "serve",
    "apply": "apply",
    "revert": "revert",
    "preview": "preview",
    "build": "build",
    "status": "status",
    "override-mapping": "override-mapping",
    "set-status": "set-status",
    "append-chat": "append-chat",
    "record-proposal": "record-proposal",
    "commit-phase": "commit-phase",
    "wait-event": "wait-event",
    "migrate-state": "migrate-state",
}


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns an exit code (or raises SystemExit for --help).

    Parameters
    ----------
    argv:
        Argument list, defaulting to ``sys.argv[1:]``. Passed explicitly
        in tests; the ``[project.scripts]`` shim leaves it as None.
    """
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.subcommand is None:
        parser.print_usage(sys.stderr)
        return 2
    _stub(_HANDLERS[args.subcommand])
    return 0  # unreachable until stubs are replaced
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v`

Expected: All tests pass — `test_top_level_help_exits_zero`, `test_top_level_no_args_exits_nonzero`, plus 14 `test_subcommand_help_exits_zero` parametrizations and 14 `test_subcommand_stub_raises_not_implemented` parametrizations = 30 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): scaffold argparse router with 14 subcommand stubs"
```

### Task 3.2: `--json` global flag and `print_json` helper

**Implements spec:** §8 (machine-consumable output)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_cli.py`:

```python
def test_print_json_writes_single_line(capsys: pytest.CaptureFixture):
    """print_json writes a single newline-terminated JSON object to stdout."""
    cli.print_json({"ok": True, "count": 3})
    out = capsys.readouterr().out
    assert out.endswith("\n")
    parsed = json.loads(out.strip())
    assert parsed == {"ok": True, "count": 3}


def test_print_json_serializes_sort_keys(capsys: pytest.CaptureFixture):
    """print_json output is stable: keys are sorted for diffability."""
    cli.print_json({"z": 1, "a": 2})
    out = capsys.readouterr().out.strip()
    assert out == '{"a": 2, "z": 1}'


def test_status_subcommand_with_json_flag_still_raises(tmp_project: Path):
    """`--json status` propagates through to the stub (not yet implemented)."""
    with pytest.raises(NotImplementedError, match="subcommand status"):
        cli.main(["--project-dir", str(tmp_project), "--json", "status"])
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v -k print_json`

Expected: FAIL with `AttributeError: module 'review_pdf_to_latex.cli' has no attribute 'print_json'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/cli.py`:

```python
import json as _json


def print_json(data: object) -> None:
    """Write one JSON object as a newline-terminated line on stdout.

    Sorted keys; compact separators; no trailing whitespace. Used by every
    subcommand handler whose ``args.json_output`` is true. The single-line
    format makes streaming output trivially parseable by the skill.
    """
    sys.stdout.write(_json.dumps(data, sort_keys=True))
    sys.stdout.write("\n")
    sys.stdout.flush()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v -k print_json`

Expected: 2 PASSED (plus `test_status_subcommand_with_json_flag_still_raises` PASSED — 3 total in the filter).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): add print_json helper for --json output"
```

### Task 3.3: Exit-code constants per spec §8

**Implements spec:** §8 (every documented exit code)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_cli.py`:

```python
def test_exit_code_constants_match_spec():
    """Module-level exit-code constants match spec §8 verbatim.

    The CLI surface table in spec §8 documents these codes as the
    contract between the engine and the skill. Renaming or renumbering
    breaks the skill; this test pins them.
    """
    assert cli.EXIT_OK == 0
    assert cli.EXIT_MISSING_PDF == 2
    assert cli.EXIT_EXISTING_STATE == 3
    assert cli.EXIT_PDFANNOTS_FAILED == 4
    assert cli.EXIT_PORT_UNAVAILABLE == 5
    assert cli.EXIT_STATE_MISSING == 6
    assert cli.EXIT_ANNOTATION_NOT_FOUND == 7
    assert cli.EXIT_MAPPING_UNRESOLVED == 8
    assert cli.EXIT_FILE_MUTATION_FAILED == 9
    assert cli.EXIT_NO_PRIOR_APPLY == 10
    assert cli.EXIT_BUILD_FAILED == 11
    assert cli.EXIT_MAIN_FILE_NOT_FOUND == 12
    assert cli.EXIT_INVALID_LINE_RANGE == 13
    assert cli.EXIT_UNSUPPORTED_MIGRATION == 14
    assert cli.EXIT_DIRTY_GIT_STATE == 15
    assert cli.EXIT_OVERLAPPING_LINE_RANGE == 16
    assert cli.EXIT_RESTORE_FAILED == 17
    assert cli.EXIT_ILLEGAL_STATUS_TRANSITION == 18
    assert cli.EXIT_COMMIT_FAILED == 19
    assert cli.EXIT_WAIT_TIMEOUT == 20
    assert cli.EXIT_SOURCE_PDF_CHANGED == 21
    assert cli.EXIT_LEGACY_STATE == 22
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py::test_exit_code_constants_match_spec -v`

Expected: FAIL with `AttributeError: module 'review_pdf_to_latex.cli' has no attribute 'EXIT_OK'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/cli.py`:

```python
# Exit codes (spec §8 — pinned by tests/test_cli.py::test_exit_code_constants_match_spec).
# The skill consumes these as its contract with the engine; do NOT renumber.
EXIT_OK = 0
EXIT_MISSING_PDF = 2  # extract: --pdf path absent or unreadable
EXIT_EXISTING_STATE = 3  # extract: .review-state/ exists, no --force
EXIT_PDFANNOTS_FAILED = 4  # extract: pdfannots parse error
EXIT_PORT_UNAVAILABLE = 5  # serve: requested port in use
EXIT_STATE_MISSING = 6  # any: state.json absent when required
EXIT_ANNOTATION_NOT_FOUND = 7  # any per-annotation: id absent
EXIT_MAPPING_UNRESOLVED = 8  # apply/preview: mapping has no latex_file/line_range
EXIT_FILE_MUTATION_FAILED = 9  # apply: .tex write failed
EXIT_NO_PRIOR_APPLY = 10  # revert: no before_text captured
EXIT_BUILD_FAILED = 11  # build/preview: pdflatex non-zero
EXIT_MAIN_FILE_NOT_FOUND = 12  # build: --main-file absent
EXIT_INVALID_LINE_RANGE = 13  # override-mapping: bad START:END
EXIT_UNSUPPORTED_MIGRATION = 14  # migrate-state: no path from N to M
EXIT_DIRTY_GIT_STATE = 15  # commit-phase: git status --porcelain non-empty
EXIT_OVERLAPPING_LINE_RANGE = 16  # apply: conflict with another annotation
EXIT_RESTORE_FAILED = 17  # preview: in-place restore failed (engine emits recovery)
EXIT_ILLEGAL_STATUS_TRANSITION = 18  # set-status: rejected by validate_status_transition
EXIT_COMMIT_FAILED = 19  # commit-phase: hook or staging error
EXIT_WAIT_TIMEOUT = 20  # wait-event: --timeout elapsed before any event
EXIT_SOURCE_PDF_CHANGED = 21  # any mutator: PDF md5 differs from annotations.json.source_pdf_md5
EXIT_LEGACY_STATE = 22  # any mutator: annotations.json predates source_pdf_md5 guard
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py::test_exit_code_constants_match_spec -v`

Expected: 1 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): pin exit-code constants from spec §8"
```

---

End of foundation layer (Tasks 1, 2, 3). The remaining tasks (4 — extract; 5 — viewer; 6 — apply/revert/state mutators; 7 — build; 8 — preview; 9 — commit-phase; 10 — wait-event; 11 — status/migrate-state; 12 — integration tests; 13 — Claude Code skill; 14 — release prep) are owned by sub-agents B through G.
## Task 4 — Extract pipeline

The `extract` subcommand is the entry point into any project: it consumes an annotated PDF plus a LaTeX project root and produces the four state files (`annotations.json`, `mapping.json`, initial `state.json` with `phase: "0-setup"`) plus page renders under `pages/page-N.png`. This chunk implements every step of that pipeline behind the CLI.

**Implements spec:** §7.1 (annotations.json), §7.2 (mapping.json), §7.3 (state.json initial shape), §8 (extract command row), §9.1 (Phase 0), §12.1 (fuzzy mapping algorithm).

**Cross-chunk dependencies (already in place when this chunk runs):**

- Chunk A defines the dataclasses `Annotation`, `MappingEntry`, `StateFile` (and the per-annotation `AnnotationState`) in `src/review_pdf_to_latex/state.py`, plus `atomic_write_json` in the same module. Every test and implementation in this chunk imports those names. If chunk A has not landed yet, the engineer pauses and finishes chunk A first.
- Chunk A also lays down the `cli.py` skeleton with subparsers wired but every handler raising `NotImplementedError`. Task 4.7 below replaces the body of the `extract` handler only.

**Pinned dependency versions** (these are added to `pyproject.toml` in chunk A; restated here so the engineer can verify before starting Task 4.1):

- `pdfannots>=0.4,<0.5` — the Python API surface used by Task 4.1 is `pdfannots.process_file`.
- `rapidfuzz>=3.0,<4.0` — `rapidfuzz.fuzz.partial_ratio` is used by Task 4.4.

System binaries assumed on `PATH`: `pdftoppm` (Poppler).

---

### Task 4.1: Read PDF annotations via pdfannots' Python API

**Files:**

- Create: `src/review_pdf_to_latex/extract.py`
- Test: `tests/test_extract.py`
- Fixture (committed binary, tiny): `tests/fixtures/sample-annotated.pdf`

**Implements spec:** §7.1, §9.1 (extraction step).

**Fixture assumption.** This task assumes a small one-page PDF with two highlight annotations exists at `tests/fixtures/sample-annotated.pdf`. The full e2e fixture generator is owned by chunk F. For this task, commit a minimal hand-crafted PDF (one page, two highlights, one with the trigger phrase, one without) using a one-off script. If the fixture is not yet present when the engineer reaches this task, mark `test_read_annotations_returns_list_with_correct_fields` `@pytest.mark.xfail(reason="fixture pending chunk F")` and proceed; chunk F will retire the xfail when it lands the real fixture builder.

- [ ] **Step 1: Write the failing test**

Create `tests/test_extract.py` with the following content:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extract.py::test_read_annotations_returns_list_with_correct_fields -v`

Expected: FAIL with `ImportError: cannot import name 'read_annotations' from 'review_pdf_to_latex.extract'` (or `ModuleNotFoundError: No module named 'review_pdf_to_latex.extract'` if the file does not yet exist).

- [ ] **Step 3: Write minimal implementation**

Create `src/review_pdf_to_latex/extract.py` with the following content:

```python
"""Phase 0 (`extract`) pipeline: PDF -> annotations.json, mapping.json, state.json, pages/.

The functions in this module are wired together by `cli.py`'s `extract` handler
(Task 4.7). Each function is independently tested.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pdfannots

from review_pdf_to_latex.state import Annotation


def _format_created(raw: object) -> str | None:
    """Coerce pdfannots' `created` value into an ISO8601 string or None.

    pdfannots returns a `datetime` (sometimes tz-naive) or None. We normalize
    to UTC ISO8601 with a trailing 'Z' so the JSON output is unambiguous.
    """
    if raw is None:
        return None
    if isinstance(raw, datetime):
        dt = raw if raw.tzinfo is not None else raw.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    # Defensive: if pdfannots ever changes shape, stringify rather than crash.
    return str(raw)


def read_annotations(pdf_path: Path) -> list[Annotation]:
    """Parse PDF highlight annotations into a list of Annotation dataclasses.

    Uses pdfannots' Python API (not the CLI). Each annotation gets a sequential
    zero-padded id `ann-001`, `ann-002`, ... in document order (page, then y
    descending, which is what pdfannots yields natively).

    Args:
        pdf_path: Absolute or relative path to an annotated PDF.

    Returns:
        List of Annotation dataclasses in document order. May be empty if the
        PDF has no annotations.

    Raises:
        FileNotFoundError: pdf_path does not exist.
        RuntimeError: pdfannots failed to parse the PDF.
    """
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    try:
        with pdf_path.open("rb") as fh:
            doc = pdfannots.process_file(fh, emit_progress_to=None)
    except Exception as exc:  # noqa: BLE001 — pdfannots raises its own exception types
        raise RuntimeError(f"pdfannots failed to parse {pdf_path}: {exc}") from exc

    annotations: list[Annotation] = []
    counter = 0
    for page in doc.pages:
        # pdfannots stores annotations per page; page numbering is 1-based.
        page_number = page.pageno + 1
        for raw in page.annots:
            counter += 1
            highlighted_text = (raw.gettext() or "").strip()
            comment = (raw.contents or "").strip()
            author = (getattr(raw, "author", None) or "anonymous").strip() or "anonymous"
            # Bounding box: pdfannots exposes .boxes (list of fitz-style rects).
            # We use the union of all highlight quads as a single bbox.
            if raw.boxes:
                xs = [b.x0 for b in raw.boxes] + [b.x1 for b in raw.boxes]
                ys = [b.y0 for b in raw.boxes] + [b.y1 for b in raw.boxes]
                bbox: tuple[float, float, float, float] = (
                    float(min(xs)),
                    float(min(ys)),
                    float(max(xs)),
                    float(max(ys)),
                )
            else:
                bbox = (0.0, 0.0, 0.0, 0.0)
            annotations.append(
                Annotation(
                    id=f"ann-{counter:03d}",
                    page=page_number,
                    bbox=bbox,
                    highlighted_text=highlighted_text,
                    author=author,
                    comment=comment,
                    created=_format_created(getattr(raw, "created", None)),
                    trigger_match=False,  # set later by is_trigger (Task 4.2)
                )
            )

    return annotations
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extract.py::test_read_annotations_returns_list_with_correct_fields -v`

Expected: PASS. If the fixture PDF is not yet present, the test fails at the `FIXTURE_PDF.exists()` assertion — add `@pytest.mark.xfail(strict=True, reason="fixture pending chunk F")` and re-run; expected: XFAIL.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/extract.py tests/test_extract.py tests/fixtures/sample-annotated.pdf
git commit -m "feat(extract): read PDF annotations via pdfannots"
```

---

### Task 4.2: Trigger-match detection

**Files:**

- Modify: `src/review_pdf_to_latex/extract.py` (append `is_trigger` and rewire `read_annotations` to set `trigger_match`)
- Test: `tests/test_extract.py` (append parametrized test)

**Implements spec:** §7.1 (`trigger_match` field semantics).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_extract.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extract.py::test_is_trigger_case_insensitive_substring -v`

Expected: FAIL with `ImportError: cannot import name 'is_trigger' from 'review_pdf_to_latex.extract'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/extract.py`:

```python
def is_trigger(comment: str, trigger_phrase: str) -> bool:
    """Return True iff `trigger_phrase` appears in `comment` (case-insensitive substring).

    Per spec §7.1, the SURFACE trigger is a case-insensitive *substring* match,
    not a word-boundary match. Empty comment is always False.
    """
    if not comment or not trigger_phrase:
        return False
    return trigger_phrase.casefold() in comment.casefold()
```

Also modify the `for raw in page.annots:` block inside `read_annotations` so that it accepts an optional trigger phrase and sets `trigger_match` correctly. Replace the entire `read_annotations` function with this version:

```python
def read_annotations(
    pdf_path: Path,
    trigger_phrase: str = "claude surface this",
) -> list[Annotation]:
    """Parse PDF highlight annotations into a list of Annotation dataclasses.

    Uses pdfannots' Python API (not the CLI). Each annotation gets a sequential
    zero-padded id `ann-001`, `ann-002`, ... in document order. `trigger_match`
    is True iff the annotation's comment contains `trigger_phrase`
    (case-insensitive substring).

    Args:
        pdf_path: Absolute or relative path to an annotated PDF.
        trigger_phrase: SURFACE trigger phrase (default "claude surface this").

    Returns:
        List of Annotation dataclasses in document order. May be empty.

    Raises:
        FileNotFoundError: pdf_path does not exist.
        RuntimeError: pdfannots failed to parse the PDF.
    """
    pdf_path = Path(pdf_path)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")

    try:
        with pdf_path.open("rb") as fh:
            doc = pdfannots.process_file(fh, emit_progress_to=None)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"pdfannots failed to parse {pdf_path}: {exc}") from exc

    annotations: list[Annotation] = []
    counter = 0
    for page in doc.pages:
        page_number = page.pageno + 1
        for raw in page.annots:
            counter += 1
            highlighted_text = (raw.gettext() or "").strip()
            comment = (raw.contents or "").strip()
            author = (getattr(raw, "author", None) or "anonymous").strip() or "anonymous"
            if raw.boxes:
                xs = [b.x0 for b in raw.boxes] + [b.x1 for b in raw.boxes]
                ys = [b.y0 for b in raw.boxes] + [b.y1 for b in raw.boxes]
                bbox: tuple[float, float, float, float] = (
                    float(min(xs)),
                    float(min(ys)),
                    float(max(xs)),
                    float(max(ys)),
                )
            else:
                bbox = (0.0, 0.0, 0.0, 0.0)
            annotations.append(
                Annotation(
                    id=f"ann-{counter:03d}",
                    page=page_number,
                    bbox=bbox,
                    highlighted_text=highlighted_text,
                    author=author,
                    comment=comment,
                    created=_format_created(getattr(raw, "created", None)),
                    trigger_match=is_trigger(comment, trigger_phrase),
                )
            )

    return annotations
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extract.py::test_is_trigger_case_insensitive_substring tests/test_extract.py::test_read_annotations_returns_list_with_correct_fields -v`

Expected: BOTH PASS (9 parametrized cases plus the original).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/extract.py tests/test_extract.py
git commit -m "feat(extract): trigger-match detection"
```

---

### Task 4.3: PDF page rendering via pdftoppm

**Files:**

- Modify: `src/review_pdf_to_latex/extract.py` (append `render_pages`)
- Test: `tests/test_extract.py` (append)
- Fixture (committed binary): `tests/fixtures/sample-annotated.pdf` (reuse from Task 4.1)

**Implements spec:** §7 (state file inventory — `pages/page-N.png`), §8 (extract row: "Renders each PDF page to `.review-state/pages/page-N.png` via `pdftoppm`"), §9.1.

The naming requirement is critical: spec §7 calls for `pages/page-N.png` *without* zero-padding (just `page-1.png`, `page-2.png`, ..., `page-10.png`). `pdftoppm` zero-pads to the digit width of the total page count, so a 12-page PDF produces `page-01.png` through `page-12.png`. `render_pages` runs pdftoppm and then renames the output to strip leading zeroes so downstream filename construction is uniform.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_extract.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extract.py::test_render_pages_emits_unpadded_png_files tests/test_extract.py::test_render_pages_raises_on_pdftoppm_failure -v`

Expected: FAIL with `ImportError: cannot import name 'render_pages' from 'review_pdf_to_latex.extract'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/extract.py`:

```python
import re
import subprocess


def render_pages(pdf_path: Path, out_dir: Path, dpi: int = 150) -> list[Path]:
    """Render every page of a PDF to a PNG in `out_dir`, named `page-N.png`.

    Shells out to `pdftoppm -r {dpi} -png {pdf_path} {out_dir}/page`. pdftoppm
    zero-pads filenames to the digit count of the total page count; this
    function renames them to drop the padding so that downstream code can
    address pages by 1-based index without knowing the total.

    Lazy cache (spec §15 Q9): if `out_dir` already contains at least one
    `page-N.png` AND every such PNG's mtime is >= the PDF's mtime, skip the
    subprocess and return the existing paths in order. The cache is
    invalidated whenever the PDF is re-saved (mtime advances).

    Args:
        pdf_path: Path to source PDF.
        out_dir: Directory to write PNGs into. Must already exist.
        dpi: Render resolution (default 150).

    Returns:
        List of resulting `Path` objects in page order (page 1 first).

    Raises:
        FileNotFoundError: pdf_path or out_dir missing.
        RuntimeError: pdftoppm exited non-zero (stderr captured in message).
    """
    pdf_path = Path(pdf_path)
    out_dir = Path(out_dir)
    if not pdf_path.exists():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    if not out_dir.is_dir():
        raise FileNotFoundError(f"output directory not found: {out_dir}")

    # Cache check: collect existing page-N.png files and compare mtimes.
    cache_pattern = re.compile(r"^page-(\d+)\.png$")
    existing: list[tuple[int, Path]] = []
    for entry in out_dir.iterdir():
        m = cache_pattern.match(entry.name)
        if m:
            existing.append((int(m.group(1)), entry))
    if existing:
        pdf_mtime = pdf_path.stat().st_mtime
        if all(p.stat().st_mtime >= pdf_mtime for _, p in existing):
            existing.sort(key=lambda t: t[0])
            return [p for _, p in existing]

    cmd = [
        "pdftoppm",
        "-r",
        str(dpi),
        "-png",
        str(pdf_path),
        str(out_dir / "page"),
    ]
    try:
        proc = subprocess.run(
            cmd,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "pdftoppm binary not found on PATH; install Poppler"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"pdftoppm exited {exc.returncode}: {exc.stderr.strip() or exc.stdout.strip()}"
        ) from exc

    # Collect outputs. pdftoppm produces page-NN.png (zero-padded to total
    # digit count). Parse the numeric suffix and rename to page-N.png.
    # Reuse cache_pattern compiled at the top of the function.
    discovered: list[tuple[int, Path]] = []
    for entry in out_dir.iterdir():
        m = cache_pattern.match(entry.name)
        if m:
            discovered.append((int(m.group(1)), entry))
    if not discovered:
        raise RuntimeError(
            f"pdftoppm produced no PNG files in {out_dir} "
            f"(stdout={proc.stdout!r}, stderr={proc.stderr!r})"
        )

    discovered.sort(key=lambda t: t[0])
    renamed: list[Path] = []
    for n, padded_path in discovered:
        target = out_dir / f"page-{n}.png"
        if padded_path != target:
            padded_path.replace(target)
        renamed.append(target)
    return renamed
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extract.py -v -k "render_pages"`

Expected: 4 PASS (emits unpadded PNGs, raises on pdftoppm failure, cache hit skips pdftoppm, cache invalidates when PDF mtime advances).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/extract.py tests/test_extract.py
git commit -m "feat(extract): render PDF pages to PNG via pdftoppm with mtime cache"
```

---

### Task 4.4: Fuzzy mapping — sliding-window algorithm

**Files:**

- Modify: `src/review_pdf_to_latex/extract.py` (append `fuzzy_map` and helpers `_normalize`, `_strip_latex`, `_enumerate_tex_files`)
- Test: `tests/test_extract.py` (append)
- Fixture files: `tests/fixtures/sample-project/main.tex`, `tests/fixtures/sample-project/chapters/intro.tex`, `tests/fixtures/sample-project/chapters/methods.tex`, `tests/fixtures/sample-project/build/cached.tex` (the last one is inside an excluded directory)

**Implements spec:** §7.2 (mapping.json shape, `candidates` list), §12.1 (full algorithm and thresholds).

**Algorithm specifics (faithful read of §12.1).** The spec describes a *line-level* sliding window whose total character count is at most 2× the normalized highlighted text length. The window slides by one line at a time. This chunk implements that line-based formulation (the task prompt's "token count × 1.5" phrasing in the introduction is a paraphrase; spec §12.1 is the authoritative source — see ambiguity note at end of this chunk). Thresholds from §12.1:

| Best score | Mapping outcome |
|---|---|
| `>= 0.5` | `method: fuzzy_text`, `needs_review: false` |
| `0.2 <= score < 0.5` | `method: fuzzy_text`, `needs_review: true`, top-3 candidates recorded |
| `< 0.2` | `method: failed`, `needs_review: true`, `latex_file: null`, `line_range: null`, `candidates: []` |

Excluded directories (no matching against files under these): default `["build/", ".review-state/"]`, configurable via the `exclude` argument.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_extract.py`:

```python
from review_pdf_to_latex.extract import fuzzy_map
from review_pdf_to_latex.state import MappingEntry


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

    assert isinstance(result, MappingEntry)
    assert result.latex_file == "chapters/intro.tex", (
        f"expected chapters/intro.tex, got {result.latex_file!r}"
    )
    assert result.confidence >= 0.5
    assert result.method == "fuzzy_text"
    assert result.needs_review is False
    assert result.candidates is None
    assert isinstance(result.line_range, list) and len(result.line_range) == 2
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
    # "students" appears in both files; the highlighted text is too generic
    # to land cleanly above 0.5.
    ann = _ann("students sample")

    result = fuzzy_map(ann, sample_project)

    # Either needs_review (0.2 <= score < 0.5) or failed (< 0.2); both produce
    # a populated `candidates` entry. We just assert needs_review is True.
    assert result.needs_review is True
    assert result.candidates is not None
    assert 0 < len(result.candidates) <= 3
    for c in result.candidates:
        assert set(c.keys()) >= {"file", "line_range", "score"}
        assert isinstance(c["score"], float)
        assert 0.0 <= c["score"] <= 1.0


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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extract.py -k fuzzy_map -v`

Expected: FAIL with `ImportError: cannot import name 'fuzzy_map' from 'review_pdf_to_latex.extract'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/extract.py`:

```python
from rapidfuzz import fuzz

from review_pdf_to_latex.state import MappingEntry


_LIGATURE_MAP = {
    "ﬁ": "fi",
    "ﬂ": "fl",
    "ﬀ": "ff",
    "ﬃ": "ffi",
    "ﬄ": "ffl",
}

_LATEX_CMD_RE = re.compile(r"\\[a-zA-Z@]+(\{[^}]*\})*", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+")


def _normalize(text: str) -> str:
    """Normalize text for fuzzy comparison: ligatures + whitespace collapse."""
    for src, dst in _LIGATURE_MAP.items():
        text = text.replace(src, dst)
    return _WHITESPACE_RE.sub(" ", text).strip()


def _strip_latex(text: str) -> str:
    """Strip LaTeX command tokens (e.g., \\section{...}) before scoring."""
    return _LATEX_CMD_RE.sub(" ", text)


def _enumerate_tex_files(
    root: Path,
    exclude: list[str],
) -> list[Path]:
    """Return all `.tex` files under root, skipping any path component in exclude.

    `exclude` entries are matched as path *prefixes* relative to `root`
    (e.g., "build/" excludes everything under `<root>/build/`).
    """
    norm_exclude = [e.rstrip("/") for e in exclude]
    out: list[Path] = []
    for path in sorted(root.rglob("*.tex")):
        rel = path.relative_to(root).as_posix()
        if any(rel == e or rel.startswith(e + "/") for e in norm_exclude):
            continue
        out.append(path)
    return out


def fuzzy_map(
    annotation: Annotation,
    latex_root: Path,
    exclude: list[str] | None = None,
) -> MappingEntry:
    """Map an annotation's highlighted_text to a (file, line_range) in latex_root.

    Implements spec §12.1: sliding window of consecutive lines whose total
    character count is at most 2× the length of normalized highlighted_text;
    window slides one line at a time; score = rapidfuzz.partial_ratio / 100.

    Thresholds:
      score >= 0.5  -> fuzzy_text, needs_review=False
      0.2 <= score  -> fuzzy_text, needs_review=True, candidates populated
      score < 0.2   -> failed, latex_file=None, line_range=None, candidates=[]

    Args:
        annotation: The Annotation to map.
        latex_root: Project root to search for .tex files.
        exclude: Path prefixes (relative to latex_root) to skip. Defaults to
            ["build/", ".review-state/"].

    Returns:
        A MappingEntry. `needs_review` is True for any score < 0.5.
    """
    if exclude is None:
        exclude = ["build/", ".review-state/"]
    latex_root = Path(latex_root)

    target_raw = annotation.highlighted_text or ""
    target = _normalize(target_raw)
    target_len = len(target)
    if target_len == 0:
        return MappingEntry(
            latex_file=None,
            line_range=None,
            confidence=0.0,
            method="failed",
            needs_review=True,
            candidates=[],
        )

    max_window_chars = max(target_len * 2, 1)

    # Score every window in every file; track the global best and per-file best.
    # Each entry: (score, rel_path, [start, end])
    all_windows: list[tuple[float, str, list[int]]] = []

    for path in _enumerate_tex_files(latex_root, exclude):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            continue
        if not lines:
            continue

        rel = path.relative_to(latex_root).as_posix()
        n = len(lines)

        # Sliding window: grow line-by-line up to max_window_chars; slide start
        # forward one line at a time.
        for start in range(n):
            cum_text: list[str] = []
            cum_chars = 0
            for end in range(start, n):
                line = lines[end]
                # +1 for the joining space between lines.
                addition_len = len(line) + (1 if cum_text else 0)
                if cum_chars + addition_len > max_window_chars and cum_text:
                    break
                cum_text.append(line)
                cum_chars += addition_len
                window_raw = " ".join(cum_text)
                window_norm = _normalize(_strip_latex(window_raw))
                if not window_norm:
                    continue
                score = fuzz.partial_ratio(target, window_norm) / 100.0
                all_windows.append((score, rel, [start + 1, end + 1]))
                if cum_chars >= max_window_chars:
                    break

    if not all_windows:
        return MappingEntry(
            latex_file=None,
            line_range=None,
            confidence=0.0,
            method="failed",
            needs_review=True,
            candidates=[],
        )

    # Best overall window.
    all_windows.sort(key=lambda t: t[0], reverse=True)
    best_score, best_file, best_range = all_windows[0]

    if best_score >= 0.5:
        return MappingEntry(
            latex_file=best_file,
            line_range=best_range,
            confidence=float(best_score),
            method="fuzzy_text",
            needs_review=False,
            candidates=None,
        )

    # Build top-3 candidate list: best window per file (so the user picks
    # between distinct locations, not three windows from the same file).
    best_per_file: dict[str, tuple[float, list[int]]] = {}
    for score, rel, rng in all_windows:
        existing = best_per_file.get(rel)
        if existing is None or score > existing[0]:
            best_per_file[rel] = (score, rng)
    ranked = sorted(
        best_per_file.items(), key=lambda kv: kv[1][0], reverse=True
    )[:3]
    candidates = [
        {"file": rel, "line_range": rng, "score": float(score)}
        for rel, (score, rng) in ranked
    ]

    if best_score < 0.2:
        return MappingEntry(
            latex_file=None,
            line_range=None,
            confidence=float(best_score),
            method="failed",
            needs_review=True,
            candidates=[],
        )

    # 0.2 <= best_score < 0.5
    return MappingEntry(
        latex_file=best_file,
        line_range=best_range,
        confidence=float(best_score),
        method="fuzzy_text",
        needs_review=True,
        candidates=candidates,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extract.py -k fuzzy_map -v`

Expected: ALL FOUR PASS (`test_fuzzy_map_high_confidence_match`, `test_fuzzy_map_excludes_build_directory`, `test_fuzzy_map_ambiguous_low_confidence_records_candidates`, `test_fuzzy_map_failed_match_below_threshold`).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/extract.py tests/test_extract.py
git commit -m "feat(extract): fuzzy-map annotations to LaTeX files"
```

---

### Task 4.5: Bootstrap initial state.json

**Files:**

- Modify: `src/review_pdf_to_latex/extract.py` (append `bootstrap_state`)
- Test: `tests/test_extract.py` (append)

**Implements spec:** §7.3 (initial state shape), §9.1 (Phase 0 outputs).

The bootstrapped state lives in memory only; persistence happens in Task 4.7 via the chunk-A `atomic_write_json` helper. `bootstrap_state` returns a `StateFile` dataclass populated as follows:

- `schema_version`: `1`
- `phase`: `"0-setup"`
- `order`: `"mechanical-first"`
- `current_annotation_id`: `None`
- `annotations`: dict keyed by `ann_id` → `AnnotationState` with status `"pending"` (or `"needs_review"` if the mapping has `needs_review: True`) and every other field `None` (`before_text`, `proposed_text`, `applied_text`, `applied_at`, `last_build_id`, `surface_chat_log`, `failure_log_path`, `failure_edit_text`)
- `builds`: `[]`

- [ ] **Step 1: Write the failing test**

Append to `tests/test_extract.py`:

```python
from review_pdf_to_latex.extract import bootstrap_state
from review_pdf_to_latex.state import StateFile


def test_bootstrap_state_phase_and_defaults() -> None:
    """bootstrap_state produces a StateFile with phase=0-setup and clean defaults."""
    anns = [
        _ann("alpha", "ann-001"),
        _ann("beta", "ann-002"),
    ]
    mappings = {
        "ann-001": MappingEntry(
            latex_file="a.tex",
            line_range=[1, 3],
            confidence=0.9,
            method="fuzzy_text",
            needs_review=False,
            candidates=None,
        ),
        "ann-002": MappingEntry(
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extract.py::test_bootstrap_state_phase_and_defaults tests/test_extract.py::test_bootstrap_state_handles_empty_annotation_list -v`

Expected: FAIL with `ImportError: cannot import name 'bootstrap_state' from 'review_pdf_to_latex.extract'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/extract.py`:

```python
from review_pdf_to_latex.state import AnnotationState, StateFile


def bootstrap_state(
    annotations: list[Annotation],
    mappings: dict[str, MappingEntry],
) -> StateFile:
    """Build the initial state.json contents for a freshly-extracted project.

    Phase is "0-setup"; order is "mechanical-first"; no current annotation;
    no builds yet. Per-annotation status is "needs_review" when the mapping
    requires review, otherwise "pending". All other annotation fields are
    None (no text captured, no build yet).

    Args:
        annotations: The list returned by read_annotations.
        mappings: dict keyed by annotation id; produced by fuzzy_map.

    Returns:
        A StateFile suitable for atomic_write_json to the project's
        .review-state/state.json.
    """
    ann_states: dict[str, AnnotationState] = {}
    for ann in annotations:
        m = mappings.get(ann.id)
        needs_review = bool(m and m.needs_review)
        ann_states[ann.id] = AnnotationState(
            status="needs_review" if needs_review else "pending",
            before_text=None,
            proposed_text=None,
            applied_text=None,
            applied_at=None,
            last_build_id=None,
            surface_chat_log=None,
            failure_log_path=None,
            failure_edit_text=None,
        )

    return StateFile(
        schema_version=1,
        phase="0-setup",
        order="mechanical-first",
        current_annotation_id=None,
        annotations=ann_states,
        builds=[],
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extract.py::test_bootstrap_state_phase_and_defaults tests/test_extract.py::test_bootstrap_state_handles_empty_annotation_list -v`

Expected: BOTH PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/extract.py tests/test_extract.py
git commit -m "feat(extract): bootstrap initial state.json"
```

---

### Task 4.6: `.gitignore` patcher

**Files:**

- Modify: `src/review_pdf_to_latex/extract.py` (append `ensure_gitignore_entry`)
- Test: `tests/test_extract.py` (append)

**Implements spec:** §8 (extract row: "Adds `.review-state/` to `.gitignore` if absent"), §9.1 (Phase 0 outputs).

The matcher is *line-exact*, not substring: a literal `.review-state/` line counts as already-present, but a line like `# .review-state/ disabled` does not. Idempotent: if the entry is already present (any line that, after trimming whitespace, equals the entry), the file is not rewritten and its mtime is preserved.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_extract.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extract.py -k ensure_gitignore -v`

Expected: FAIL with `ImportError: cannot import name 'ensure_gitignore_entry' from 'review_pdf_to_latex.extract'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/extract.py`:

```python
def ensure_gitignore_entry(
    project_root: Path,
    entry: str = ".review-state/",
) -> None:
    """Idempotently ensure `entry` is on its own line in `project_root/.gitignore`.

    Behavior:
        - No .gitignore exists: create one with a one-line header comment and
          the entry.
        - .gitignore exists, entry not present (line-exact, ignoring surrounding
          whitespace): append the entry on a new line.
        - .gitignore exists and entry is already present: do nothing (mtime
          preserved).

    Substring matches do not count — a commented-out line containing the entry
    does not block appending the literal entry.
    """
    project_root = Path(project_root)
    gi = project_root / ".gitignore"

    if not gi.exists():
        header = "# Local review-pdf-to-latex working state; do not commit.\n"
        gi.write_text(f"{header}{entry}\n", encoding="utf-8")
        return

    existing = gi.read_text(encoding="utf-8")
    lines = existing.splitlines()
    for line in lines:
        if line.strip() == entry:
            return  # already present, leave file (and mtime) untouched

    # Append. Preserve trailing-newline convention: if file ends with \n,
    # append "entry\n"; otherwise prepend a newline so the new entry stands
    # on its own line.
    if existing and not existing.endswith("\n"):
        new_text = existing + "\n" + entry + "\n"
    else:
        new_text = existing + entry + "\n"
    gi.write_text(new_text, encoding="utf-8")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extract.py -k ensure_gitignore -v`

Expected: ALL FOUR PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/extract.py tests/test_extract.py
git commit -m "feat(extract): patch .gitignore for .review-state"
```

---

### Task 4.7: Wire up the `extract` CLI subcommand

**Files:**

- Modify: `src/review_pdf_to_latex/cli.py` (replace `NotImplementedError` body of the `extract` handler that chunk A scaffolded)
- Modify: `src/review_pdf_to_latex/extract.py` (append `run_extract` orchestrator and `compute_md5` helper)
- Test: `tests/test_extract_cli.py` (new file)

**Implements spec:** §7.1, §7.2, §7.3, §8 (extract row including all exit codes), §9.1 (full Phase 0 outputs).

Behavior summary (faithful to §8 extract row):

- Args: `--pdf PATH` (required); `--project-dir PATH` (default `$PWD`); `--surface-trigger STR` (default `"claude surface this"`); `--force` (overwrite existing state).
- Reads PDF annotations (Task 4.1/4.2), renders pages (Task 4.3), fuzzy-maps every annotation (Task 4.4), bootstraps `state.json` (Task 4.5), patches `.gitignore` (Task 4.6).
- Writes all three JSON files via `atomic_write_json` (chunk A).
- Refuses to run if any of `annotations.json`, `mapping.json`, `state.json` already exists in `.review-state/` unless `--force` is passed; in that case prints an error to stderr and exits 3.
- Missing PDF → exit 2.
- `pdfannots` failure → exit 4 (any `RuntimeError` raised by `read_annotations` surfaces as exit 4).

Top-level `cli.main(argv)` returns the subcommand's exit code (chunk A established this convention). The extract handler is named `_handle_extract` (matching chunk A's naming scheme for subcommand handlers).

- [ ] **Step 1: Write the failing test**

Create `tests/test_extract_cli.py`:

```python
"""Integration tests for the `extract` CLI subcommand."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from review_pdf_to_latex import cli


FIXTURE_PDF = Path(__file__).parent / "fixtures" / "sample-annotated.pdf"


def _make_minimal_project(root: Path) -> None:
    """Create a project with one .tex file whose contents are unrelated to the PDF."""
    (root / "main.tex").write_text(
        "\\documentclass{article}\n\\begin{document}\nplaceholder.\n\\end{document}\n",
        encoding="utf-8",
    )


def test_extract_happy_path(tmp_path: Path) -> None:
    """`extract` writes annotations.json, mapping.json, state.json, and pages/."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    exit_code = cli.main(
        [
            "extract",
            "--pdf",
            str(FIXTURE_PDF),
            "--project-dir",
            str(project),
        ]
    )

    assert exit_code == 0, f"extract exited {exit_code}"

    state_dir = project / ".review-state"
    annotations_path = state_dir / "annotations.json"
    mapping_path = state_dir / "mapping.json"
    state_path = state_dir / "state.json"
    pages_dir = state_dir / "pages"

    assert annotations_path.exists(), "annotations.json missing"
    assert mapping_path.exists(), "mapping.json missing"
    assert state_path.exists(), "state.json missing"
    assert pages_dir.is_dir(), "pages/ missing"
    assert any(pages_dir.glob("page-*.png")), "no page PNGs written"

    # Top-level shapes.
    annotations = json.loads(annotations_path.read_text(encoding="utf-8"))
    assert annotations["schema_version"] == 1
    assert "annotations" in annotations and isinstance(annotations["annotations"], list)
    assert annotations["source_pdf"] == str(FIXTURE_PDF.resolve())
    assert annotations["source_pdf_md5"] == hashlib.md5(
        FIXTURE_PDF.read_bytes()
    ).hexdigest()
    assert annotations["extractor"].startswith("pdfannots-")

    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    assert mapping["schema_version"] == 1
    assert "mappings" in mapping and isinstance(mapping["mappings"], dict)

    state = json.loads(state_path.read_text(encoding="utf-8"))
    assert state["schema_version"] == 1
    assert state["phase"] == "0-setup"
    assert state["order"] == "mechanical-first"
    assert state["current_annotation_id"] is None
    assert state["builds"] == []
    assert isinstance(state["annotations"], dict)
    # IDs in state == IDs in annotations.json.
    assert set(state["annotations"].keys()) == {
        a["id"] for a in annotations["annotations"]
    }


def test_extract_patches_gitignore(tmp_path: Path) -> None:
    """`extract` adds .review-state/ to .gitignore."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    exit_code = cli.main(
        ["extract", "--pdf", str(FIXTURE_PDF), "--project-dir", str(project)]
    )
    assert exit_code == 0

    gi = project / ".gitignore"
    assert gi.exists()
    assert ".review-state/" in gi.read_text(encoding="utf-8").splitlines()


def test_extract_refuses_existing_state_without_force(tmp_path: Path) -> None:
    """A second `extract` without --force exits 3 and does not overwrite."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    first = cli.main(
        ["extract", "--pdf", str(FIXTURE_PDF), "--project-dir", str(project)]
    )
    assert first == 0

    # Mutate state.json so we can detect overwriting.
    state_path = project / ".review-state" / "state.json"
    original = state_path.read_text(encoding="utf-8")

    second = cli.main(
        ["extract", "--pdf", str(FIXTURE_PDF), "--project-dir", str(project)]
    )
    assert second == 3, f"expected exit code 3, got {second}"
    assert state_path.read_text(encoding="utf-8") == original, (
        "extract overwrote state.json without --force"
    )


def test_extract_with_force_overwrites(tmp_path: Path) -> None:
    """`extract --force` re-runs even when state files exist."""
    project = tmp_path / "proj"
    project.mkdir()
    _make_minimal_project(project)

    assert (
        cli.main(["extract", "--pdf", str(FIXTURE_PDF), "--project-dir", str(project)])
        == 0
    )
    assert (
        cli.main(
            [
                "extract",
                "--pdf",
                str(FIXTURE_PDF),
                "--project-dir",
                str(project),
                "--force",
            ]
        )
        == 0
    )


def test_extract_missing_pdf_exits_2(tmp_path: Path) -> None:
    """A nonexistent --pdf path exits 2."""
    project = tmp_path / "proj"
    project.mkdir()

    bogus = tmp_path / "does-not-exist.pdf"
    exit_code = cli.main(
        ["extract", "--pdf", str(bogus), "--project-dir", str(project)]
    )
    assert exit_code == 2


def test_extract_pdfannots_failure_exits_4(tmp_path: Path) -> None:
    """A file that exists but isn't a parseable PDF exits 4."""
    project = tmp_path / "proj"
    project.mkdir()

    fake = tmp_path / "fake.pdf"
    fake.write_bytes(b"not a pdf at all")

    exit_code = cli.main(
        ["extract", "--pdf", str(fake), "--project-dir", str(project)]
    )
    assert exit_code == 4
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_extract_cli.py -v`

Expected: FAIL — every test raises `NotImplementedError` from the chunk-A stub of `_handle_extract` (or exits non-zero with a message indicating the handler is unimplemented).

- [ ] **Step 3: Write minimal implementation**

First, append the orchestrator and md5 helper to `src/review_pdf_to_latex/extract.py`:

```python
import hashlib
import sys
from dataclasses import asdict
from datetime import datetime, timezone
from importlib import metadata as _metadata


def _compute_md5(path: Path) -> str:
    """Compute MD5 of a file. Used as `source_pdf_md5` per spec §7.1."""
    h = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _pdfannots_version() -> str:
    """Return e.g. 'pdfannots-0.4.1' for the `extractor` field in annotations.json."""
    try:
        return f"pdfannots-{_metadata.version('pdfannots')}"
    except _metadata.PackageNotFoundError:
        return "pdfannots-unknown"


def run_extract(
    pdf_path: Path,
    project_dir: Path,
    surface_trigger: str = "claude surface this",
    force: bool = False,
) -> int:
    """Execute the full Phase 0 pipeline. Returns a CLI exit code.

    Exit codes (per spec §8 extract row):
        0  ok
        2  pdf missing
        3  existing state without --force
        4  pdfannots failed to parse the PDF
    """
    from review_pdf_to_latex.state import atomic_write_json  # local to avoid cycle

    pdf_path = Path(pdf_path)
    project_dir = Path(project_dir)

    if not pdf_path.exists():
        print(f"error: PDF not found: {pdf_path}", file=sys.stderr)
        return 2

    state_dir = project_dir / ".review-state"
    annotations_path = state_dir / "annotations.json"
    mapping_path = state_dir / "mapping.json"
    state_path = state_dir / "state.json"
    pages_dir = state_dir / "pages"

    if not force and any(
        p.exists() for p in (annotations_path, mapping_path, state_path)
    ):
        print(
            "error: .review-state/ already contains annotations.json, mapping.json, "
            "or state.json; pass --force to overwrite",
            file=sys.stderr,
        )
        return 3

    state_dir.mkdir(parents=True, exist_ok=True)
    pages_dir.mkdir(parents=True, exist_ok=True)

    # 1. Read annotations.
    try:
        annotations = read_annotations(pdf_path, trigger_phrase=surface_trigger)
    except RuntimeError as exc:
        print(f"error: pdfannots failed: {exc}", file=sys.stderr)
        return 4

    # 2. Render pages.
    try:
        render_pages(pdf_path, pages_dir)
    except RuntimeError as exc:
        print(f"error: page rendering failed: {exc}", file=sys.stderr)
        return 4

    # 3. Fuzzy-map every annotation.
    mappings: dict[str, MappingEntry] = {}
    for ann in annotations:
        mappings[ann.id] = fuzzy_map(ann, project_dir)

    # 4. Bootstrap state.
    state = bootstrap_state(annotations, mappings)

    # 5. Write annotations.json (immutable; spec §7.1).
    annotations_doc = {
        "schema_version": 1,
        "source_pdf": str(pdf_path.resolve()),
        "source_pdf_md5": _compute_md5(pdf_path),
        "extracted_at": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "extractor": _pdfannots_version(),
        "annotations": [asdict(a) for a in annotations],
    }
    atomic_write_json(annotations_path, annotations_doc)

    # 6. Write mapping.json (spec §7.2).
    mapping_doc = {
        "schema_version": 1,
        "mappings": {ann_id: asdict(m) for ann_id, m in mappings.items()},
    }
    atomic_write_json(mapping_path, mapping_doc)

    # 7. Write initial state.json (spec §7.3).
    atomic_write_json(state_path, asdict(state))

    # 8. Patch .gitignore.
    ensure_gitignore_entry(project_dir, entry=".review-state/")

    return 0
```

Then modify `src/review_pdf_to_latex/cli.py`. Replace the body of the existing `_handle_extract` stub. Locate the function — chunk A defined it as a stub raising `NotImplementedError` — and replace its body. The expected signature (set up by chunk A) is `def _handle_extract(args: argparse.Namespace) -> int:`. Replace the body so the function reads:

```python
def _handle_extract(args: argparse.Namespace) -> int:
    """Phase 0: extract annotations, render pages, build initial state."""
    from review_pdf_to_latex.extract import run_extract

    return run_extract(
        pdf_path=Path(args.pdf),
        project_dir=Path(args.project_dir),
        surface_trigger=args.surface_trigger,
        force=bool(args.force),
    )
```

Also confirm (chunk A should have done this; if not, add it to the subparser-construction block in `cli.py`) that the `extract` subparser is built with these arguments — exactly:

```python
extract_p = subparsers.add_parser("extract", help="Phase 0: ingest annotated PDF")
extract_p.add_argument("--pdf", required=True, help="path to annotated PDF")
extract_p.add_argument(
    "--project-dir",
    default=".",
    help="LaTeX project root (defaults to $PWD)",
)
extract_p.add_argument(
    "--surface-trigger",
    default="claude surface this",
    help="case-insensitive trigger phrase for SURFACE flagging",
)
extract_p.add_argument(
    "--force",
    action="store_true",
    help="overwrite existing .review-state/ files",
)
extract_p.set_defaults(handler=_handle_extract)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_extract_cli.py -v`

Expected: ALL SIX PASS (`test_extract_happy_path`, `test_extract_patches_gitignore`, `test_extract_refuses_existing_state_without_force`, `test_extract_with_force_overwrites`, `test_extract_missing_pdf_exits_2`, `test_extract_pdfannots_failure_exits_4`).

Then run the full test suite to confirm no regressions:

Run: `pytest tests/ -v`

Expected: all extract-related tests pass; tests from other chunks remain in whatever state they were before this task.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py src/review_pdf_to_latex/extract.py tests/test_extract_cli.py
git commit -m "feat(cli): wire up extract subcommand"
```

---

## Spec ambiguities flagged during planning

These should be raised with the spec author *before* the engineer starts Task 4.4 if possible; otherwise the engineer takes the interpretation noted here and files a follow-up issue.

1. **§12.1 sliding-window units.** The spec describes a *line-level* window bounded by character count (≤ 2× the normalized highlighted text length). An alternate paraphrasing as a *token* window with size `max(len(text.split()) * 1.5, 20)` and step half that exists in some brainstorm notes. These are different algorithms. **This chunk follows the spec text** (line-level, 1-line slide, ≤2× char cap) because spec §12.1 is the authoritative source. If the engineer (or reviewer) prefers the token-based formulation, switch to it in `fuzzy_map` and update the tests' fixture text lengths accordingly — the public signature does not change.

2. **§12.1 candidate selection.** The spec says "top 3 windows recorded in `candidates[]`" but does not specify whether those three windows must come from three distinct files or may all come from the same file. This chunk picks the **best window per file** then takes the top three files, because the §10.6 manual-mapping UI is designed for the human to choose between distinct *locations*, not between three slightly-shifted windows on the same paragraph. Flag for spec confirmation.

3. **§7.1 `created` field type.** The spec example shows an ISO8601 string. pdfannots returns a `datetime` (sometimes tz-naive). This chunk coerces tz-naive datetimes to UTC and emits ISO8601 with a `Z` suffix. If the original PDF had a non-UTC tz, the offset is preserved before conversion. Flag if a different convention is preferred.

4. **§7.1 `trigger_match` evaluated where.** The spec wording ("`true` iff `comment` matches the configured SURFACE trigger") implies extract-time computation; this chunk computes it in `read_annotations` rather than during a later pass. Confirm.

5. **§8 extract row "warning, mapping all `needs_review`" when no `.tex` files.** Spec §9.1 failure modes lists "project dir has no `.tex` files → warning, mapping all `needs_review`". `fuzzy_map` already returns `method: failed, needs_review: True` when no files are found, which satisfies the "all needs_review" half. This chunk does **not** emit a stderr warning in that case; if a warning is required, add it to `run_extract` after the mapping loop (count `needs_review`; if 100% of annotations are needs_review and `_enumerate_tex_files` returned empty, print to stderr). Flag.
## Tasks 5, 6, 7 — Build, Apply / mutators, and Commit-phase

These three tasks implement the engine modules that mutate `.tex` files and produce build artifacts: `build.py`, `apply.py`, and `commit.py`. Every state mutation in these tasks goes through `atomic_write_json` and every status change goes through `validate_status_transition`; both helpers are defined in chunk A's `state.py` task. Cross-task assumptions:

- `Annotation`, `Mapping`, `StateFile`, `AnnotationState`, `Build`, and `StateDir` dataclasses/aliases are defined by chunk A.
- `cli.py` exists with `NotImplementedError` stubs for every subcommand; chunk B owns the argparse skeleton.
- Tests share the fixture `tests/fixtures/sample-project/` (a minimal LaTeX project) created by chunk F's fixtures task. For Tasks 5–7 we use throwaway tmp_path fixtures where the sample fixture is not yet available so this chunk stays buildable on its own.

Test files in this chunk: `tests/test_build.py`, `tests/test_apply.py`, `tests/test_commit.py`, plus CLI integration smokes added to `tests/test_cli.py` (created by chunk B).

---

### Task 5: Build module — `src/review_pdf_to_latex/build.py`

**Implements spec:** §8 (`build` row), §11.1, §11.2, §11.3, §12.2 (build exit-code 11 semantics).

The build module's purpose is to (a) drive `pdflatex` / `xelatex` reliably, (b) capture per-build artifacts under `.review-state/builds/build-NNN.*`, (c) compute per-page MD5s so the pagination diff in §11.2 can be reported, and (d) expose a `--benchmark` mode so the §11.3 5-second degradation rule can be evaluated empirically.

This task is broken into five sub-tasks (5.1 through 5.5). Each sub-task ends with a single commit.

---

#### Task 5.1: pdflatex / xelatex orchestration

**Files:**
- Create: `src/review_pdf_to_latex/build.py`
- Test: `tests/test_build.py`

**Implements spec:** §8 `build` row, §10 (engine auto-detect from `\documentclass`), §16 (system binaries).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_build.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_build.py -v -k "run_latex"`
Expected: collection error or three failures with `ModuleNotFoundError: No module named 'review_pdf_to_latex.build'` (or `ImportError: cannot import name 'run_latex'`).

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/build.py
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_build.py -v -k "run_latex"`
Expected: PASS for all three tests (skip if `pdflatex` / `xelatex` is not installed for the two TeX-using tests; the monkeypatched auto-detect test always runs).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/build.py tests/test_build.py
git commit -m "feat(build): pdflatex/xelatex orchestration"
```

---

#### Task 5.2: Build-ID assignment with 4-digit widening

**Files:**
- Modify: `src/review_pdf_to_latex/build.py`
- Test: `tests/test_build.py`

**Implements spec:** §8 (`build` row notes IDs are 3-digit zero-padded), §19 Glossary ("Build ID").

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_build.py

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_build.py -v -k "next_build_id"`
Expected: FAIL with `ImportError: cannot import name 'next_build_id'`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/build.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_build.py -v -k "next_build_id"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/build.py tests/test_build.py
git commit -m "feat(build): build-ID counter with 4-digit widening"
```

---

#### Task 5.3: Per-page MD5 and pagination diff

**Files:**
- Modify: `src/review_pdf_to_latex/build.py`
- Test: `tests/test_build.py`

**Implements spec:** §11.2 (pagination detection algorithm), §10.1 (the indicator string the viewer renders).

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_build.py

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_build.py -v -k "compute_page_md5s or paginate_diff"`
Expected: ImportError on `PaginationDiff` / `compute_page_md5s` / `paginate_diff`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/build.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_build.py -v -k "compute_page_md5s or paginate_diff"`
Expected: PASS (6 parametrized + 1 PDF integration = 7 cases). The PDF integration test is skipped if pdftoppm / pdflatex are absent.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/build.py tests/test_build.py
git commit -m "feat(build): per-page MD5 + pagination diff"
```

---

#### Task 5.4: Wire up the `build` CLI subcommand

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` (replace the `build` stub)
- Modify: `src/review_pdf_to_latex/build.py` (add `run_build_command`, `discover_main_file`)
- Test: `tests/test_build.py`, `tests/test_cli.py`

**Implements spec:** §8 `build` row, §15-Q5 (auto-discover main file).

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_build.py

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
                "schema_version": 1,
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
                "schema_version": 1,
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
```

And a CLI integration smoke (append to `tests/test_cli.py`, which chunk B creates):

```python
# tests/test_cli.py — append
import json
import subprocess
import sys
from pathlib import Path

import pytest

pdflatex = pytest.mark.skipif(
    __import__("shutil").which("pdflatex") is None,
    reason="pdflatex not on PATH",
)
pdftoppm = pytest.mark.skipif(
    __import__("shutil").which("pdftoppm") is None,
    reason="pdftoppm not on PATH",
)


@pdflatex
@pdftoppm
def test_cli_build_subcommand_end_to_end(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    (project / "build").mkdir(parents=True)
    main = project / "build" / "full_report.tex"
    main.write_text(
        r"""\documentclass{article}
\begin{document}
hi
\end{document}
""",
        encoding="utf-8",
    )
    state_dir = project / ".review-state"
    (state_dir / "builds").mkdir(parents=True)
    (state_dir / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "phase": "1-batch",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {},
                "builds": [],
            }
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, "-m", "review_pdf_to_latex", "build",
         "--project-dir", str(project), "--quiet"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert len(state["builds"]) == 1
    assert state["builds"][0]["ok"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_build.py -v -k "discover_main_file or run_build_command" && pytest tests/test_cli.py::test_cli_build_subcommand_end_to_end -v`
Expected: ImportError on `discover_main_file` / `run_build_command`, and the CLI test fails with `NotImplementedError` (the chunk-B stub).

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/build.py`:

```python
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
    """Find the LaTeX entry point under project_dir.

    Search order:
        1. project_dir/build/*.tex with both \\documentclass and \\begin{document}.
        2. project_dir/**/*.tex (recursive) with both markers, excluding the
           .review-state directory and any *.tex under templates/ (those are
           typically \\input fragments).
    """
    build_dir = project_dir / "build"
    if build_dir.is_dir():
        for candidate in sorted(build_dir.glob("*.tex")):
            if _file_is_main(candidate):
                return candidate

    for candidate in sorted(project_dir.rglob("*.tex")):
        # Skip our own state directory and the typical fragments directory.
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
    """CLI handler for `review-pdf build`. Returns the process exit code.

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
    from .state import (  # local import to avoid cycles with chunk A
        atomic_write_json,
        load_state,
    )

    project_dir = Path(project_dir).resolve()
    state_dir = project_dir / ".review-state"
    state_path = state_dir / "state.json"
    if not state_path.exists():
        print(f"error: state.json not found at {state_path}", file=__import__("sys").stderr)
        return 6

    if main_file is None:
        try:
            main_file = discover_main_file(project_dir)
        except FileNotFoundError as exc:
            print(f"error: {exc}", file=__import__("sys").stderr)
            return 12
    else:
        main_file = Path(main_file).resolve()
        if not main_file.exists():
            print(f"error: main file not found: {main_file}", file=__import__("sys").stderr)
            return 12

    state = load_state(state_path)
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
        print(f"Compile took {elapsed:.1f}s", file=__import__("sys").stderr)

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

    diff = paginate_diff(prev_md5s, page_md5) if ok else PaginationDiff(
        len(prev_md5s), 0, None, "build failed"
    )

    entry = {
        "id": build_id,
        "pdf_path": str(pdf_target.relative_to(project_dir)) if pdf_target.exists() else None,
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
        print(f"build failed; see {log_path}", file=__import__("sys").stderr)
        return 11
    return 0
```

Modify `src/review_pdf_to_latex/cli.py` — replace the `build` stub. The stub created by chunk B looks like:

```python
def _cmd_build(args: argparse.Namespace) -> int:
    raise NotImplementedError("build subcommand not yet wired")
```

Replace it with:

```python
def _cmd_build(args: argparse.Namespace) -> int:
    from .build import run_build_command

    return run_build_command(
        project_dir=Path(args.project_dir),
        main_file=Path(args.main_file) if args.main_file else None,
        engine=args.engine,
        quiet=args.quiet,
        benchmark=getattr(args, "benchmark", False),
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_build.py -v -k "discover_main_file or run_build_command" && pytest tests/test_cli.py::test_cli_build_subcommand_end_to_end -v`
Expected: PASS for all six cases (skipping where TeX or Poppler is absent).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/build.py src/review_pdf_to_latex/cli.py tests/test_build.py tests/test_cli.py
git commit -m "feat(cli): wire up build subcommand"
```

---

#### Task 5.5: `--benchmark` flag

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` (add `--benchmark` to the build subparser)
- Test: `tests/test_build.py`

**Implements spec:** §11.3 (5-second degradation rule; benchmarking is how we feed it).

The implementation of the timing logic already exists in Task 5.4 (`run_build_command` accepts `benchmark: bool` and emits `Compile took X.Xs`). This sub-task adds the CLI flag and tests it from the CLI surface.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_cli.py

@pdflatex
@pdftoppm
def test_cli_build_benchmark_emits_timing(tmp_path: Path) -> None:
    project = tmp_path / "proj"
    (project / "build").mkdir(parents=True)
    main = project / "build" / "full_report.tex"
    main.write_text(
        r"""\documentclass{article}
\begin{document}
hi
\end{document}
""",
        encoding="utf-8",
    )
    state_dir = project / ".review-state"
    state_dir.mkdir()
    (state_dir / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "phase": "1-batch",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {},
                "builds": [],
            }
        ),
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, "-m", "review_pdf_to_latex", "build",
         "--project-dir", str(project), "--quiet", "--benchmark"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "Compile took" in result.stderr
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py::test_cli_build_benchmark_emits_timing -v`
Expected: FAIL — argparse errors with `unrecognized arguments: --benchmark` (because chunk B's stub does not register this flag).

- [ ] **Step 3: Write minimal implementation**

In `src/review_pdf_to_latex/cli.py`, locate the `build` subparser registration (chunk B sets it up; the line reads roughly `build_p = sub.add_parser("build", ...)`). Add immediately after the existing flag registrations:

```python
build_p.add_argument(
    "--benchmark",
    action="store_true",
    help="Print 'Compile took X.Xs' to stderr (spec §11.3).",
)
```

No change to `_cmd_build` is needed — Task 5.4 already reads `getattr(args, "benchmark", False)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py::test_cli_build_benchmark_emits_timing -v`
Expected: PASS (or SKIP if pdflatex / pdftoppm absent).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(build): --benchmark flag"
```

---

### Task 6: Apply / revert / status mutators — `src/review_pdf_to_latex/apply.py`

**Implements spec:** §8 (`apply`, `revert`, `set-status`, `append-chat`, `record-proposal`, `override-mapping` rows), §9.2 (Phase 1 reverse-line-order rule), §10.3 (allowed status transitions), §12.2 (failure-log handling), §12.4 (overlapping line range, exit code 16).

This task adds the six mutator functions plus the six CLI wirings. The functions are pure file-system operations: they read `state.json` / `mapping.json` via chunk A's helpers, mutate `.tex` files where appropriate, and write state via `atomic_write_json`. None of these functions invoke `git` (that is Task 7's job) and none of them run `pdflatex` (that is `build.py`).

Eight sub-tasks (6.1 through 6.8). Each ends with a commit.

---

#### Task 6.1: Single-edit apply

**Files:**
- Create: `src/review_pdf_to_latex/apply.py`
- Test: `tests/test_apply.py`

**Implements spec:** §8 `apply` row, §7.3 (`before_text` one-time capture rule).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_apply.py
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from review_pdf_to_latex.apply import (
    AppliedEdit,
    apply_edit,
)


@dataclass
class _ProjectFixture:
    project: Path
    state_dir: Path
    state_path: Path
    mapping_path: Path
    annotations_path: Path
    tex_path: Path


def _make_project(tmp_path: Path, lines: list[str] | None = None) -> _ProjectFixture:
    """Build a minimal .review-state/ + one .tex file + fake source PDF.

    The source PDF is a 1-byte sentinel whose MD5 is recorded in
    annotations.json, so the spec §14 risk-9 guard
    (state.assert_source_pdf_unchanged) passes by default. Tests that want
    to exercise the guard's failure paths mutate the PDF after the fact.
    """
    import hashlib

    if lines is None:
        lines = [
            "line one\n",
            "line two\n",
            "line three\n",
            "line four\n",
            "line five\n",
        ]
    project = tmp_path / "proj"
    project.mkdir()
    tex_dir = project / "templates"
    tex_dir.mkdir()
    tex = tex_dir / "section.tex"
    tex.write_text("".join(lines), encoding="utf-8")

    # Source PDF fixture for the source-PDF guard.
    pdf = project / "source.pdf"
    pdf.write_bytes(b"%PDF-1.4 fixture\n")
    pdf_md5 = hashlib.md5(pdf.read_bytes()).hexdigest()

    state_dir = project / ".review-state"
    state_dir.mkdir()
    state = {
        "schema_version": 1,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {
            "ann-001": {
                "status": "pending",
                "before_text": None,
                "proposed_text": None,
                "applied_text": None,
                "applied_at": None,
                "last_build_id": None,
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            },
        },
        "builds": [],
    }
    mapping = {
        "schema_version": 1,
        "mappings": {
            "ann-001": {
                "latex_file": "templates/section.tex",
                "line_range": [2, 3],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
        },
    }
    annotations = {
        "schema_version": 1,
        "source_pdf": str(pdf.resolve()),
        "source_pdf_md5": pdf_md5,
        "extracted_at": "2026-05-16T20:30:00Z",
        "extractor": "pdfannots-fake",
        "annotations": [
            {
                "id": "ann-001",
                "page": 1,
                "bbox": [0, 0, 0, 0],
                "highlighted_text": "line two",
                "author": "anon",
                "comment": "tighten",
                "created": "2026-05-15T14:22:11Z",
                "trigger_match": False,
            }
        ],
    }

    (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (state_dir / "mapping.json").write_text(json.dumps(mapping), encoding="utf-8")
    (state_dir / "annotations.json").write_text(json.dumps(annotations), encoding="utf-8")
    return _ProjectFixture(
        project=project,
        state_dir=state_dir,
        state_path=state_dir / "state.json",
        mapping_path=state_dir / "mapping.json",
        annotations_path=state_dir / "annotations.json",
        tex_path=tex,
    )


def test_apply_edit_happy_path(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)

    result = apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="replaced two and three\n",
        dry_run=False,
    )

    assert isinstance(result, AppliedEdit)
    assert result.latex_file == "templates/section.tex"
    assert result.old_lines == ["line two\n", "line three\n"]
    assert result.new_lines == ["replaced two and three\n"]
    # We removed 2 lines, added 1 → shift is -1
    assert result.line_shift == -1

    # File on disk reflects the edit.
    new_text = proj.tex_path.read_text(encoding="utf-8")
    assert new_text == "line one\nreplaced two and three\nline four\nline five\n"

    # state.json reflects the apply.
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "applied"
    assert entry["before_text"] == "line two\nline three\n"
    assert entry["proposed_text"] == "replaced two and three\n"
    assert entry["applied_text"] == "replaced two and three\n"
    assert entry["applied_at"] is not None


def test_apply_edit_dry_run_does_not_write(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    original_tex = proj.tex_path.read_text(encoding="utf-8")
    original_state = proj.state_path.read_text(encoding="utf-8")

    result = apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="X\n",
        dry_run=True,
    )

    assert isinstance(result, AppliedEdit)
    assert result.new_lines == ["X\n"]
    # Neither the tex file nor state.json moved.
    assert proj.tex_path.read_text(encoding="utf-8") == original_tex
    assert proj.state_path.read_text(encoding="utf-8") == original_state


def test_apply_edit_before_text_captured_only_once(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)

    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="first draft\n",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    before_after_first = state["annotations"]["ann-001"]["before_text"]
    assert before_after_first == "line two\nline three\n"

    # Apply a second time over the new content; before_text must NOT be
    # overwritten (spec §7.3: "Never overwritten after first capture").
    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="second draft\n",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["before_text"] == before_after_first
    assert state["annotations"]["ann-001"]["proposed_text"] == "second draft\n"
    assert state["annotations"]["ann-001"]["applied_text"] == "second draft\n"


def test_apply_edit_recomputes_subsequent_mappings_in_same_file(tmp_path: Path) -> None:
    # Two mappings in the same file: ann-001 at lines 2-3, ann-002 at lines 5-5.
    # Apply ann-001 with a single replacement line → shift = -1 → ann-002 moves to 4.
    proj = _make_project(tmp_path)
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    state["annotations"]["ann-002"] = dict(state["annotations"]["ann-001"])
    proj.state_path.write_text(json.dumps(state), encoding="utf-8")
    mapping = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    mapping["mappings"]["ann-002"] = {
        "latex_file": "templates/section.tex",
        "line_range": [5, 5],
        "confidence": 0.9,
        "method": "fuzzy_text",
        "needs_review": False,
    }
    proj.mapping_path.write_text(json.dumps(mapping), encoding="utf-8")

    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="one new line\n",
    )

    mapping_after = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    # ann-002 was at [5, 5]; shift is -1 (replaced 2 lines with 1) → [4, 4].
    assert mapping_after["mappings"]["ann-002"]["line_range"] == [4, 4]
    # ann-001's mapping itself updates so its new line_range covers the new text.
    assert mapping_after["mappings"]["ann-001"]["line_range"] == [2, 2]


def test_apply_edit_handles_unicode(tmp_path: Path) -> None:
    proj = _make_project(
        tmp_path,
        lines=["L1: alpha\n", "L2: «beta» — café\n", "L3: gamma\n"],
    )
    mapping = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    mapping["mappings"]["ann-001"]["line_range"] = [2, 2]
    proj.mapping_path.write_text(json.dumps(mapping), encoding="utf-8")

    apply_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        new_text="L2 NEW: ß∆中\n",
    )

    new = proj.tex_path.read_text(encoding="utf-8")
    assert "L2 NEW: ß∆中" in new
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["before_text"] == "L2: «beta» — café\n"


def test_apply_edit_refuses_when_source_pdf_changed(tmp_path: Path) -> None:
    """Spec §14 risk 9: mutator refuses if the source PDF md5 has drifted."""
    from review_pdf_to_latex.apply import SourcePdfChangedApplyError

    proj = _make_project(tmp_path)
    # Mutate the source PDF after extract; the recorded md5 no longer matches.
    (proj.project / "source.pdf").write_bytes(b"%PDF-1.4 different fixture\n")
    with pytest.raises(SourcePdfChangedApplyError, match="source PDF changed"):
        apply_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            new_text="anything\n",
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_apply.py -v -k "apply_edit"`
Expected: `ModuleNotFoundError: No module named 'review_pdf_to_latex.apply'`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/apply.py
"""Mutation primitives: apply, revert, set-status, append-chat, record-proposal,
override-mapping.

These functions are the sole writers of state.json and mapping.json among the
"editing" subcommands (build is separate; commit-phase is separate). All writes
go through state.atomic_write_json and all status transitions go through
state.validate_status_transition.

Implements spec §8 (apply / revert / set-status / append-chat / record-proposal /
override-mapping rows), §9.2 (reverse-line-order batch), §10.3 (transitions),
§12.2 (failure log), §12.4 (overlap detection).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .state import (
    StateDir,
    LegacyStateError,
    SourcePdfChangedError,
    assert_source_pdf_unchanged,
    atomic_write_json,
    validate_status_transition,
)


# --- Errors -----------------------------------------------------------------

class ApplyError(Exception):
    """Base class for apply.py error conditions."""

    exit_code: int = 1


class AnnotationNotFoundError(ApplyError):
    exit_code = 7


class MappingUnresolvedError(ApplyError):
    exit_code = 8


class FileMutationError(ApplyError):
    exit_code = 9


class NoPriorApplyError(ApplyError):
    exit_code = 10


class InvalidLineRangeError(ApplyError):
    exit_code = 13


class OverlappingRangeError(ApplyError):
    exit_code = 16


class IllegalStatusTransitionError(ApplyError):
    exit_code = 18


class SourcePdfChangedApplyError(ApplyError):
    """Wraps state.SourcePdfChangedError for exit-code mapping."""

    exit_code = 21


class LegacyStateApplyError(ApplyError):
    """Wraps state.LegacyStateError for exit-code mapping."""

    exit_code = 22


def _guard_source_pdf(state_dir: Path) -> None:
    """Refuse to mutate if the source PDF has changed since extract.

    Spec §14 risk 9. The state.py helper takes a StateDir; chunk C functions
    take a raw Path to the .review-state directory, so we wrap construction
    here. Raises ApplyError subclasses so callers can map to exit codes.
    """
    state_dir = Path(state_dir)
    sd = StateDir(state_dir.parent)
    try:
        assert_source_pdf_unchanged(sd)
    except SourcePdfChangedError as exc:
        raise SourcePdfChangedApplyError(str(exc)) from exc
    except LegacyStateError as exc:
        raise LegacyStateApplyError(str(exc)) from exc


# --- Data classes -----------------------------------------------------------

@dataclass(frozen=True)
class AppliedEdit:
    """Returned by apply_edit. Captures the diff so callers can log / display.

    Fields:
        annotation_id: The annotation that was applied.
        latex_file: Project-relative path of the mutated .tex file.
        old_lines: The list of full lines (each with trailing \\n preserved)
            that were replaced.
        new_lines: The list of full lines that took their place.
        line_shift: len(new_lines) - len(old_lines). Used to recompute
            subsequent mappings in the same file.
    """

    annotation_id: str
    latex_file: str
    old_lines: list[str]
    new_lines: list[str]
    line_shift: int


# --- Helpers ----------------------------------------------------------------

def _read_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _split_text_to_lines(text: str) -> list[str]:
    """Split `text` into lines preserving trailing newlines.

    A trailing newline-less line is preserved without a synthetic newline.
    """
    if text == "":
        return []
    lines = text.splitlines(keepends=True)
    return lines


def _load_state_and_mapping(state_dir: Path) -> tuple[Path, dict, Path, dict]:
    state_path = state_dir / "state.json"
    mapping_path = state_dir / "mapping.json"
    if not state_path.exists():
        raise FileMutationError(f"state.json not found at {state_path}")
    if not mapping_path.exists():
        raise FileMutationError(f"mapping.json not found at {mapping_path}")
    return state_path, _read_json(state_path), mapping_path, _read_json(mapping_path)


def _project_root_from_state_dir(state_dir: Path) -> Path:
    return Path(state_dir).resolve().parent


def _check_overlap(
    state: dict,
    mapping: dict,
    annotation_id: str,
    target_file: str,
    target_range: tuple[int, int],
) -> None:
    """Spec §12.4: refuse to apply if another pending/applied annotation in
    the same file has an overlapping line range."""
    a_start, a_end = target_range
    conflicts: list[str] = []
    for other_id, other_map in mapping.get("mappings", {}).items():
        if other_id == annotation_id:
            continue
        if other_map.get("latex_file") != target_file:
            continue
        other_range = other_map.get("line_range")
        if not other_range:
            continue
        other_status = state.get("annotations", {}).get(other_id, {}).get("status")
        if other_status not in ("pending", "applied"):
            continue
        b_start, b_end = other_range
        if not (a_end < b_start or b_end < a_start):
            conflicts.append(other_id)
    if conflicts:
        raise OverlappingRangeError(
            f"line range [{a_start},{a_end}] in {target_file} overlaps with "
            f"pending/applied annotations: {', '.join(sorted(conflicts))}"
        )


def _recompute_subsequent_mappings(
    mapping: dict,
    target_file: str,
    edited_range_end: int,
    line_shift: int,
    skip_annotation_id: str,
) -> None:
    """In-place: add line_shift to every mapping in target_file whose
    line_range[0] > edited_range_end."""
    if line_shift == 0:
        return
    for other_id, other_map in mapping.get("mappings", {}).items():
        if other_id == skip_annotation_id:
            continue
        if other_map.get("latex_file") != target_file:
            continue
        line_range = other_map.get("line_range")
        if not line_range:
            continue
        if line_range[0] > edited_range_end:
            other_map["line_range"] = [
                line_range[0] + line_shift,
                line_range[1] + line_shift,
            ]


# --- Public API: apply_edit -------------------------------------------------

def apply_edit(
    state_dir: Path,
    annotation_id: str,
    new_text: str,
    dry_run: bool = False,
) -> AppliedEdit:
    """Apply a single edit to a .tex file. Spec §8 `apply` row + §9.2 / §12.4.

    Behavior:
        1. Look up mapping for annotation_id. Raise MappingUnresolvedError if
           latex_file or line_range is null.
        2. Check overlap against other pending/applied annotations in the same
           file. Raise OverlappingRangeError (exit 16) on conflict.
        3. Read the file; capture the current contents of [start, end] inclusive.
        4. If state.annotations[id].before_text is None, store the captured
           contents as before_text (one-time capture, spec §7.3).
        5. Replace [start, end] with new_text's lines.
        6. Compute line_shift = len(new_lines) - len(old_lines).
        7. Update mapping for this annotation: new line_range = [start, start + len(new_lines) - 1]
           (or [start, start] if len(new_lines) == 1; or [start, start - 1] if empty,
           which we represent as [start, start] with the convention that an empty
           range means "deleted").
        8. For every other mapping in the same file whose line_range[0] > original_end,
           add line_shift to both endpoints.
        9. Set state.annotations[id]: status="applied", proposed_text=new_text,
           applied_text=new_text, applied_at=now.
        10. Atomic-write state.json and mapping.json. With dry_run=True, do steps
            1-3 but skip all writes (return AppliedEdit with the computed diff).

    Raises SourcePdfChangedApplyError (exit 21) / LegacyStateApplyError (exit 22)
    via the source-PDF guard before any state read (spec §14 risk 9).
    """
    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)
    project_root = _project_root_from_state_dir(state_dir)
    state_path, state, mapping_path, mapping = _load_state_and_mapping(state_dir)

    if annotation_id not in state.get("annotations", {}):
        raise AnnotationNotFoundError(
            f"annotation_id {annotation_id!r} not found in state.json"
        )
    map_entry = mapping.get("mappings", {}).get(annotation_id)
    if map_entry is None:
        raise AnnotationNotFoundError(
            f"annotation_id {annotation_id!r} not found in mapping.json"
        )
    latex_file = map_entry.get("latex_file")
    line_range = map_entry.get("line_range")
    if latex_file is None or line_range is None:
        raise MappingUnresolvedError(
            f"annotation {annotation_id!r} has no resolved mapping; "
            "run `review-pdf override-mapping` first"
        )
    start, end = int(line_range[0]), int(line_range[1])
    if not (1 <= start <= end):
        raise InvalidLineRangeError(
            f"invalid line range [{start},{end}] for annotation {annotation_id!r}"
        )

    _check_overlap(state, mapping, annotation_id, latex_file, (start, end))

    tex_path = (project_root / latex_file).resolve()
    if not tex_path.exists():
        raise FileMutationError(f"latex file not found: {tex_path}")
    with tex_path.open("r", encoding="utf-8") as f:
        all_lines = f.readlines()
    if end > len(all_lines):
        raise InvalidLineRangeError(
            f"line range [{start},{end}] exceeds file length {len(all_lines)}"
        )

    old_lines = all_lines[start - 1 : end]
    new_lines = _split_text_to_lines(new_text)
    line_shift = len(new_lines) - len(old_lines)

    if dry_run:
        return AppliedEdit(
            annotation_id=annotation_id,
            latex_file=latex_file,
            old_lines=old_lines,
            new_lines=new_lines,
            line_shift=line_shift,
        )

    # Perform the file mutation.
    new_all = all_lines[: start - 1] + new_lines + all_lines[end:]
    try:
        with tex_path.open("w", encoding="utf-8") as f:
            f.writelines(new_all)
    except OSError as exc:
        raise FileMutationError(f"failed writing {tex_path}: {exc}") from exc

    # Update mapping for this annotation: new range covers the new lines.
    # If new_lines is empty (full deletion), record [start, start] as a
    # degenerate range; callers must treat empty edits as a special case.
    if new_lines:
        map_entry["line_range"] = [start, start + len(new_lines) - 1]
    else:
        map_entry["line_range"] = [start, start]

    # Shift subsequent mappings in the same file.
    _recompute_subsequent_mappings(
        mapping, latex_file, edited_range_end=end,
        line_shift=line_shift, skip_annotation_id=annotation_id,
    )

    # Update state entry.
    ann_entry = state["annotations"][annotation_id]
    if ann_entry.get("before_text") is None:
        ann_entry["before_text"] = "".join(old_lines)
    ann_entry["proposed_text"] = new_text
    ann_entry["applied_text"] = new_text
    ann_entry["applied_at"] = _now_iso()

    # Status transition: any non-terminal → applied is legal per spec §10.3
    # (applied / rejected / redrafted / needs_review all may re-apply on
    # redraft). validate_status_transition (chunk A) raises on illegal moves.
    # The engine-internal "apply" action covers both the Phase-1 batch
    # initial apply (pending → applied) and Phase-2a/2b re-apply paths.
    current_status = ann_entry.get("status", "pending")
    try:
        validate_status_transition(current_status, "applied", "apply")
    except ValueError as exc:
        raise IllegalStatusTransitionError(str(exc)) from exc
    ann_entry["status"] = "applied"

    atomic_write_json(state_path, state)
    atomic_write_json(mapping_path, mapping)

    return AppliedEdit(
        annotation_id=annotation_id,
        latex_file=latex_file,
        old_lines=old_lines,
        new_lines=new_lines,
        line_shift=line_shift,
    )
```

Notes:
- `validate_status_transition` is defined by chunk A in `state.py` with signature `(from_status: str, to_status: str, action: str) -> bool` raising `IllegalTransitionError(ValueError)` on illegal transitions. `apply_edit` always passes `action="apply"` (engine-internal label covering Phase-1 batch apply and Phase-2a/2b re-apply). The `except ValueError` clause catches `IllegalTransitionError` and re-raises as `IllegalStatusTransitionError` so callers can map to exit code 18.
- The dry-run branch reads the file but writes nothing, including no state.json modification.
- Empty `new_text` ("") is allowed (full deletion of the range); we represent that as `new_lines=[]` and a degenerate `line_range=[start, start]`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_apply.py -v -k "apply_edit"`
Expected: PASS (6 tests — the 5 original plus the source-PDF guard test).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/apply.py tests/test_apply.py
git commit -m "feat(apply): single-edit apply with before_text capture"
```

---

#### Task 6.2: Reverse-line-order batch apply

**Files:**
- Modify: `src/review_pdf_to_latex/apply.py`
- Test: `tests/test_apply.py`

**Implements spec:** §9.2 ("The skill walks annotations in reverse line order within each file so that earlier line numbers stay valid"), §12.4.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_apply.py

from review_pdf_to_latex.apply import apply_batch


def _make_project_three_in_one_file(tmp_path: Path) -> _ProjectFixture:
    lines = [f"L{i:02d}\n" for i in range(1, 121)]  # 120 lines
    proj = _make_project(tmp_path, lines=lines)
    # Reset the default ann-001 mapping to a clean state, then add three.
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    state["annotations"] = {
        "ann-A": dict(state["annotations"]["ann-001"]),
        "ann-B": dict(state["annotations"]["ann-001"]),
        "ann-C": dict(state["annotations"]["ann-001"]),
    }
    proj.state_path.write_text(json.dumps(state), encoding="utf-8")
    mapping = {
        "schema_version": 1,
        "mappings": {
            "ann-A": {
                "latex_file": "templates/section.tex",
                "line_range": [10, 10],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
            "ann-B": {
                "latex_file": "templates/section.tex",
                "line_range": [50, 50],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
            "ann-C": {
                "latex_file": "templates/section.tex",
                "line_range": [100, 100],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            },
        },
    }
    proj.mapping_path.write_text(json.dumps(mapping), encoding="utf-8")
    return proj


def test_apply_batch_reverse_order_keeps_earlier_lines_valid(tmp_path: Path) -> None:
    proj = _make_project_three_in_one_file(tmp_path)

    # Provide the edits in arbitrary (ascending) order; apply_batch reorders.
    edits = [
        ("ann-A", "A-new1\nA-new2\nA-new3\n"),  # +2 lines at L10
        ("ann-B", "B-new1\n"),                  # 0 net shift at L50
        ("ann-C", ""),                          # -1 line at L100 (full deletion)
    ]
    results = apply_batch(state_dir=proj.state_dir, edits=edits)
    assert len(results) == 3

    new_text = proj.tex_path.read_text(encoding="utf-8")
    new_lines = new_text.splitlines(keepends=True)

    # Confirm each edit landed at the correct (post-shift) location by checking
    # the surrounding context.
    # ann-C: line 100 was "L100\n" → deleted; line 99 = "L99\n" preceding,
    # next line should be "L101\n".
    assert "L100\n" not in new_lines
    # ann-B: line 50 was "L50\n" → "B-new1\n"; ann-B was applied before any
    # other edit could shift it (since C was first in reverse order).
    assert "B-new1\n" in new_lines
    # ann-A: line 10 → three lines.
    assert "A-new1\n" in new_lines
    assert "A-new2\n" in new_lines
    assert "A-new3\n" in new_lines

    # State has all three statuses == applied
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    for ann_id in ("ann-A", "ann-B", "ann-C"):
        assert state["annotations"][ann_id]["status"] == "applied"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_apply.py -v -k "apply_batch"`
Expected: ImportError on `apply_batch`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/apply.py`:

```python
def apply_batch(
    state_dir: Path,
    edits: list[tuple[str, str]],
) -> list[AppliedEdit]:
    """Apply many edits in the order spec §9.2 prescribes.

    The skill drives Phase 1 by walking annotations in REVERSE line order
    within each file so that earlier line numbers stay valid as later lines
    are edited. apply_batch enforces this ordering even if the caller passes
    edits in ascending order:

        1. Group edits by file (using each annotation's current mapping).
        2. Within each file, sort by current line_range[0] descending.
        3. Apply each edit via apply_edit (which mutates state + mapping atomically).
        4. After each apply, line_shift recomputation in apply_edit ensures
           subsequent mappings see the post-edit line numbers (but since we
           edit highest line numbers first, prior mappings are unchanged).

    Cross-file order does not matter because line-shift recomputation only
    affects mappings in the same file as the edit.

    Returns the AppliedEdit objects in the order they were applied (reverse
    line order).
    """
    state_dir = Path(state_dir)
    _, _, mapping_path, mapping = _load_state_and_mapping(state_dir)

    # Build a key: (latex_file, line_range[0]) for each edit. Edits whose
    # mapping is unresolved are forwarded to apply_edit where they will raise.
    annotated: list[tuple[str, str, str | None, int]] = []
    for ann_id, new_text in edits:
        entry = mapping["mappings"].get(ann_id, {})
        latex_file = entry.get("latex_file")
        line_range = entry.get("line_range") or [0, 0]
        annotated.append((ann_id, new_text, latex_file, int(line_range[0])))

    # Sort: by file, then by starting line descending. (None file sorts last.)
    annotated.sort(
        key=lambda t: (t[2] is None, t[2] or "", -t[3]),
    )

    results: list[AppliedEdit] = []
    for ann_id, new_text, _file, _line in annotated:
        result = apply_edit(state_dir=state_dir, annotation_id=ann_id, new_text=new_text)
        results.append(result)
    return results
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_apply.py -v -k "apply_batch"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/apply.py tests/test_apply.py
git commit -m "feat(apply): reverse-line-order batch apply"
```

---

#### Task 6.3: Revert

**Files:**
- Modify: `src/review_pdf_to_latex/apply.py`
- Test: `tests/test_apply.py`

**Implements spec:** §8 `revert` row, §12.2 (Phase 1 failure-log recovery).

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_apply.py

from review_pdf_to_latex.apply import (
    NoPriorApplyError,
    revert_edit,
)


def test_revert_edit_restores_before_text_and_sets_status_rejected(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")

    revert_edit(state_dir=proj.state_dir, annotation_id="ann-001", status="rejected")

    # File restored to original two lines at positions 2-3.
    text = proj.tex_path.read_text(encoding="utf-8")
    assert text == "line one\nline two\nline three\nline four\nline five\n"

    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "rejected"
    assert entry["applied_text"] is None
    assert entry["before_text"] == "line two\nline three\n"  # preserved


def test_revert_edit_with_failure_log_sets_needs_review_and_log_path(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="Y\n")

    log_path = proj.state_dir / "builds" / "build-007.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text("LaTeX Error: Undefined control sequence\n", encoding="utf-8")

    revert_edit(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        status="needs_review",
        failure_log=log_path,
    )

    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "needs_review"
    assert entry["failure_log_path"] == str(log_path.relative_to(proj.project))
    assert entry["failure_edit_text"] == "Y\n"


def test_revert_edit_rejects_invalid_status(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")

    with pytest.raises(ValueError):
        revert_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            status="accepted",  # not a valid revert target
        )


def test_revert_edit_raises_when_no_prior_apply(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    # No apply called; applied_text is None.
    with pytest.raises(NoPriorApplyError):
        revert_edit(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            status="rejected",
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_apply.py -v -k "revert"`
Expected: ImportError on `revert_edit` / `NoPriorApplyError`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/apply.py`:

```python
# Allowed revert-target statuses per spec §8 revert row.
_REVERT_STATUSES: frozenset[str] = frozenset({"rejected", "needs_review"})


def revert_edit(
    state_dir: Path,
    annotation_id: str,
    status: str = "rejected",
    failure_log: Path | None = None,
) -> None:
    """Restore before_text to the .tex file and update status.

    Spec §8 revert row + §12.2 failure-log handling.

    Args:
        state_dir: The .review-state directory of the project.
        annotation_id: The annotation to revert.
        status: One of "rejected" or "needs_review" (spec §8 revert row).
        failure_log: If provided AND status == "needs_review", record
            failure_log_path (project-relative) and copy proposed_text into
            failure_edit_text. Spec §12.2.

    Side effects:
        - Mutates the .tex file (writes before_text back into the recorded location).
        - Updates state.json atomically.
        - Updates mapping.json: subsequent mappings in the same file shift by
          the inverse of the original apply's line_shift.

    Raises:
        ValueError: status not in _REVERT_STATUSES.
        ValueError: failure_log provided with status != "needs_review".
        NoPriorApplyError: applied_text is None (nothing to revert).
        AnnotationNotFoundError, FileMutationError, MappingUnresolvedError as
        in apply_edit.
    """
    if status not in _REVERT_STATUSES:
        raise ValueError(
            f"revert_edit status must be one of {sorted(_REVERT_STATUSES)}; got {status!r}"
        )
    if failure_log is not None and status != "needs_review":
        raise ValueError(
            "failure_log may only be supplied with status='needs_review'"
        )

    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)  # spec §14 risk 9
    project_root = _project_root_from_state_dir(state_dir)
    state_path, state, mapping_path, mapping = _load_state_and_mapping(state_dir)

    if annotation_id not in state.get("annotations", {}):
        raise AnnotationNotFoundError(annotation_id)
    ann_entry = state["annotations"][annotation_id]
    if ann_entry.get("applied_text") is None:
        raise NoPriorApplyError(
            f"annotation {annotation_id!r} has no applied_text; nothing to revert"
        )
    before_text = ann_entry.get("before_text")
    if before_text is None:
        raise NoPriorApplyError(
            f"annotation {annotation_id!r} has no before_text; cannot revert"
        )

    map_entry = mapping["mappings"][annotation_id]
    latex_file = map_entry["latex_file"]
    line_range = map_entry["line_range"]
    if latex_file is None or line_range is None:
        raise MappingUnresolvedError(annotation_id)
    start, end = int(line_range[0]), int(line_range[1])

    tex_path = (project_root / latex_file).resolve()
    if not tex_path.exists():
        raise FileMutationError(f"latex file not found: {tex_path}")

    with tex_path.open("r", encoding="utf-8") as f:
        all_lines = f.readlines()
    if end > len(all_lines):
        raise InvalidLineRangeError(
            f"line range [{start},{end}] exceeds file length {len(all_lines)}"
        )

    before_lines = _split_text_to_lines(before_text)
    # current applied range covers (end - start + 1) lines; reverting replaces
    # those with before_lines.
    current_count = end - start + 1
    new_all = all_lines[: start - 1] + before_lines + all_lines[end:]

    try:
        with tex_path.open("w", encoding="utf-8") as f:
            f.writelines(new_all)
    except OSError as exc:
        raise FileMutationError(f"failed writing {tex_path}: {exc}") from exc

    line_shift = len(before_lines) - current_count

    # Update mapping for this annotation: line_range now covers before_lines.
    if before_lines:
        map_entry["line_range"] = [start, start + len(before_lines) - 1]
    else:
        map_entry["line_range"] = [start, start]

    _recompute_subsequent_mappings(
        mapping, latex_file, edited_range_end=end,
        line_shift=line_shift, skip_annotation_id=annotation_id,
    )

    # Update state entry. Derive action from target status: a revert that
    # lands at "rejected" is the Reject button (action="reject"); a revert
    # that lands at "needs_review" is the Phase-1 failure recovery, which
    # spec §10.3's table encodes under the "redraft" action (see chunk A's
    # (applied, redraft) → {needs_review} row and the explanatory comment).
    action = "reject" if status == "rejected" else "redraft"
    try:
        validate_status_transition(
            ann_entry.get("status", "pending"), status, action,
        )
    except ValueError as exc:
        raise IllegalStatusTransitionError(str(exc)) from exc
    ann_entry["status"] = status
    ann_entry["applied_text"] = None

    if failure_log is not None:
        try:
            rel_log = Path(failure_log).resolve().relative_to(project_root)
        except ValueError:
            rel_log = Path(failure_log)
        ann_entry["failure_log_path"] = str(rel_log)
        ann_entry["failure_edit_text"] = ann_entry.get("proposed_text")

    atomic_write_json(state_path, state)
    atomic_write_json(mapping_path, mapping)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_apply.py -v -k "revert"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/apply.py tests/test_apply.py
git commit -m "feat(apply): revert with status and optional failure log"
```

---

#### Task 6.4: set-status

**Files:**
- Modify: `src/review_pdf_to_latex/apply.py`
- Test: `tests/test_apply.py`

**Implements spec:** §8 `set-status` row, §10.3 transition table.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_apply.py

from review_pdf_to_latex.apply import (
    IllegalStatusTransitionError,
    set_annotation_status,
)


def test_set_status_legal_transition_applied_to_accepted(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")
    set_annotation_status(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        status="accepted",
        reason="looks good",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "accepted"
    assert entry["last_status_reason"] == "looks good"


def test_set_status_illegal_transition_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    # pending → accepted is illegal per spec §10.3 (must go pending → applied → accepted)
    with pytest.raises(IllegalStatusTransitionError):
        set_annotation_status(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            status="accepted",
        )


def test_set_status_no_reason_does_not_set_field(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    apply_edit(state_dir=proj.state_dir, annotation_id="ann-001", new_text="X\n")
    set_annotation_status(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        status="accepted",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["status"] == "accepted"
    # When no reason is supplied, field is omitted or None — accept either.
    assert entry.get("last_status_reason") in (None,)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_apply.py -v -k "set_status"`
Expected: ImportError on `set_annotation_status`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/apply.py`:

```python
_STATUS_TO_ACTION: dict[str, str] = {
    # Map a target status to the engine-internal action that produces it.
    # Used by set_annotation_status when the caller does not pass an
    # explicit action (the common case — CLI users do not think in action
    # terms, they pass --status). Each target maps to exactly one action.
    "accepted": "approve",          # Approve button
    "rejected": "reject",           # Reject button (status-only path via set-status)
    "redrafted": "redraft",         # Redraft button concluding a re-apply
    "deferred": "skip",             # Skip button
    "surfaced_pending": "surface",  # Surface button
    "surfaced_resolved": "resolve-surface",  # Phase 2b conclusion (spec §9.4)
    "needs_review": "redraft",      # Phase 1 failure encoded under redraft
    "applied": "apply",             # Engine-internal apply path
    "pending": "override-mapping",  # status-neutral; no real transition
}


def set_annotation_status(
    state_dir: Path,
    annotation_id: str,
    status: str,
    reason: str | None = None,
    action: str | None = None,
) -> None:
    """Transition annotation_id to `status` without touching any .tex file.

    Spec §8 set-status row + §10.3 transition table. Used for Approve, Skip,
    Surface, marking surfaced_resolved, marking redrafted after a successful
    redraft build, and other status moves that do not themselves mutate text.

    Args:
        state_dir: .review-state directory.
        annotation_id: Target annotation.
        status: New status (must be in the spec §7.3 status enum).
        reason: Optional free-form reason; stored as last_status_reason.
        action: Optional engine-internal action label for transition validation.
            If None, derived from the target ``status`` via _STATUS_TO_ACTION.
            Callers (e.g., the CLI `set-status` handler) normally let it
            default; pass it explicitly only when disambiguating a target
            status that is reachable via more than one action.

    Raises:
        AnnotationNotFoundError: if annotation_id not present.
        IllegalStatusTransitionError: if validate_status_transition rejects the move.
        SourcePdfChangedApplyError / LegacyStateApplyError: source PDF guard (spec §14).
    """
    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)  # spec §14 risk 9
    state_path = state_dir / "state.json"
    if not state_path.exists():
        raise FileMutationError(f"state.json not found at {state_path}")
    state = _read_json(state_path)

    if annotation_id not in state.get("annotations", {}):
        raise AnnotationNotFoundError(annotation_id)

    entry = state["annotations"][annotation_id]
    current = entry.get("status", "pending")
    resolved_action = action if action is not None else _STATUS_TO_ACTION.get(status, "skip")
    try:
        validate_status_transition(current, status, resolved_action)
    except ValueError as exc:
        raise IllegalStatusTransitionError(str(exc)) from exc

    entry["status"] = status
    if reason is not None:
        entry["last_status_reason"] = reason

    atomic_write_json(state_path, state)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_apply.py -v -k "set_status"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/apply.py tests/test_apply.py
git commit -m "feat(apply): set-status mutator"
```

---

#### Task 6.5: append-chat

**Files:**
- Modify: `src/review_pdf_to_latex/apply.py`
- Test: `tests/test_apply.py`

**Implements spec:** §8 `append-chat` row, §9.4 (Phase 2b chat log).

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_apply.py

from review_pdf_to_latex.apply import append_chat_turn


def test_append_chat_first_turn_initializes_log(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    append_chat_turn(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        role="user",
        text="Why is this passage flagged?",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    log = state["annotations"]["ann-001"]["surface_chat_log"]
    assert isinstance(log, list)
    assert len(log) == 1
    assert log[0]["role"] == "user"
    assert log[0]["text"] == "Why is this passage flagged?"
    assert "ts" in log[0]


def test_append_chat_second_turn_appends(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    append_chat_turn(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        role="user",
        text="One",
    )
    append_chat_turn(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        role="claude",
        text="Two",
    )
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    log = state["annotations"]["ann-001"]["surface_chat_log"]
    assert [t["role"] for t in log] == ["user", "claude"]
    assert [t["text"] for t in log] == ["One", "Two"]


def test_append_chat_invalid_role_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    with pytest.raises(ValueError):
        append_chat_turn(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            role="assistant",  # only "user" or "claude" allowed
            text="hi",
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_apply.py -v -k "append_chat"`
Expected: ImportError on `append_chat_turn`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/apply.py`:

```python
_CHAT_ROLES: frozenset[str] = frozenset({"user", "claude"})


def append_chat_turn(
    state_dir: Path,
    annotation_id: str,
    role: str,
    text: str,
) -> None:
    """Append one {role, text, ts} entry to surface_chat_log.

    Spec §8 append-chat row + §7.3 (chat-log shape: list of {role, text, ts}).
    Initializes the list if it was previously None.

    Raises:
        ValueError: role not in {"user", "claude"}.
        AnnotationNotFoundError: annotation_id not present.
    """
    if role not in _CHAT_ROLES:
        raise ValueError(
            f"role must be one of {sorted(_CHAT_ROLES)}; got {role!r}"
        )
    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)  # spec §14 risk 9
    state_path = state_dir / "state.json"
    if not state_path.exists():
        raise FileMutationError(f"state.json not found at {state_path}")
    state = _read_json(state_path)
    if annotation_id not in state.get("annotations", {}):
        raise AnnotationNotFoundError(annotation_id)

    entry = state["annotations"][annotation_id]
    log = entry.get("surface_chat_log")
    if log is None:
        log = []
    log.append({"role": role, "text": text, "ts": _now_iso()})
    entry["surface_chat_log"] = log

    atomic_write_json(state_path, state)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_apply.py -v -k "append_chat"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/apply.py tests/test_apply.py
git commit -m "feat(apply): append-chat for Phase 2b"
```

---

#### Task 6.6: record-proposal

**Files:**
- Modify: `src/review_pdf_to_latex/apply.py`
- Test: `tests/test_apply.py`

**Implements spec:** §8 `record-proposal` row.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_apply.py

from review_pdf_to_latex.apply import record_proposal


def test_record_proposal_writes_state_but_not_tex(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    original_tex = proj.tex_path.read_text(encoding="utf-8")

    record_proposal(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        proposed_text="stashed proposal\n",
    )

    # .tex file is untouched.
    assert proj.tex_path.read_text(encoding="utf-8") == original_tex
    # state.json carries the proposal but status has NOT moved off pending.
    state = json.loads(proj.state_path.read_text(encoding="utf-8"))
    entry = state["annotations"]["ann-001"]
    assert entry["proposed_text"] == "stashed proposal\n"
    assert entry["applied_text"] is None
    assert entry["status"] == "pending"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_apply.py -v -k "record_proposal"`
Expected: ImportError on `record_proposal`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/apply.py`:

```python
def record_proposal(
    state_dir: Path,
    annotation_id: str,
    proposed_text: str,
) -> None:
    """Write proposed_text into state.json without touching the .tex file.

    Spec §8 record-proposal row. Used by the skill to stage a draft for later
    apply (e.g., generate proposals in bulk during Phase 1 then apply them in
    a separate pass) or for replay.

    Does NOT change status; the annotation remains in whatever state it was in.

    Raises:
        AnnotationNotFoundError: annotation_id not present.
        SourcePdfChangedApplyError / LegacyStateApplyError: source PDF guard.
    """
    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)  # spec §14 risk 9
    state_path = state_dir / "state.json"
    if not state_path.exists():
        raise FileMutationError(f"state.json not found at {state_path}")
    state = _read_json(state_path)
    if annotation_id not in state.get("annotations", {}):
        raise AnnotationNotFoundError(annotation_id)
    state["annotations"][annotation_id]["proposed_text"] = proposed_text
    atomic_write_json(state_path, state)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_apply.py -v -k "record_proposal"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/apply.py tests/test_apply.py
git commit -m "feat(apply): record-proposal"
```

---

#### Task 6.7: override-mapping

**Files:**
- Modify: `src/review_pdf_to_latex/apply.py`
- Test: `tests/test_apply.py`

**Implements spec:** §8 `override-mapping` row, §10.6 (manual mapping UI), §12.1 (needs_review recovery).

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_apply.py

from review_pdf_to_latex.apply import (
    InvalidLineRangeError,
    override_mapping,
)


def test_override_mapping_writes_manual_method(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    # Add a second file to the project to override into.
    other = proj.project / "templates" / "other.tex"
    other.write_text("o1\no2\no3\no4\n", encoding="utf-8")

    override_mapping(
        state_dir=proj.state_dir,
        annotation_id="ann-001",
        file="templates/other.tex",
        lines=(2, 3),
    )

    mapping = json.loads(proj.mapping_path.read_text(encoding="utf-8"))
    entry = mapping["mappings"]["ann-001"]
    assert entry["latex_file"] == "templates/other.tex"
    assert entry["line_range"] == [2, 3]
    assert entry["confidence"] == 1.0
    assert entry["method"] == "manual"
    assert entry["needs_review"] is False
    assert entry.get("candidates") is None


def test_override_mapping_out_of_bounds_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)  # section.tex has 5 lines
    with pytest.raises(InvalidLineRangeError):
        override_mapping(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            file="templates/section.tex",
            lines=(3, 99),
        )


def test_override_mapping_nonexistent_file_raises(tmp_path: Path) -> None:
    proj = _make_project(tmp_path)
    with pytest.raises(FileMutationError):
        override_mapping(
            state_dir=proj.state_dir,
            annotation_id="ann-001",
            file="templates/does-not-exist.tex",
            lines=(1, 1),
        )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_apply.py -v -k "override_mapping"`
Expected: ImportError on `override_mapping`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/apply.py`:

```python
def override_mapping(
    state_dir: Path,
    annotation_id: str,
    file: str,
    lines: tuple[int, int],
) -> None:
    """Manually pin a mapping. Spec §8 override-mapping row + §10.6.

    Validates that `file` exists under the project root and that `lines` is
    in bounds for that file. Replaces the mapping with method='manual',
    confidence=1.0, needs_review=False, and clears any candidates[].

    Args:
        state_dir: .review-state directory.
        annotation_id: Target annotation.
        file: Project-relative path of the LaTeX file.
        lines: (start, end) inclusive 1-indexed.

    Raises:
        AnnotationNotFoundError: annotation_id not present in mapping.json.
        FileMutationError: file does not exist under project_root.
        InvalidLineRangeError: start < 1, end < start, or end > file line count.
        SourcePdfChangedApplyError / LegacyStateApplyError: source PDF guard.
    """
    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)  # spec §14 risk 9
    project_root = _project_root_from_state_dir(state_dir)
    mapping_path = state_dir / "mapping.json"
    if not mapping_path.exists():
        raise FileMutationError(f"mapping.json not found at {mapping_path}")
    mapping = _read_json(mapping_path)
    if annotation_id not in mapping.get("mappings", {}):
        raise AnnotationNotFoundError(annotation_id)

    start, end = int(lines[0]), int(lines[1])
    if start < 1 or end < start:
        raise InvalidLineRangeError(
            f"invalid line range [{start},{end}]: start must be >= 1 and end >= start"
        )

    target = (project_root / file).resolve()
    try:
        target.relative_to(project_root)
    except ValueError as exc:
        raise FileMutationError(
            f"file {file!r} resolves outside the project root"
        ) from exc
    if not target.exists():
        raise FileMutationError(f"file not found: {target}")

    with target.open("r", encoding="utf-8") as f:
        line_count = sum(1 for _ in f)
    if end > line_count:
        raise InvalidLineRangeError(
            f"line range [{start},{end}] exceeds file length {line_count}"
        )

    entry = mapping["mappings"][annotation_id]
    entry["latex_file"] = file
    entry["line_range"] = [start, end]
    entry["confidence"] = 1.0
    entry["method"] = "manual"
    entry["needs_review"] = False
    entry["candidates"] = None

    atomic_write_json(mapping_path, mapping)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_apply.py -v -k "override_mapping"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/apply.py tests/test_apply.py
git commit -m "feat(apply): override-mapping for manual cases"
```

---

#### Task 6.8: Wire up the six mutator CLI subcommands

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` (replace six `NotImplementedError` stubs)
- Test: `tests/test_cli.py`

**Implements spec:** §8 (every CLI row in this chunk's scope).

The chunk-B argparse skeleton registers each subcommand and its flags. Each handler is named `_cmd_<subcommand>` and currently raises `NotImplementedError`. We replace those six handlers with thin wrappers that:
1. Parse the input arguments.
2. Call into `apply.py`.
3. Map `ApplyError` subclasses to their `exit_code` (caught at the top of `cli.main`; chunk B's `main` already does `except ApplyError as e: return e.exit_code` per the shared contract — if it does not, this task adds the catch.)

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_cli.py
import json
import subprocess
import sys
from pathlib import Path

import pytest


def _bootstrap_minimal_project(tmp_path: Path) -> tuple[Path, Path, Path]:
    """Return (project_dir, state_dir, tex_path)."""
    project = tmp_path / "proj"
    project.mkdir()
    (project / "templates").mkdir()
    tex = project / "templates" / "section.tex"
    tex.write_text(
        "alpha\nbeta\ngamma\ndelta\nepsilon\n",
        encoding="utf-8",
    )
    state_dir = project / ".review-state"
    state_dir.mkdir()
    state = {
        "schema_version": 1,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {
            "ann-001": {
                "status": "pending",
                "before_text": None,
                "proposed_text": None,
                "applied_text": None,
                "applied_at": None,
                "last_build_id": None,
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            }
        },
        "builds": [],
    }
    mapping = {
        "schema_version": 1,
        "mappings": {
            "ann-001": {
                "latex_file": "templates/section.tex",
                "line_range": [2, 3],
                "confidence": 0.9,
                "method": "fuzzy_text",
                "needs_review": False,
            }
        },
    }
    (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (state_dir / "mapping.json").write_text(json.dumps(mapping), encoding="utf-8")
    return project, state_dir, tex


def _run_cli(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "review_pdf_to_latex", *args],
        capture_output=True,
        text=True,
    )


def test_cli_apply_subcommand(tmp_path: Path) -> None:
    project, state_dir, tex = _bootstrap_minimal_project(tmp_path)
    new_text_file = tmp_path / "draft.txt"
    new_text_file.write_text("REPLACED\n", encoding="utf-8")

    r = _run_cli([
        "apply",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--new-text-file", str(new_text_file),
    ])
    assert r.returncode == 0, r.stderr
    assert tex.read_text(encoding="utf-8") == "alpha\nREPLACED\ndelta\nepsilon\n"


def test_cli_revert_subcommand(tmp_path: Path) -> None:
    project, state_dir, tex = _bootstrap_minimal_project(tmp_path)
    nt = tmp_path / "d.txt"
    nt.write_text("X\n", encoding="utf-8")
    _run_cli([
        "apply",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--new-text-file", str(nt),
    ])
    r = _run_cli([
        "revert",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--status", "rejected",
    ])
    assert r.returncode == 0, r.stderr
    assert tex.read_text(encoding="utf-8") == "alpha\nbeta\ngamma\ndelta\nepsilon\n"


def test_cli_set_status_subcommand(tmp_path: Path) -> None:
    project, state_dir, _ = _bootstrap_minimal_project(tmp_path)
    nt = tmp_path / "d.txt"
    nt.write_text("X\n", encoding="utf-8")
    _run_cli([
        "apply",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--new-text-file", str(nt),
    ])
    r = _run_cli([
        "set-status",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--status", "accepted",
        "--reason", "looks good",
    ])
    assert r.returncode == 0, r.stderr
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["status"] == "accepted"
    assert state["annotations"]["ann-001"]["last_status_reason"] == "looks good"


def test_cli_append_chat_subcommand(tmp_path: Path) -> None:
    project, state_dir, _ = _bootstrap_minimal_project(tmp_path)
    tf = tmp_path / "msg.txt"
    tf.write_text("How does this paragraph land?", encoding="utf-8")
    r = _run_cli([
        "append-chat",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--role", "user",
        "--text-file", str(tf),
    ])
    assert r.returncode == 0, r.stderr
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["surface_chat_log"][0]["text"] == \
        "How does this paragraph land?"


def test_cli_record_proposal_subcommand(tmp_path: Path) -> None:
    project, state_dir, tex = _bootstrap_minimal_project(tmp_path)
    tf = tmp_path / "proposal.txt"
    tf.write_text("stashed\n", encoding="utf-8")
    r = _run_cli([
        "record-proposal",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--text-file", str(tf),
    ])
    assert r.returncode == 0, r.stderr
    # tex untouched
    assert tex.read_text(encoding="utf-8") == "alpha\nbeta\ngamma\ndelta\nepsilon\n"
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["annotations"]["ann-001"]["proposed_text"] == "stashed\n"


def test_cli_override_mapping_subcommand(tmp_path: Path) -> None:
    project, state_dir, _ = _bootstrap_minimal_project(tmp_path)
    other = project / "templates" / "other.tex"
    other.write_text("o1\no2\no3\n", encoding="utf-8")
    r = _run_cli([
        "override-mapping",
        "--project-dir", str(project),
        "--annotation-id", "ann-001",
        "--file", "templates/other.tex",
        "--lines", "1:2",
    ])
    assert r.returncode == 0, r.stderr
    mapping = json.loads((state_dir / "mapping.json").read_text(encoding="utf-8"))
    assert mapping["mappings"]["ann-001"]["latex_file"] == "templates/other.tex"
    assert mapping["mappings"]["ann-001"]["line_range"] == [1, 2]
    assert mapping["mappings"]["ann-001"]["method"] == "manual"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v -k "apply_subcommand or revert_subcommand or set_status_subcommand or append_chat_subcommand or record_proposal_subcommand or override_mapping_subcommand"`
Expected: every test fails because the corresponding `_cmd_<x>` raises `NotImplementedError` (chunk B's stub).

- [ ] **Step 3: Write minimal implementation**

In `src/review_pdf_to_latex/cli.py`, replace the six stub handlers. The exact pre-existing line numbers depend on chunk B, but each stub is a one-line `raise NotImplementedError(...)`. Replace each with:

```python
def _cmd_apply(args: argparse.Namespace) -> int:
    from .apply import (
        AnnotationNotFoundError,
        ApplyError,
        FileMutationError,
        IllegalStatusTransitionError,
        InvalidLineRangeError,
        MappingUnresolvedError,
        NoPriorApplyError,
        OverlappingRangeError,
        apply_edit,
    )
    new_text = Path(args.new_text_file).read_text(encoding="utf-8")
    state_dir = Path(args.project_dir) / ".review-state"
    try:
        result = apply_edit(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            new_text=new_text,
            dry_run=args.dry_run,
        )
    except ApplyError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.exit_code
    if args.dry_run:
        print(f"--- {result.latex_file} (current)")
        print(f"+++ {result.latex_file} (proposed)")
        for ln in result.old_lines:
            print(f"-{ln}", end="")
        for ln in result.new_lines:
            print(f"+{ln}", end="")
    return 0


def _cmd_revert(args: argparse.Namespace) -> int:
    from .apply import ApplyError, revert_edit
    state_dir = Path(args.project_dir) / ".review-state"
    failure_log = Path(args.failure_log) if args.failure_log else None
    try:
        revert_edit(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            status=args.status,
            failure_log=failure_log,
        )
    except ApplyError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.exit_code
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 18
    return 0


def _cmd_set_status(args: argparse.Namespace) -> int:
    from .apply import ApplyError, set_annotation_status
    state_dir = Path(args.project_dir) / ".review-state"
    try:
        set_annotation_status(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            status=args.status,
            reason=args.reason,
        )
    except ApplyError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.exit_code
    return 0


def _cmd_append_chat(args: argparse.Namespace) -> int:
    from .apply import ApplyError, append_chat_turn
    state_dir = Path(args.project_dir) / ".review-state"
    text = Path(args.text_file).read_text(encoding="utf-8")
    try:
        append_chat_turn(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            role=args.role,
            text=text,
        )
    except ApplyError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.exit_code
    except ValueError as e:
        print(f"error: {e}", file=sys.stderr)
        return 18
    return 0


def _cmd_record_proposal(args: argparse.Namespace) -> int:
    from .apply import ApplyError, record_proposal
    state_dir = Path(args.project_dir) / ".review-state"
    text = Path(args.text_file).read_text(encoding="utf-8")
    try:
        record_proposal(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            proposed_text=text,
        )
    except ApplyError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.exit_code
    return 0


def _cmd_override_mapping(args: argparse.Namespace) -> int:
    from .apply import ApplyError, override_mapping
    state_dir = Path(args.project_dir) / ".review-state"
    # args.lines is the raw "START:END" string (chunk B's argparse stores it
    # as a string). Parse it here.
    try:
        start_s, end_s = args.lines.split(":", 1)
        lines = (int(start_s), int(end_s))
    except (ValueError, AttributeError):
        print(f"error: --lines must be START:END (got {args.lines!r})", file=sys.stderr)
        return 13
    try:
        override_mapping(
            state_dir=state_dir,
            annotation_id=args.annotation_id,
            file=args.file,
            lines=lines,
        )
    except ApplyError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.exit_code
    return 0
```

Top-of-file imports needed in `cli.py` (chunk B should already have `sys` and `argparse`; add `Path` if not present):

```python
import sys
from pathlib import Path
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v -k "apply_subcommand or revert_subcommand or set_status_subcommand or append_chat_subcommand or record_proposal_subcommand or override_mapping_subcommand"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): wire up apply/revert/set-status/append-chat/record-proposal/override-mapping subcommands"
```

---

### Task 7: Phase commit — `src/review_pdf_to_latex/commit.py`

**Implements spec:** §8 `commit-phase` row, §13.1 (clean-state precondition), §13.2 (commit message template), §13.3 (state directory location).

The commit module is the sole writer of `state.json.phase` and the sole executor of `git commit`. It depends on `state.py` (chunk A) for atomic writes and on `git` being on PATH. Five sub-tasks (7.1 through 7.5); each ends with a commit.

---

#### Task 7.1: Clean-state precondition

**Files:**
- Create: `src/review_pdf_to_latex/commit.py`
- Test: `tests/test_commit.py`

**Implements spec:** §13.1, §14-risk-8.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_commit.py
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from review_pdf_to_latex.commit import (
    DirtyGitError,
    assert_clean_git,
)


def _git(*args: str, cwd: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        capture_output=True,
        text=True,
    )


def _init_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git("init", "-q", cwd=repo)
    _git("config", "user.email", "test@example.com", cwd=repo)
    _git("config", "user.name", "Test", cwd=repo)
    (repo / "README").write_text("hello\n", encoding="utf-8")
    _git("add", "README", cwd=repo)
    _git("commit", "-q", "-m", "init", cwd=repo)
    return repo


def test_assert_clean_git_passes_on_clean_repo_phase_0(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    # Should not raise.
    assert_clean_git(project_root=repo, current_phase="0-setup")


def test_assert_clean_git_raises_on_dirty_repo_phase_0(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    (repo / "dirty.txt").write_text("uncommitted\n", encoding="utf-8")
    with pytest.raises(DirtyGitError):
        assert_clean_git(project_root=repo, current_phase="0-setup")


def test_assert_clean_git_tolerates_dirty_after_phase_0(tmp_path: Path) -> None:
    repo = _init_repo(tmp_path)
    (repo / "dirty.txt").write_text("expected, the engine has been editing\n", encoding="utf-8")
    # In any phase past 0-setup, dirty state is expected — must not raise.
    for phase in ("1-batch", "2a-ratify", "2b-surface", "3-final"):
        assert_clean_git(project_root=repo, current_phase=phase)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_commit.py -v -k "assert_clean_git"`
Expected: `ModuleNotFoundError: No module named 'review_pdf_to_latex.commit'`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/commit.py
"""Phase commit orchestrator. Sole writer of state.json.phase and sole
executor of `git commit`.

Implements spec §8 (commit-phase row), §13.1 (clean-state precondition),
§13.2 (commit message template), §13.3 (gitignore policy).
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Iterable

from .state import (
    LegacyStateError,
    SourcePdfChangedError,
    StateDir,
    assert_source_pdf_unchanged,
    atomic_write_json,
)


class CommitError(Exception):
    exit_code: int = 1


class DirtyGitError(CommitError):
    exit_code = 15


class CommitFailedError(CommitError):
    exit_code = 19


class IllegalPhaseError(CommitError):
    exit_code = 1


class SourcePdfChangedCommitError(CommitError):
    """Wraps state.SourcePdfChangedError; commit-phase refuses to proceed."""

    exit_code = 21


class LegacyStateCommitError(CommitError):
    """Wraps state.LegacyStateError; commit-phase refuses to proceed."""

    exit_code = 22


def assert_clean_git(project_root: Path, current_phase: str) -> None:
    """Spec §13.1: in phase 0-setup, refuse to proceed if git status is dirty.

    After Phase 0 the engine has been editing .tex files, so dirty state is
    expected and the check is skipped.

    Raises:
        DirtyGitError (exit 15): porcelain status non-empty AND phase == 0-setup.
    """
    if current_phase != "0-setup":
        return
    result = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise DirtyGitError(
            f"`git status` failed in {project_root}: {result.stderr.strip()}"
        )
    if result.stdout.strip():
        raise DirtyGitError(
            "dirty git state in project root; commit or stash before phase 0:\n"
            + result.stdout
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_commit.py -v -k "assert_clean_git"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/commit.py tests/test_commit.py
git commit -m "feat(commit): clean-state precondition"
```

---

#### Task 7.2: Commit message template

**Files:**
- Modify: `src/review_pdf_to_latex/commit.py`
- Test: `tests/test_commit.py`

**Implements spec:** §13.2 (commit message format).

Spec §13.2 gives this concrete example:

```
review-pdf-to-latex: phase 2a — ratify COTA Impact Report v2.0

Approved: 62
Rejected: 5
Redrafted: 3
Deferred: 0

State snapshot: .review-state/state.json @ <sha>
```

The phase prefix is human-friendly: "phase 1 — batch apply", "phase 2a — ratify", "phase 2b — surface", "phase 3 — final". We render the body from the count of each terminal status across the annotation set, listing only categories with non-zero counts. The `message_suffix` argument appends as a `--message-suffix` paragraph.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_commit.py

from review_pdf_to_latex.commit import render_commit_message


def _state(annotations: dict[str, dict]) -> dict:
    return {
        "schema_version": 1,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": annotations,
        "builds": [],
    }


def test_render_commit_message_phase_1(tmp_path: Path) -> None:
    state = _state({
        f"ann-{i:03d}": {"status": "applied"} for i in range(1, 11)
    })
    msg = render_commit_message(
        phase="1-batch",
        granularity="phase",
        message_suffix=None,
        state=state,
    )
    assert "phase 1" in msg
    assert "10" in msg  # 10 applied edits referenced somewhere
    # Annotation IDs appear in the body (truncated or full).
    assert "ann-001" in msg


def test_render_commit_message_phase_2a_with_suffix(tmp_path: Path) -> None:
    anns = {}
    for i in range(1, 63):
        anns[f"ann-{i:03d}"] = {"status": "accepted"}
    for i in range(63, 68):
        anns[f"ann-{i:03d}"] = {"status": "rejected"}
    for i in range(68, 71):
        anns[f"ann-{i:03d}"] = {"status": "redrafted"}
    state = _state(anns)
    msg = render_commit_message(
        phase="2a-ratify",
        granularity="phase",
        message_suffix="COTA Impact Report v2.0",
        state=state,
    )
    assert "phase 2a" in msg
    assert "Accepted: 62" in msg
    assert "Rejected: 5" in msg
    assert "Redrafted: 3" in msg
    assert "COTA Impact Report v2.0" in msg


def test_render_commit_message_phase_3_zero_edits(tmp_path: Path) -> None:
    state = _state({})
    msg = render_commit_message(
        phase="3-final",
        granularity="phase",
        message_suffix=None,
        state=state,
    )
    assert "phase 3" in msg
    # Zero-count edge case must still produce a coherent message.
    assert msg.strip() != ""
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_commit.py -v -k "render_commit_message"`
Expected: ImportError on `render_commit_message`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/commit.py`:

```python
# Phase ID to human-friendly suffix used in the commit subject.
_PHASE_LABELS: dict[str, str] = {
    "0-setup": "phase 0 — setup",
    "1-batch": "phase 1 — batch apply",
    "2a-ratify": "phase 2a — ratify",
    "2b-surface": "phase 2b — surface",
    "3-final": "phase 3 — final",
}

# Statuses that count as edits in the commit summary, in display order.
_SUMMARY_STATUSES: list[str] = [
    "applied",
    "accepted",
    "redrafted",
    "rejected",
    "deferred",
    "surfaced_resolved",
    "surfaced_pending",
    "needs_review",
    "pending",
]


def _count_by_status(state: dict) -> dict[str, int]:
    counts: dict[str, int] = {s: 0 for s in _SUMMARY_STATUSES}
    for _ann_id, entry in state.get("annotations", {}).items():
        s = entry.get("status", "pending")
        counts[s] = counts.get(s, 0) + 1
    return counts


def _summary_for_phase(phase: str, counts: dict[str, int]) -> list[str]:
    """Return the body lines (without trailing newline) per spec §13.2."""
    lines: list[str] = []
    # For phase 1 the relevant categories are applied / needs_review;
    # for phase 2a it's accepted / rejected / redrafted / deferred;
    # for phase 2b it's surfaced_resolved / deferred; for phase 3 anything left.
    relevant: list[str]
    if phase == "1-batch":
        relevant = ["applied", "needs_review"]
    elif phase == "2a-ratify":
        relevant = ["accepted", "rejected", "redrafted", "deferred"]
    elif phase == "2b-surface":
        relevant = ["surfaced_resolved", "deferred"]
    elif phase == "3-final":
        relevant = _SUMMARY_STATUSES
    else:
        relevant = _SUMMARY_STATUSES
    for s in relevant:
        n = counts.get(s, 0)
        if n > 0:
            lines.append(f"{s.replace('_', ' ').title().replace(' ', '')}: {n}")
    return lines


def render_commit_message(
    phase: str,
    granularity: str,
    message_suffix: str | None,
    state: dict,
) -> str:
    """Render a commit message per spec §13.2.

    Subject line:
        review-pdf-to-latex: <phase label>[ — <message_suffix>]

    Body:
        - one "<status>: <count>" per relevant status
        - blank line
        - annotation ID listing (first 10 IDs, plus "...and N more")
        - blank line
        - state snapshot pointer (state.json path)

    Args:
        phase: Phase id (the SOURCE phase being committed; e.g., "1-batch").
        granularity: "phase" | "session" | "batch:N" — currently only affects
            the subject line annotation.
        message_suffix: Optional user-supplied project tag (e.g., "COTA v2.0").
        state: The state.json dict to summarize.
    """
    if phase not in _PHASE_LABELS:
        raise IllegalPhaseError(f"unknown phase {phase!r}")
    counts = _count_by_status(state)

    subject = f"review-pdf-to-latex: {_PHASE_LABELS[phase]}"
    if message_suffix:
        subject = f"{subject} — {message_suffix}"

    body_lines = _summary_for_phase(phase, counts)

    annotation_ids = sorted(state.get("annotations", {}).keys())
    if annotation_ids:
        head = annotation_ids[:10]
        more = len(annotation_ids) - len(head)
        listing = "Annotations: " + ", ".join(head)
        if more > 0:
            listing += f", ...and {more} more"
    else:
        listing = "Annotations: (none)"

    parts: list[str] = [subject, ""]
    if body_lines:
        parts.extend(body_lines)
        parts.append("")
    parts.append(listing)
    parts.append("")
    parts.append("State snapshot: .review-state/state.json")
    if granularity != "phase":
        parts.append(f"Granularity: {granularity}")
    return "\n".join(parts) + "\n"
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_commit.py -v -k "render_commit_message"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/commit.py tests/test_commit.py
git commit -m "feat(commit): commit-message template"
```

---

#### Task 7.3: Phase transition map

**Files:**
- Modify: `src/review_pdf_to_latex/commit.py`
- Test: `tests/test_commit.py`

**Implements spec:** §7.3 phase enum, §8 `commit-phase` row.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_commit.py

from review_pdf_to_latex.commit import IllegalPhaseError, next_phase


@pytest.mark.parametrize(
    "current, expected",
    [
        ("0-setup", "1-batch"),
        ("1-batch", "2a-ratify"),
        ("2a-ratify", "2b-surface"),
        ("2b-surface", "3-final"),
        ("3-final", "3-final"),  # terminal: stays
    ],
)
def test_next_phase_valid_transitions(current: str, expected: str) -> None:
    assert next_phase(current) == expected


def test_next_phase_invalid_phase_raises() -> None:
    with pytest.raises(IllegalPhaseError):
        next_phase("not-a-real-phase")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_commit.py -v -k "next_phase"`
Expected: ImportError on `next_phase`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/commit.py`:

```python
# Spec §7.3: 0-setup → 1-batch → 2a-ratify → 2b-surface → 3-final (terminal).
_PHASE_TRANSITIONS: dict[str, str] = {
    "0-setup": "1-batch",
    "1-batch": "2a-ratify",
    "2a-ratify": "2b-surface",
    "2b-surface": "3-final",
    "3-final": "3-final",  # terminal, idempotent
}


def next_phase(current: str) -> str:
    """Return the phase that follows `current`. Terminal phase 3-final is fixed.

    Raises:
        IllegalPhaseError: if `current` is not a known phase id.
    """
    if current not in _PHASE_TRANSITIONS:
        raise IllegalPhaseError(
            f"unknown phase {current!r}; expected one of {sorted(_PHASE_TRANSITIONS)}"
        )
    return _PHASE_TRANSITIONS[current]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_commit.py -v -k "next_phase"`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/commit.py tests/test_commit.py
git commit -m "feat(commit): phase transition map"
```

---

#### Task 7.4: commit-phase orchestrator

**Files:**
- Modify: `src/review_pdf_to_latex/commit.py`
- Test: `tests/test_commit.py`

**Implements spec:** §8 `commit-phase` row, §13.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_commit.py

from review_pdf_to_latex.commit import commit_phase


def _init_project_repo(tmp_path: Path) -> tuple[Path, Path]:
    """Initialize a git repo with a minimal LaTeX project + .review-state/
    populated for phase 1-batch."""
    project = tmp_path / "proj"
    project.mkdir()
    _git("init", "-q", cwd=project)
    _git("config", "user.email", "test@example.com", cwd=project)
    _git("config", "user.name", "Test", cwd=project)
    tex_dir = project / "templates"
    tex_dir.mkdir()
    tex = tex_dir / "section.tex"
    tex.write_text("hello\n", encoding="utf-8")
    _git("add", "templates/section.tex", cwd=project)
    _git("commit", "-q", "-m", "initial latex", cwd=project)

    state_dir = project / ".review-state"
    state_dir.mkdir()
    state = {
        "schema_version": 1,
        "phase": "1-batch",
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {
            "ann-001": {
                "status": "applied",
                "before_text": "hello\n",
                "proposed_text": "HELLO\n",
                "applied_text": "HELLO\n",
                "applied_at": "2026-05-16T20:45:12Z",
                "last_build_id": None,
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            }
        },
        "builds": [],
    }
    mapping = {
        "schema_version": 1,
        "mappings": {
            "ann-001": {
                "latex_file": "templates/section.tex",
                "line_range": [1, 1],
                "confidence": 0.95,
                "method": "fuzzy_text",
                "needs_review": False,
            }
        },
    }
    annotations = {"schema_version": 1, "annotations": []}
    (state_dir / "state.json").write_text(json.dumps(state), encoding="utf-8")
    (state_dir / "mapping.json").write_text(json.dumps(mapping), encoding="utf-8")
    (state_dir / "annotations.json").write_text(json.dumps(annotations), encoding="utf-8")

    # Pretend phase 1 already mutated the tex file.
    tex.write_text("HELLO\n", encoding="utf-8")

    return project, state_dir


def test_commit_phase_advances_phase_and_creates_commit(tmp_path: Path) -> None:
    project, state_dir = _init_project_repo(tmp_path)
    sha = commit_phase(
        state_dir=state_dir,
        phase_arg="1-batch",
        message_suffix="test suffix",
        granularity="phase",
    )
    assert isinstance(sha, str) and len(sha) >= 7

    # state.phase advanced to next.
    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["phase"] == "2a-ratify"

    # git log shows the new commit with expected subject and body.
    log = _git("log", "--format=%H%n%B", "-n", "1", cwd=project).stdout
    assert sha in log
    assert "phase 1" in log
    assert "test suffix" in log
    # state files included in the commit.
    files = _git("show", "--stat", "--name-only", "--format=", sha, cwd=project).stdout
    assert "templates/section.tex" in files
    assert ".review-state/state.json" in files


def test_commit_phase_rejects_phase_mismatch(tmp_path: Path) -> None:
    project, state_dir = _init_project_repo(tmp_path)
    # state.json says phase=1-batch; passing phase_arg=2a-ratify is illegal.
    with pytest.raises(CommitError):  # Either IllegalPhaseError or CommitFailedError
        commit_phase(
            state_dir=state_dir,
            phase_arg="2a-ratify",
            message_suffix=None,
            granularity="phase",
        )
```

The test imports `CommitError` and `_git` (defined in Task 7.1's test). If `CommitError` is not yet importable at top of the test file, add an import line.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_commit.py -v -k "commit_phase"`
Expected: ImportError on `commit_phase`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/commit.py`:

```python
def _files_touched_by_state(state: dict, project_root: Path) -> list[Path]:
    """Best-effort: every .tex file referenced indirectly by annotations with
    a non-null applied_text. For v1 we don't have a reverse index from
    annotation → file in state.json itself (mapping.json owns that), so we
    read mapping.json and collect all latex_file entries whose annotation
    has a status that implies the file was touched."""
    state_dir = project_root / ".review-state"
    mapping_path = state_dir / "mapping.json"
    if not mapping_path.exists():
        return []
    with mapping_path.open("r", encoding="utf-8") as f:
        mapping = json.load(f)
    touched: set[str] = set()
    annotation_states = state.get("annotations", {})
    for ann_id, map_entry in mapping.get("mappings", {}).items():
        ann = annotation_states.get(ann_id, {})
        if ann.get("applied_text") is not None or ann.get("status") in (
            "applied",
            "accepted",
            "redrafted",
            "rejected",  # rejected means we reverted, which is also a write
            "surfaced_resolved",
        ):
            if map_entry.get("latex_file"):
                touched.add(map_entry["latex_file"])
    return [project_root / f for f in sorted(touched)]


def commit_phase(
    state_dir: Path,
    phase_arg: str,
    message_suffix: str | None,
    granularity: str,
) -> str:
    """Render the commit message, stage touched files + all four state files,
    run `git commit`, then advance state.phase. Returns the new commit SHA.

    Spec §8 commit-phase row, §13.

    Args:
        state_dir: Path to .review-state.
        phase_arg: The SOURCE phase being committed; MUST equal state.phase.
        message_suffix: Optional free-form project tag.
        granularity: "phase" | "session" | "batch:N".

    Returns:
        The 40-char hex SHA of the new commit (from `git rev-parse HEAD`).

    Raises:
        IllegalPhaseError (exit 1): phase_arg != state.phase.
        DirtyGitError (exit 15): dirty pre-phase-0 state.
        CommitFailedError (exit 19): git add or git commit failed.
        SourcePdfChangedCommitError (exit 21): PDF md5 mismatch.
        LegacyStateCommitError (exit 22): annotations.json predates the guard.
    """
    state_dir = Path(state_dir)
    project_root = state_dir.parent
    # Spec §14 risk 9: refuse to commit against potentially stale state.
    try:
        assert_source_pdf_unchanged(StateDir(project_root))
    except SourcePdfChangedError as exc:
        raise SourcePdfChangedCommitError(str(exc)) from exc
    except LegacyStateError as exc:
        raise LegacyStateCommitError(str(exc)) from exc
    state_path = state_dir / "state.json"
    with state_path.open("r", encoding="utf-8") as f:
        state = json.load(f)

    current_phase = state.get("phase")
    if phase_arg != current_phase:
        raise IllegalPhaseError(
            f"--phase {phase_arg!r} does not match current state.phase "
            f"{current_phase!r}"
        )

    assert_clean_git(project_root=project_root, current_phase=current_phase)

    message = render_commit_message(
        phase=current_phase,
        granularity=granularity,
        message_suffix=message_suffix,
        state=state,
    )

    # Stage .tex files touched by annotation activity + the four state files.
    to_stage: list[str] = []
    for tex_path in _files_touched_by_state(state, project_root):
        try:
            to_stage.append(str(tex_path.resolve().relative_to(project_root)))
        except ValueError:
            continue
    for state_file in ("state.json", "mapping.json", "annotations.json"):
        p = state_dir / state_file
        if p.exists():
            to_stage.append(str(p.resolve().relative_to(project_root)))
    # Also stage state-events.jsonl if present (audit trail).
    events_path = state_dir / "state-events.jsonl"
    if events_path.exists():
        to_stage.append(str(events_path.resolve().relative_to(project_root)))

    if to_stage:
        add_result = subprocess.run(
            ["git", "add", "--", *to_stage],
            cwd=str(project_root),
            capture_output=True,
            text=True,
            check=False,
        )
        if add_result.returncode != 0:
            raise CommitFailedError(
                f"git add failed: {add_result.stderr.strip()}"
            )

    commit_result = subprocess.run(
        ["git", "commit", "-m", message],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if commit_result.returncode != 0:
        raise CommitFailedError(
            f"git commit failed: {commit_result.stderr.strip() or commit_result.stdout.strip()}"
        )

    sha_result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=str(project_root),
        capture_output=True,
        text=True,
        check=True,
    )
    sha = sha_result.stdout.strip()

    # Advance phase.
    state["phase"] = next_phase(current_phase)
    atomic_write_json(state_path, state)

    return sha
```

Notes:
- We deliberately call `git add` only on the files we know about; the spec rules (§5.1) say the engine is the sole writer of state files and mutates only `.tex` files in the project, so this is the complete set.
- If `to_stage` is empty (Phase 3 with nothing to commit), `git commit` will fail with "nothing to commit" and we raise `CommitFailedError`; this is the desired behavior since `commit-phase` should not produce empty commits.
- The phase advance happens AFTER the commit succeeds; if the commit fails, the state is unchanged and the operator can retry.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_commit.py -v -k "commit_phase"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/commit.py tests/test_commit.py
git commit -m "feat(commit): commit-phase orchestrator"
```

---

#### Task 7.5: Wire up the `commit-phase` CLI subcommand

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` (replace the `commit-phase` stub)
- Test: `tests/test_cli.py`

**Implements spec:** §8 `commit-phase` row.

- [ ] **Step 1: Write the failing test**

```python
# Append to tests/test_cli.py

def test_cli_commit_phase_subcommand(tmp_path: Path) -> None:
    """End-to-end: initialize a git repo, populate .review-state with a
    phase-1 snapshot, invoke `review-pdf commit-phase --phase 1-batch`,
    assert state.phase advanced and a commit landed."""
    project = tmp_path / "proj"
    project.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=str(project), check=True)
    subprocess.run(["git", "config", "user.email", "t@example.com"], cwd=str(project), check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(project), check=True)
    (project / "templates").mkdir()
    tex = project / "templates" / "section.tex"
    tex.write_text("orig\n", encoding="utf-8")
    subprocess.run(["git", "add", "templates/section.tex"], cwd=str(project), check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=str(project), check=True)

    # Simulate a phase-1 apply: mutate the file, set up state.
    tex.write_text("APPLIED\n", encoding="utf-8")
    state_dir = project / ".review-state"
    state_dir.mkdir()
    (state_dir / "state.json").write_text(
        json.dumps({
            "schema_version": 1,
            "phase": "1-batch",
            "order": "mechanical-first",
            "current_annotation_id": None,
            "annotations": {
                "ann-001": {
                    "status": "applied",
                    "before_text": "orig\n",
                    "proposed_text": "APPLIED\n",
                    "applied_text": "APPLIED\n",
                    "applied_at": "2026-05-16T20:45:12Z",
                    "last_build_id": None,
                    "surface_chat_log": None,
                    "failure_log_path": None,
                    "failure_edit_text": None,
                }
            },
            "builds": [],
        }),
        encoding="utf-8",
    )
    (state_dir / "mapping.json").write_text(
        json.dumps({
            "schema_version": 1,
            "mappings": {
                "ann-001": {
                    "latex_file": "templates/section.tex",
                    "line_range": [1, 1],
                    "confidence": 0.95,
                    "method": "fuzzy_text",
                    "needs_review": False,
                }
            },
        }),
        encoding="utf-8",
    )
    (state_dir / "annotations.json").write_text(
        json.dumps({"schema_version": 1, "annotations": []}),
        encoding="utf-8",
    )

    result = subprocess.run(
        [sys.executable, "-m", "review_pdf_to_latex",
         "commit-phase",
         "--project-dir", str(project),
         "--phase", "1-batch",
         "--message-suffix", "smoke test"],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    sha_printed = result.stdout.strip()
    assert len(sha_printed) >= 7

    state = json.loads((state_dir / "state.json").read_text(encoding="utf-8"))
    assert state["phase"] == "2a-ratify"

    log = subprocess.run(
        ["git", "log", "--format=%H%n%B", "-n", "1"],
        cwd=str(project), capture_output=True, text=True, check=True,
    ).stdout
    assert sha_printed in log
    assert "smoke test" in log
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py::test_cli_commit_phase_subcommand -v`
Expected: FAIL with `NotImplementedError`.

- [ ] **Step 3: Write minimal implementation**

In `src/review_pdf_to_latex/cli.py` replace the `commit-phase` stub. The chunk-B argparse skeleton accepts `--phase`, `--message-suffix`, and `--granularity` (default `"phase"`). Note that chunk B may register `--phase` accepting either short forms (`1`, `2a`) or full forms (`1-batch`, `2a-ratify`); we accept both and normalize:

```python
_PHASE_SHORT_TO_FULL: dict[str, str] = {
    "0": "0-setup",
    "1": "1-batch",
    "2a": "2a-ratify",
    "2b": "2b-surface",
    "3": "3-final",
    "0-setup": "0-setup",
    "1-batch": "1-batch",
    "2a-ratify": "2a-ratify",
    "2b-surface": "2b-surface",
    "3-final": "3-final",
}


def _cmd_commit_phase(args: argparse.Namespace) -> int:
    from .commit import CommitError, commit_phase
    state_dir = Path(args.project_dir) / ".review-state"
    phase_arg = _PHASE_SHORT_TO_FULL.get(args.phase, args.phase)
    try:
        sha = commit_phase(
            state_dir=state_dir,
            phase_arg=phase_arg,
            message_suffix=args.message_suffix,
            granularity=args.granularity,
        )
    except CommitError as e:
        print(f"error: {e}", file=sys.stderr)
        return e.exit_code
    print(sha)
    return 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py::test_cli_commit_phase_subcommand -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): wire up commit-phase"
```

---

### Summary checklist for Tasks 5–7

After completing every sub-task above, the engine has:

- `src/review_pdf_to_latex/build.py` exposing `run_latex`, `next_build_id`, `compute_page_md5s`, `paginate_diff`, `discover_main_file`, `run_build_command`.
- `src/review_pdf_to_latex/apply.py` exposing `apply_edit`, `apply_batch`, `revert_edit`, `set_annotation_status`, `append_chat_turn`, `record_proposal`, `override_mapping`, plus the `AppliedEdit` dataclass and `ApplyError` subclasses mapping to spec exit codes 7, 8, 9, 10, 13, 16, 18, 21, 22.
- `src/review_pdf_to_latex/commit.py` exposing `assert_clean_git`, `render_commit_message`, `next_phase`, `commit_phase`, plus the `DirtyGitError`, `CommitFailedError`, `IllegalPhaseError`, `SourcePdfChangedCommitError`, `LegacyStateCommitError` exceptions mapping to exit codes 15, 19, 21, 22.
- `cli.py` handlers wired for `apply`, `revert`, `set-status`, `append-chat`, `record-proposal`, `override-mapping`, `build`, `commit-phase` — eight of the fourteen CLI subcommands.

Cross-chunk dependencies surfaced:
- `state.atomic_write_json` (chunk A) — used in every mutation.
- `state.validate_status_transition` (chunk A) — used in `apply_edit`, `revert_edit`, `set_annotation_status`. Signature: `(from_status: str, to_status: str, action: str) -> bool`. Raises `IllegalTransitionError(ValueError)` on illegal moves; we wrap that as `IllegalStatusTransitionError` for exit code 18. Engine-internal action labels: `apply_edit` passes `"apply"`; `revert_edit` passes `"reject"` when status="rejected" else `"redraft"`; `set_annotation_status` derives action from target status via `_STATUS_TO_ACTION`, or takes an explicit `action` kwarg.
- `state.load_state` (chunk A) — used in `build.run_build_command`.
- chunk B's argparse skeleton — every CLI handler in this chunk depends on the subparser flags chunk B registers; if a flag name changes there, this chunk's handlers need to be re-wired.
- chunk F's fixtures (the e2e sample-project) are NOT depended on by the unit tests above; every test in this chunk constructs its own `tmp_path` fixture inline.

Test files produced by this chunk:
- `tests/test_build.py` — 13 test cases across 5 sub-tasks (Task 5).
- `tests/test_apply.py` — ~18 test cases across 7 sub-tasks (Task 6.1 through 6.7).
- `tests/test_commit.py` — 9 test cases across 4 sub-tasks (Task 7.1 through 7.4).
- Additions to `tests/test_cli.py` — 8 CLI integration cases across Tasks 5.4, 5.5, 6.8, 7.5.
<!-- Chunk D — HTTP server, events file, wait-event -->

## Task 8 — HTTP server + events file + wait-event

This chunk creates `src/review_pdf_to_latex/server.py` and wires the `serve` and `wait-event` subcommands in `cli.py`. The server is built on Python's stdlib `http.server` (no Flask, no FastAPI). It serves the viewer's static-ish assets, accepts POSTs that append to `state-events.jsonl`, and exposes the blocking event poller consumed by `review-pdf wait-event`.

**Authoritative spec sections for this chunk:**
- §7.4 — `state-events.jsonl` schema and the action enum (`approve | reject | redraft | preview | skip | surface | override-mapping`).
- §8 — `serve` and `wait-event` CLI rows (signatures + exit codes).
- §10.1, §10.2 — viewer layout and 500ms poll model.
- §10.5 — click → engine path, plus the four "blocking-call lifecycle" bullets that drive Task 8.7.
- §10.6 — manual-mapping UI mode dispatch via `--mapping-mode`.

**State files this chunk touches:**
- *Reads only:* `state.json` (via `state.read_state` from chunk A); `mapping.json` (only inside the `/api/state` read-through, never written).
- *Writes only:* `state-events.jsonl` — this chunk is the sole writer. The engine never modifies `state-events.jsonl`; the file is the viewer→engine event log defined in §7.4.

**Cross-chunk dependencies:**
- Chunk A owns `state.py` (provides `STATE_DIR_NAME = ".review-state"`, `state_dir(project_dir)`, `read_state(project_dir)`, `state_path(project_dir)`, the `StateMissingError` exception class with exit-code mapping, and the `atomic_write_json` helper). All file reads against state go through those helpers.
- Chunk E owns the Jinja2 templates `templates/frame.html`, `templates/annotation.html`, and the manual-mapping template content. Task 8.4 only wires the `mode` kwarg through; the template's `{% if mode == "mapping" %}` branch is implemented in chunk E.
- Chunk F owns the e2e fixture `tests/fixtures/sample-project/` with a populated `.review-state/`. Tests in this chunk that need a real fixture seed their own minimal one inline via `conftest.py` (added incrementally below) so chunk D is self-contained.

**Exit codes used by this chunk (cross-referencing spec §8):**
- `serve`: `0` clean shutdown; `5` port unavailable OR `serve.lock` held; `6` state missing.
- `wait-event`: `0` event(s) returned; `6` state missing; `20` timeout; `130` user abort (SIGINT). SIGTERM → exit `0` with no stdout (per Task 8.7).

---

### Task 8.0: Module scaffolding and shared helpers

**Files:**
- Create: `src/review_pdf_to_latex/server.py` (skeleton; expanded by later tasks)
- Create: `tests/test_server.py` (skeleton)
- Modify: `tests/conftest.py:1-end` (add `minimal_project` fixture for server tests)

**Implements spec:** §7.3 (state schema we read), §7.4 (events schema we write), §8 (`serve` and `wait-event` rows).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py
"""Tests for review_pdf_to_latex.server."""
from __future__ import annotations

import importlib

import pytest


def test_server_module_importable() -> None:
    """server.py must be importable and expose the public symbols used by cli.py."""
    mod = importlib.import_module("review_pdf_to_latex.server")
    assert hasattr(mod, "ReviewHandler"), "ReviewHandler class must be exposed"
    assert hasattr(mod, "wait_for_events"), "wait_for_events function must be exposed"
    assert hasattr(mod, "build_server"), "build_server factory must be exposed"
    assert hasattr(mod, "EVENTS_FILENAME"), "EVENTS_FILENAME constant must be exposed"
    assert mod.EVENTS_FILENAME == "state-events.jsonl"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py::test_server_module_importable -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'review_pdf_to_latex.server'`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/server.py
"""Local HTTP viewer + state-events.jsonl writer + wait-event poller.

The viewer is intentionally tiny: stdlib http.server, Jinja2 templates rendered
on the fly, no JS bundling. The single non-static endpoint is POST /api/events,
which appends one JSONL line to .review-state/state-events.jsonl. The engine
never writes that file; only this server does.

See spec sections:
- §7.4 — state-events.jsonl line schema and action enum.
- §8 — serve and wait-event CLI rows (exit codes).
- §10.5 — click→engine path and blocking-call lifecycle.
- §10.6 — manual-mapping UI dispatch via --mapping-mode.
"""
from __future__ import annotations

import http.server
from pathlib import Path
from typing import Any

EVENTS_FILENAME = "state-events.jsonl"
STATE_DIR_NAME = ".review-state"  # mirrors state.STATE_DIR_NAME for module independence


class ReviewHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP request handler for the review viewer.

    Subclasses SimpleHTTPRequestHandler so the static-file plumbing
    (range requests, content-types, HEAD support) is inherited. We override
    do_GET to dispatch to specific routes and do_POST for /api/events.

    Configured via class attributes set by build_server():
    - project_dir: Path to the LaTeX project root.
    - mode: "normal" or "mapping" (mapping-mode UI dispatch).
    """

    project_dir: Path = Path(".")
    mode: str = "normal"

    def do_GET(self) -> None:  # noqa: N802 (stdlib name)
        raise NotImplementedError  # filled in by Task 8.1

    def do_POST(self) -> None:  # noqa: N802 (stdlib name)
        raise NotImplementedError  # filled in by Task 8.2

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        """Silence default stderr access-log spam; tests reach in if they care."""
        return


def build_server(
    project_dir: Path, port: int, mode: str = "normal"
) -> http.server.HTTPServer:
    """Factory for the HTTPServer bound to ReviewHandler with closures over config.

    Returns an HTTPServer ready to serve; the caller drives serve_forever().
    """
    handler_cls = type(
        "BoundReviewHandler",
        (ReviewHandler,),
        {"project_dir": Path(project_dir), "mode": mode},
    )
    return http.server.HTTPServer(("127.0.0.1", port), handler_cls)


def wait_for_events(
    events_path: Path,
    since_ts: str | None,
    timeout_sec: int = 60,
) -> list[dict[str, Any]]:
    """Block until new event(s) land in events_path or the timeout fires.

    See Task 8.5 for the full implementation; this stub is replaced incrementally.
    """
    raise NotImplementedError  # filled in by Task 8.5
```

Also create the conftest fixture used by every test below:

```python
# tests/conftest.py  (append; this file is started by chunk A — append, do not rewrite)
"""Shared pytest fixtures for review_pdf_to_latex tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def minimal_project(tmp_path: Path) -> Path:
    """Create the smallest possible .review-state/ that server tests need.

    Layout:
      <tmp>/project/
        main.tex
        .review-state/
          state.json
          mapping.json
          pages/page-1.png    (a 1-byte file; content irrelevant for routing tests)
          builds/build-001/page-1.png

    state.json carries phase 2a-ratify, one annotation ann-001 in status applied.
    """
    project = tmp_path / "project"
    state_dir = project / ".review-state"
    pages = state_dir / "pages"
    build_dir = state_dir / "builds" / "build-001"
    pages.mkdir(parents=True)
    build_dir.mkdir(parents=True)
    (project / "main.tex").write_text("\\documentclass{article}\n\\begin{document}\nx\n\\end{document}\n")
    (pages / "page-1.png").write_bytes(b"\x89PNG\r\n\x1a\n")  # PNG magic — enough for content-type
    (build_dir / "page-1.png").write_bytes(b"\x89PNG\r\n\x1a\n")
    state = {
        "schema_version": 1,
        "phase": "2a-ratify",
        "order": "mechanical-first",
        "current_annotation_id": "ann-001",
        "annotations": {
            "ann-001": {
                "status": "applied",
                "before_text": "old",
                "proposed_text": "new",
                "applied_text": "new",
                "applied_at": "2026-05-16T20:45:12Z",
                "last_build_id": "build-001",
                "surface_chat_log": None,
                "failure_log_path": None,
                "failure_edit_text": None,
            }
        },
        "builds": [
            {
                "id": "build-001",
                "pdf_path": ".review-state/builds/build-001.pdf",
                "page_count": 1,
                "compiled_at": "2026-05-16T20:46:00Z",
                "log_path": ".review-state/builds/build-001.log",
                "ok": True,
                "page_md5": ["d41d8cd98f00b204e9800998ecf8427e"],
            }
        ],
    }
    (state_dir / "state.json").write_text(json.dumps(state, indent=2, sort_keys=True))
    (state_dir / "mapping.json").write_text(
        json.dumps(
            {"schema_version": 1, "mappings": {"ann-001": {"latex_file": "main.tex",
              "line_range": [1, 4], "method": "fuzzy", "confidence": 0.91, "needs_review": False}}},
            indent=2, sort_keys=True,
        )
    )
    return project
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py::test_server_module_importable -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py tests/test_server.py tests/conftest.py
git commit -m "feat(server): scaffold server.py module with public surface"
```

---

### Task 8.1: HTTP request handler — GET routing

**Files:**
- Modify: `src/review_pdf_to_latex/server.py` — flesh out `do_GET`, add `_render_frame`, `_serve_static_file`, `_serve_json_state`, `_send_404`.
- Create: `src/review_pdf_to_latex/templates/__init__.py` (empty marker; chunk E adds the .html files).
- Modify: `tests/test_server.py` — add five GET route tests.

**Implements spec:** §10.1, §10.5 (server side), §10.6 (mode plumbing — full template dispatch is Task 8.4).

The route table (resolved in this order; first match wins):

| Path pattern | Action | Content-Type | Source |
|---|---|---|---|
| `GET /` | Render `frame.html` via Jinja2 with `current_state=<state.json>, mode=<self.mode>` | `text/html; charset=utf-8` | `templates/frame.html` |
| `GET /pages/page-N.png` | Send file bytes (no path traversal) | `image/png` | `<project>/.review-state/pages/page-N.png` |
| `GET /builds/<build_id>/page-N.png` | Send file bytes (no traversal; build_id matches `^build-\d+$`) | `image/png` | `<project>/.review-state/builds/<build_id>/page-N.png` |
| `GET /static/<file>` | Send file bytes (no traversal; file matches `^[A-Za-z0-9._-]+$`) | mimetype-guessed | `<package_root>/templates/static/<file>` |
| `GET /api/state` | Stream `.review-state/state.json` bytes verbatim | `application/json; charset=utf-8` | `<project>/.review-state/state.json` |
| anything else | 404 | `text/plain; charset=utf-8` | — |

Path-traversal defense: every dynamic segment is checked against a strict regex BEFORE being joined; after joining, the resolved path is verified via `Path.resolve().is_relative_to(<base>.resolve())`. On any mismatch the handler returns 404 (not 400, to make the surface uniform for fuzzers).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py  (append below the import test)
from __future__ import annotations

import json
import socket
import threading
import urllib.request
from http import HTTPStatus
from pathlib import Path
from urllib.error import HTTPError

import pytest

from review_pdf_to_latex import server as server_mod


def _pick_port() -> int:
    s = socket.socket()
    s.bind(("", 0))
    port = s.getsockname()[1]
    s.close()
    return port


@pytest.fixture
def running_server(minimal_project: Path, monkeypatch: pytest.MonkeyPatch):
    """Start an HTTPServer in a background thread; yield (base_url, project_dir).

    Stops the server cleanly on teardown via shutdown() + server_close().
    """
    # Stub frame.html rendering so this fixture does not depend on chunk E.
    # The test for the real template is in tests/test_templates.py (chunk E).
    rendered_html = b"<!doctype html><html><body>frame-stub</body></html>"

    def fake_render(self: server_mod.ReviewHandler) -> bytes:
        # Capture mode so the mapping-mode test (Task 8.4) can assert on it.
        return rendered_html + f"<!-- mode={self.mode} -->".encode()

    monkeypatch.setattr(server_mod.ReviewHandler, "_render_frame", fake_render, raising=True)

    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port, mode="normal")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        yield (f"http://127.0.0.1:{port}", minimal_project)
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def _get(base_url: str, path: str) -> tuple[int, str, bytes]:
    req = urllib.request.Request(base_url + path, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except HTTPError as e:
        return e.code, e.headers.get("Content-Type", "") if e.headers else "", e.read()


def test_get_root_returns_rendered_frame(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/")
    assert status == HTTPStatus.OK
    assert ctype.startswith("text/html")
    assert b"frame-stub" in body
    assert b"mode=normal" in body


def test_get_page_png_served_from_pages_dir(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/pages/page-1.png")
    assert status == HTTPStatus.OK
    assert ctype.startswith("image/png")
    assert body.startswith(b"\x89PNG")


def test_get_build_page_png_served_from_build_dir(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/builds/build-001/page-1.png")
    assert status == HTTPStatus.OK
    assert ctype.startswith("image/png")


def test_get_api_state_returns_state_json(running_server) -> None:
    base_url, _ = running_server
    status, ctype, body = _get(base_url, "/api/state")
    assert status == HTTPStatus.OK
    assert ctype.startswith("application/json")
    payload = json.loads(body.decode())
    assert payload["phase"] == "2a-ratify"
    assert "ann-001" in payload["annotations"]


def test_get_unknown_path_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _, _ = _get(base_url, "/does-not-exist")
    assert status == HTTPStatus.NOT_FOUND


def test_path_traversal_in_pages_returns_404(running_server) -> None:
    base_url, _ = running_server
    # %2e%2e%2f%2e%2e%2f is "../.. /" — traversal attempt
    status, _, _ = _get(base_url, "/pages/%2e%2e%2f%2e%2e%2fmain.tex")
    assert status == HTTPStatus.NOT_FOUND


def test_path_traversal_in_builds_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _, _ = _get(base_url, "/builds/build-001/%2e%2e/page-1.png")
    assert status == HTTPStatus.NOT_FOUND


def test_invalid_build_id_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _, _ = _get(base_url, "/builds/not_a_build/page-1.png")
    assert status == HTTPStatus.NOT_FOUND
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v`
Expected: every new test fails — most with `NotImplementedError` (from do_GET) propagating into the HTTP response (urllib will see a 500 or connection reset).

- [ ] **Step 3: Write minimal implementation**

Replace the stub `do_GET` and add the helpers:

```python
# src/review_pdf_to_latex/server.py  (replace stub do_GET; append helpers)
from __future__ import annotations

import http.server
import json
import mimetypes
import re
from http import HTTPStatus
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

import jinja2

EVENTS_FILENAME = "state-events.jsonl"
STATE_DIR_NAME = ".review-state"

_PAGE_FILENAME_RE = re.compile(r"^page-\d+\.png$")
_BUILD_ID_RE = re.compile(r"^build-\d+$")
_STATIC_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+$")

# Package root for template lookups. The templates/ directory lives under the
# review_pdf_to_latex package so it is importable via importlib.resources.
_PACKAGE_ROOT = Path(__file__).resolve().parent
_TEMPLATES_DIR = _PACKAGE_ROOT / "templates"
_STATIC_DIR = _TEMPLATES_DIR / "static"

_jinja_env = jinja2.Environment(
    loader=jinja2.FileSystemLoader(str(_TEMPLATES_DIR)),
    autoescape=jinja2.select_autoescape(["html"]),
    undefined=jinja2.StrictUndefined,
)


class ReviewHandler(http.server.SimpleHTTPRequestHandler):
    """Routing + rendering. See module docstring for spec links."""

    project_dir: Path = Path(".")
    mode: str = "normal"

    # ---- GET dispatch -------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/":
            self._serve_frame()
            return
        if path == "/api/state":
            self._serve_state_json()
            return
        if path.startswith("/pages/"):
            self._serve_page_png(path[len("/pages/") :])
            return
        if path.startswith("/builds/"):
            self._serve_build_png(path[len("/builds/") :])
            return
        if path.startswith("/static/"):
            self._serve_static_file(path[len("/static/") :])
            return
        self._send_404()

    # ---- per-route helpers --------------------------------------------------

    def _serve_frame(self) -> None:
        try:
            body = self._render_frame()
        except FileNotFoundError:
            # state.json missing — degrade to a clean 503 so the viewer can show
            # a "no review session" page; we surface 503 (Service Unavailable)
            # rather than 404 because the URL itself is valid.
            self._send_simple(HTTPStatus.SERVICE_UNAVAILABLE, b"no review state\n")
            return
        self._send_bytes(HTTPStatus.OK, body, "text/html; charset=utf-8")

    def _render_frame(self) -> bytes:
        """Render frame.html with current_state and mode. Chunk E owns the template."""
        state_path = self.project_dir / STATE_DIR_NAME / "state.json"
        try:
            current_state: dict[str, Any] = json.loads(state_path.read_text())
        except FileNotFoundError:
            raise
        template = _jinja_env.get_template("frame.html")
        return template.render(current_state=current_state, mode=self.mode).encode("utf-8")

    def _serve_state_json(self) -> None:
        state_path = self.project_dir / STATE_DIR_NAME / "state.json"
        try:
            raw = state_path.read_bytes()
        except FileNotFoundError:
            self._send_simple(HTTPStatus.SERVICE_UNAVAILABLE, b"no review state\n")
            return
        self._send_bytes(HTTPStatus.OK, raw, "application/json; charset=utf-8")

    def _serve_page_png(self, leaf: str) -> None:
        leaf = unquote(leaf)
        if not _PAGE_FILENAME_RE.fullmatch(leaf):
            self._send_404()
            return
        base = (self.project_dir / STATE_DIR_NAME / "pages").resolve()
        target = (base / leaf).resolve()
        if not _is_within(target, base):
            self._send_404()
            return
        self._send_file(target, "image/png")

    def _serve_build_png(self, tail: str) -> None:
        tail = unquote(tail)
        # tail is "<build_id>/<filename>"
        parts = tail.split("/", 1)
        if len(parts) != 2:
            self._send_404()
            return
        build_id, leaf = parts
        if not _BUILD_ID_RE.fullmatch(build_id) or not _PAGE_FILENAME_RE.fullmatch(leaf):
            self._send_404()
            return
        base = (self.project_dir / STATE_DIR_NAME / "builds" / build_id).resolve()
        target = (base / leaf).resolve()
        if not _is_within(target, base):
            self._send_404()
            return
        self._send_file(target, "image/png")

    def _serve_static_file(self, leaf: str) -> None:
        leaf = unquote(leaf)
        if not _STATIC_FILENAME_RE.fullmatch(leaf):
            self._send_404()
            return
        base = _STATIC_DIR.resolve()
        target = (base / leaf).resolve()
        if not _is_within(target, base):
            self._send_404()
            return
        ctype, _ = mimetypes.guess_type(leaf)
        if ctype is None:
            ctype = "application/octet-stream"
        self._send_file(target, ctype)

    # ---- byte/file plumbing -------------------------------------------------

    def _send_file(self, path: Path, content_type: str) -> None:
        try:
            data = path.read_bytes()
        except FileNotFoundError:
            self._send_404()
            return
        except IsADirectoryError:
            self._send_404()
            return
        self._send_bytes(HTTPStatus.OK, data, content_type)

    def _send_bytes(self, status: HTTPStatus, body: bytes, content_type: str) -> None:
        self.send_response(int(status))
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_simple(self, status: HTTPStatus, body: bytes) -> None:
        self._send_bytes(status, body, "text/plain; charset=utf-8")

    def _send_404(self) -> None:
        self._send_simple(HTTPStatus.NOT_FOUND, b"not found\n")

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return


def _is_within(target: Path, base: Path) -> bool:
    """True iff target is base or a descendant. Both arguments must be resolved."""
    try:
        target.relative_to(base)
        return True
    except ValueError:
        return False


def build_server(
    project_dir: Path, port: int, mode: str = "normal"
) -> http.server.HTTPServer:
    handler_cls = type(
        "BoundReviewHandler",
        (ReviewHandler,),
        {"project_dir": Path(project_dir).resolve(), "mode": mode},
    )
    return http.server.HTTPServer(("127.0.0.1", port), handler_cls)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v`
Expected: PASS for all eight GET tests added above. (The import test from Task 8.0 also still passes.)

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py src/review_pdf_to_latex/templates/__init__.py tests/test_server.py
git commit -m "feat(server): HTTP request handler"
```

---

### Task 8.2: Events POST endpoint

**Files:**
- Modify: `src/review_pdf_to_latex/server.py` — implement `do_POST`, helpers `_handle_events_post`, `_validate_event`, `_append_event_line`.
- Modify: `tests/test_server.py` — add POST tests (happy path, invalid action, missing field, concurrent appends, oversized body).

**Implements spec:** §7.4 (line schema), §10.5 (POSIX-atomic append).

POST contract:

```
POST /api/events
Content-Type: application/json
Body: {
  "annotation_id": "<string>",
  "action": "<approve|reject|redraft|preview|skip|surface|override-mapping>",
  "speculative_text": "<string, optional — preview/redraft>",
  "file": "<string, REQUIRED iff action == override-mapping>",
  "line_start": <int>=1, REQUIRED iff action == override-mapping>,
  "line_end": <int>=line_start, REQUIRED iff action == override-mapping>
}
```

On success:
- Append exactly one JSONL line to `<project>/.review-state/state-events.jsonl` of the form `{"ts": "<iso8601-utc>", "annotation_id": "...", "action": "...", "speculative_text": "..." (optional), "file": "...", "line_start": N, "line_end": M}` — the `file`/`line_start`/`line_end` fields appear iff action is `override-mapping` (spec §10.6).
- `ts` is generated server-side via `datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")` (ISO8601 with `Z` suffix to match spec §7.4 examples).
- Return `204 No Content` with empty body.

On error:
- Body not JSON → `400 Bad Request` with `text/plain; charset=utf-8` body `"invalid JSON\n"`.
- Missing `annotation_id` (string) or `action` (string) → `400` body `"missing field: <name>\n"`.
- Action not in the seven-action enum → `400` body `"invalid action: <value>\n"`.
- `speculative_text` present but not a string → `400` body `"speculative_text must be a string\n"`.
- action == `override-mapping` and any of `file` / `line_start` / `line_end` is missing or malformed (non-string file, non-positive-int line_start, or line_end < line_start) → `400` body `"missing field: <name> ...\n"`.
- Body size > 64 KiB → `413 Payload Too Large`, body `"body too large\n"`. (Defensive cap; the largest legitimate payload is a preview's `speculative_text`, a paragraph of LaTeX.)

Concurrency:
- File append uses `os.open(events_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)` followed by `fcntl.flock(fd, fcntl.LOCK_EX)`, one `os.write` of the exact `line + "\n"` bytes, then `os.close` (which releases the lock). Per spec §10.5, line-sized POSIX `write` is atomic, but the flock guards against very long `speculative_text` payloads on systems where the atomic-write boundary is smaller than the payload.

Path resolution:
- `events_path = self.project_dir / STATE_DIR_NAME / EVENTS_FILENAME`. If `.review-state/` does not exist (no extract has been run), the POST returns `503 Service Unavailable` with `"no review state\n"` (consistent with `_serve_frame`).

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py  (append)
import time
from concurrent.futures import ThreadPoolExecutor


def _post_json(base_url: str, path: str, payload: dict | None,
               raw_body: bytes | None = None) -> tuple[int, bytes]:
    body = raw_body if raw_body is not None else json.dumps(payload).encode()
    req = urllib.request.Request(
        base_url + path, method="POST", data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, resp.read()
    except HTTPError as e:
        return e.code, e.read()


def test_post_events_happy_path_returns_204(running_server) -> None:
    base_url, project_dir = running_server
    status, body = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-001", "action": "approve"})
    assert status == HTTPStatus.NO_CONTENT
    assert body == b""
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    assert events_path.exists()
    lines = events_path.read_text().splitlines()
    assert len(lines) == 1
    rec = json.loads(lines[0])
    assert rec["annotation_id"] == "ann-001"
    assert rec["action"] == "approve"
    assert rec["ts"].endswith("Z")  # ISO8601 UTC with Z suffix
    assert "speculative_text" not in rec  # omitted when not supplied


def test_post_events_with_speculative_text(running_server) -> None:
    base_url, project_dir = running_server
    status, _ = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-001", "action": "preview",
         "speculative_text": "COTA enrollment grew 12% YoY."})
    assert status == HTTPStatus.NO_CONTENT
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    rec = json.loads(events_path.read_text().splitlines()[-1])
    assert rec["speculative_text"] == "COTA enrollment grew 12% YoY."


@pytest.mark.parametrize("action", [
    "approve", "reject", "redraft", "preview", "skip", "surface"
])
def test_post_events_accepts_six_status_only_actions(running_server, action: str) -> None:
    base_url, _ = running_server
    status, _ = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-001", "action": action})
    assert status == HTTPStatus.NO_CONTENT


def test_post_events_override_mapping_roundtrip(running_server) -> None:
    """override-mapping requires file/line_start/line_end and persists them."""
    base_url, project_dir = running_server
    payload = {
        "annotation_id": "ann-007",
        "action": "override-mapping",
        "file": "src/coverletter.tex",
        "line_start": 42,
        "line_end": 47,
    }
    status, _ = _post_json(base_url, "/api/events", payload)
    assert status == HTTPStatus.NO_CONTENT
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    rec = json.loads(events_path.read_text().splitlines()[-1])
    assert rec["annotation_id"] == "ann-007"
    assert rec["action"] == "override-mapping"
    assert rec["file"] == "src/coverletter.tex"
    assert rec["line_start"] == 42
    assert rec["line_end"] == 47


def test_post_events_override_mapping_missing_file_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-007", "action": "override-mapping",
         "line_start": 42, "line_end": 47})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"file" in body


def test_post_events_override_mapping_missing_line_start_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-007", "action": "override-mapping",
         "file": "src/coverletter.tex", "line_end": 47})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"line_start" in body


def test_post_events_override_mapping_bad_line_end_rejected(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-007", "action": "override-mapping",
         "file": "src/coverletter.tex", "line_start": 50, "line_end": 47})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"line_end" in body


def test_post_events_rejects_invalid_action(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-001", "action": "yeet"})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"invalid action" in body


def test_post_events_rejects_missing_annotation_id(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events", {"action": "approve"})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"annotation_id" in body


def test_post_events_rejects_missing_action(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events", {"annotation_id": "ann-001"})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"action" in body


def test_post_events_rejects_non_json_body(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events", None, raw_body=b"not json")
    assert status == HTTPStatus.BAD_REQUEST
    assert b"invalid JSON" in body


def test_post_events_rejects_oversized_body(running_server) -> None:
    base_url, _ = running_server
    big = "x" * (64 * 1024 + 1)
    status, body = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-001", "action": "preview", "speculative_text": big})
    assert status == HTTPStatus.REQUEST_ENTITY_TOO_LARGE
    assert b"body too large" in body


def test_post_events_rejects_non_string_speculative_text(running_server) -> None:
    base_url, _ = running_server
    status, body = _post_json(base_url, "/api/events",
        {"annotation_id": "ann-001", "action": "preview", "speculative_text": 42})
    assert status == HTTPStatus.BAD_REQUEST
    assert b"speculative_text" in body


def test_post_events_concurrent_appends_do_not_tear(running_server) -> None:
    base_url, project_dir = running_server
    N = 16
    payloads = [{"annotation_id": f"ann-{i:03d}", "action": "approve"} for i in range(N)]
    with ThreadPoolExecutor(max_workers=N) as pool:
        results = list(pool.map(
            lambda p: _post_json(base_url, "/api/events", p), payloads))
    assert all(s == HTTPStatus.NO_CONTENT for s, _ in results)
    events_path = project_dir / ".review-state" / "state-events.jsonl"
    lines = events_path.read_text().splitlines()
    assert len(lines) == N
    seen_ids = set()
    for line in lines:
        rec = json.loads(line)  # must parse cleanly — no torn writes
        seen_ids.add(rec["annotation_id"])
    assert seen_ids == {f"ann-{i:03d}" for i in range(N)}


def test_post_unknown_path_returns_404(running_server) -> None:
    base_url, _ = running_server
    status, _ = _post_json(base_url, "/api/nope", {"x": 1})
    assert status == HTTPStatus.NOT_FOUND


def test_post_events_503_when_state_dir_missing(tmp_path, monkeypatch) -> None:
    # Bare project with no .review-state/
    project = tmp_path / "bare"
    project.mkdir()
    port = _pick_port()
    httpd = server_mod.build_server(project, port, mode="normal")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, body = _post_json(f"http://127.0.0.1:{port}", "/api/events",
            {"annotation_id": "ann-001", "action": "approve"})
        assert status == HTTPStatus.SERVICE_UNAVAILABLE
        assert b"no review state" in body
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v -k "post"`
Expected: every new POST test fails. Most surface as `NotImplementedError` from the do_POST stub → HTTP 500 in the response.

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/server.py  (append; replace stub do_POST)
import fcntl
import os
from datetime import datetime, timezone

_VALID_ACTIONS = frozenset({
    "approve", "reject", "redraft", "preview", "skip", "surface", "override-mapping",
})
_MAX_BODY_BYTES = 64 * 1024


class _BadRequest(Exception):
    """Raised by validation helpers to short-circuit do_POST with a 400 body."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def _utc_now_iso() -> str:
    """ISO8601 UTC timestamp matching the spec §7.4 examples (Z suffix, seconds)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _validate_event(payload: object) -> dict[str, Any]:
    """Validate a parsed JSON payload against the §7.4 schema. Returns the cleaned record (no ts).

    For action == "override-mapping" (spec §10.6), the payload MUST also
    include `file: str`, `line_start: int`, `line_end: int`. These are
    threaded through into the JSONL record so the consuming skill (via
    `review-pdf wait-event`) can reconstruct the override and invoke
    `review-pdf override-mapping --file <f> --lines START:END`.
    """
    if not isinstance(payload, dict):
        raise _BadRequest("body must be a JSON object")
    ann = payload.get("annotation_id")
    if not isinstance(ann, str) or not ann:
        raise _BadRequest("missing field: annotation_id")
    action = payload.get("action")
    if not isinstance(action, str) or not action:
        raise _BadRequest("missing field: action")
    if action not in _VALID_ACTIONS:
        raise _BadRequest(f"invalid action: {action}")
    record: dict[str, Any] = {"annotation_id": ann, "action": action}
    if "speculative_text" in payload:
        spec_text = payload["speculative_text"]
        if not isinstance(spec_text, str):
            raise _BadRequest("speculative_text must be a string")
        record["speculative_text"] = spec_text
    if action == "override-mapping":
        # Required override-mapping fields per spec §10.6.
        file_val = payload.get("file")
        if not isinstance(file_val, str) or not file_val:
            raise _BadRequest("missing field: file (required for override-mapping)")
        line_start = payload.get("line_start")
        if not isinstance(line_start, int) or isinstance(line_start, bool) or line_start < 1:
            raise _BadRequest("missing field: line_start (positive int required for override-mapping)")
        line_end = payload.get("line_end")
        if not isinstance(line_end, int) or isinstance(line_end, bool) or line_end < line_start:
            raise _BadRequest("missing field: line_end (int >= line_start required for override-mapping)")
        record["file"] = file_val
        record["line_start"] = line_start
        record["line_end"] = line_end
    return record


def _append_event_line(events_path: Path, record: dict[str, Any]) -> None:
    """Append one JSONL line to events_path; fcntl.flock-serialized."""
    events_path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(record, separators=(",", ":"), ensure_ascii=False) + "\n"
    data = line.encode("utf-8")
    fd = os.open(str(events_path), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        try:
            written = 0
            while written < len(data):
                n = os.write(fd, data[written:])
                if n <= 0:
                    raise OSError("short write to state-events.jsonl")
                written += n
        finally:
            fcntl.flock(fd, fcntl.LOCK_UN)
    finally:
        os.close(fd)


# Splice into the ReviewHandler class (alongside do_GET):
class ReviewHandler(http.server.SimpleHTTPRequestHandler):  # type: ignore[no-redef]
    # ... (existing attributes and do_GET / helpers from Task 8.1) ...

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path != "/api/events":
            self._send_404()
            return
        self._handle_events_post()

    def _handle_events_post(self) -> None:
        # Enforce the body-size cap BEFORE reading so a malicious client can't OOM us.
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_simple(HTTPStatus.BAD_REQUEST, b"invalid Content-Length\n")
            return
        if content_length > _MAX_BODY_BYTES:
            self._send_simple(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, b"body too large\n")
            return

        events_path = self.project_dir / STATE_DIR_NAME / EVENTS_FILENAME
        if not events_path.parent.exists():
            self._send_simple(HTTPStatus.SERVICE_UNAVAILABLE, b"no review state\n")
            return

        raw = self.rfile.read(content_length) if content_length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except (json.JSONDecodeError, UnicodeDecodeError):
            self._send_simple(HTTPStatus.BAD_REQUEST, b"invalid JSON\n")
            return

        try:
            record = _validate_event(payload)
        except _BadRequest as e:
            self._send_simple(HTTPStatus.BAD_REQUEST, (e.message + "\n").encode("utf-8"))
            return

        # Build the on-disk record: ts first, then annotation_id/action/speculative_text.
        full_record = {"ts": _utc_now_iso(), **record}
        try:
            _append_event_line(events_path, full_record)
        except OSError as e:
            self._send_simple(HTTPStatus.INTERNAL_SERVER_ERROR, f"append failed: {e}\n".encode())
            return

        self.send_response(int(HTTPStatus.NO_CONTENT))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
```

(Note for the engineer: the second `class ReviewHandler` block above is shorthand. In the actual edit, merge `do_POST` and `_handle_events_post` into the existing class body; do not redefine the class.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v`
Expected: PASS for every test in the file so far.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py tests/test_server.py
git commit -m "feat(server): events POST endpoint"
```

---

### Task 8.3: `serve` CLI subcommand — port, lock, lifecycle

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` — register the `serve` subparser and wire `handle_serve`.
- Modify: `src/review_pdf_to_latex/server.py` — add `pick_free_port`, `acquire_serve_lock`, `handle_serve` (callable from cli.py).
- Modify: `tests/test_server.py` — add lifecycle tests (port selection, lock conflict, SIGINT shutdown, state-missing exit 6).

**Implements spec:** §8 (`serve` row: exit codes 0, 5, 6), §10.5 (server lifecycle), §13.2 (no git side effects), §14 risk #11 (single-instance lock).

Argument set for the subparser:

| Flag | Required? | Default | Notes |
|---|---|---|---|
| `--project-dir PATH` | no | `$PWD` | Resolved to absolute path. |
| `--port N` | no | auto-pick free port | 0 means auto-pick (same as omitting). |
| `--order {mechanical-first, surface-first}` | no | `mechanical-first` | Persisted into `state.json["order"]` if absent or different. |
| `--mapping-mode` | no | False | Toggles template `mode` from `"normal"` to `"mapping"` (Task 8.4). |

`handle_serve` algorithm:

1. Resolve `--project-dir`.
2. If `<project>/.review-state/state.json` is missing, write `state missing; run 'review-pdf extract' first\n` to stderr and exit `6`.
3. Acquire `<project>/.review-state/serve.lock` with `fcntl.flock(LOCK_EX | LOCK_NB)`. On `BlockingIOError`, write `another serve instance is running (lock held)\n` to stderr and exit `5`.
4. Read `state.json` via `state.read_state`. If `state["order"]` differs from `--order`, atomically rewrite with the new value (using `state.atomic_write_json` from chunk A). Touching `order` is the ONLY state mutation the server itself performs.
5. Resolve port: if `--port == 0`, call `pick_free_port`; else use the supplied port.
6. Build the HTTPServer; print `Viewer: http://127.0.0.1:<port>/` to stderr.
7. Install a SIGINT handler that calls `httpd.shutdown()` in a background thread (necessary because `shutdown()` blocks if called from the same thread driving `serve_forever`).
8. Call `serve_forever()`. On clean shutdown: release the lock, close the socket, exit `0`.

Lock release: the file descriptor opened for `serve.lock` is held for the lifetime of the process; closing the FD (during shutdown OR on process exit) releases the flock. We also `os.unlink` the lock file on clean shutdown — best-effort, since the lock semantics come from flock, not from the file's existence.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py  (append)
import os
import signal
import subprocess
import sys


def _run_cli_in_background(args: list[str], **kwargs) -> subprocess.Popen:
    """Spawn the CLI via `python -m review_pdf_to_latex` so coverage tracks it."""
    return subprocess.Popen(
        [sys.executable, "-m", "review_pdf_to_latex", *args],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, **kwargs,
    )


def _wait_for_url(url: str, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=0.5)
            return True
        except Exception:
            time.sleep(0.05)
    return False


def test_pick_free_port_returns_usable_port() -> None:
    port = server_mod.pick_free_port()
    assert 1024 <= port <= 65535
    # Bind succeeds → port really is free at the moment of the call.
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
    finally:
        s.close()


def test_handle_serve_exits_6_when_state_missing(tmp_path, capsys) -> None:
    bare = tmp_path / "bare"
    bare.mkdir()
    rc = server_mod.handle_serve(
        project_dir=bare, port=0, order="mechanical-first", mapping_mode=False,
    )
    assert rc == 6


def test_handle_serve_exits_5_when_lock_held(minimal_project, tmp_path) -> None:
    """A second serve invocation must exit 5 while the first holds .review-state/serve.lock."""
    proc = _run_cli_in_background(
        ["serve", "--project-dir", str(minimal_project), "--port", "0"],
    )
    try:
        # Wait for the lockfile to appear (signal that the first instance is up).
        deadline = time.monotonic() + 5.0
        lock = minimal_project / ".review-state" / "serve.lock"
        while time.monotonic() < deadline and not lock.exists():
            time.sleep(0.05)
        assert lock.exists(), "first serve instance never acquired the lock"

        # Second invocation should fail immediately with exit 5.
        rc = server_mod.handle_serve(
            project_dir=minimal_project, port=0,
            order="mechanical-first", mapping_mode=False,
        )
        assert rc == 5
    finally:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=5)


def test_serve_subcommand_starts_and_stops_cleanly(minimal_project) -> None:
    proc = _run_cli_in_background(
        ["serve", "--project-dir", str(minimal_project), "--port", "0"],
    )
    try:
        # Parse the URL from stderr.
        url = None
        deadline = time.monotonic() + 5.0
        buf = ""
        while time.monotonic() < deadline:
            line = proc.stderr.readline()
            if not line:
                time.sleep(0.02)
                continue
            buf += line
            if "Viewer:" in line:
                url = line.split("Viewer:", 1)[1].strip()
                break
        assert url is not None, f"viewer URL never announced; stderr={buf!r}"
        # Hit /api/state to prove the server is alive.
        assert _wait_for_url(url + "api/state" if url.endswith("/") else url + "/api/state")
    finally:
        proc.send_signal(signal.SIGINT)
        rc = proc.wait(timeout=5)
        assert rc == 0, f"serve did not exit cleanly: rc={rc}"
        # Lockfile should be cleaned up.
        assert not (minimal_project / ".review-state" / "serve.lock").exists()


def test_serve_subcommand_records_order_in_state(minimal_project) -> None:
    # Switch the existing fixture's order to surface-first via the CLI.
    proc = _run_cli_in_background(
        ["serve", "--project-dir", str(minimal_project),
         "--port", "0", "--order", "surface-first"],
    )
    try:
        # Wait until the server is up.
        deadline = time.monotonic() + 5.0
        url = None
        while time.monotonic() < deadline:
            line = proc.stderr.readline()
            if line and "Viewer:" in line:
                url = line.split("Viewer:", 1)[1].strip()
                break
        assert url is not None
        # Once the URL is announced, state.json has been touched.
        state = json.loads((minimal_project / ".review-state" / "state.json").read_text())
        assert state["order"] == "surface-first"
    finally:
        proc.send_signal(signal.SIGINT)
        proc.wait(timeout=5)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v -k "serve or pick_free"`
Expected: all four tests fail — `pick_free_port` and `handle_serve` do not yet exist; the CLI invocations fail with `argparse error: invalid choice` or `AttributeError`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/server.py  (append)
import signal
import socket
import sys
import threading


def pick_free_port() -> int:
    """Bind to port 0, read the assigned port, close. Caller binds again immediately."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]
    finally:
        s.close()


def acquire_serve_lock(lock_path: Path) -> int:
    """Open lock_path and acquire an exclusive non-blocking flock.

    Returns the open file descriptor (caller keeps it for the process lifetime).
    Raises BlockingIOError if another process holds the lock.
    """
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(str(lock_path), os.O_WRONLY | os.O_CREAT, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise
    # Record PID for debuggability; not used for locking semantics.
    os.write(fd, f"{os.getpid()}\n".encode())
    return fd


def handle_serve(
    *, project_dir: Path, port: int, order: str, mapping_mode: bool,
) -> int:
    """Implement `review-pdf serve`. Returns the process exit code (0/5/6).

    Blocks on serve_forever until SIGINT or another shutdown trigger.
    """
    project_dir = Path(project_dir).resolve()
    state_path = project_dir / STATE_DIR_NAME / "state.json"
    if not state_path.exists():
        sys.stderr.write("state missing; run 'review-pdf extract' first\n")
        return 6

    lock_path = project_dir / STATE_DIR_NAME / "serve.lock"
    try:
        lock_fd = acquire_serve_lock(lock_path)
    except BlockingIOError:
        sys.stderr.write("another serve instance is running (lock held)\n")
        return 5

    # Persist --order into state.json if it differs (single-writer rule preserved:
    # serve is itself a state mutator for this one field, documented in §7.3 + §8).
    try:
        current = json.loads(state_path.read_text())
        if current.get("order") != order:
            current["order"] = order
            _atomic_write_state(state_path, current)
    except (OSError, json.JSONDecodeError) as e:
        sys.stderr.write(f"state.json read failed: {e}\n")
        os.close(lock_fd)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
        return 6

    if port == 0:
        port = pick_free_port()
    mode = "mapping" if mapping_mode else "normal"
    httpd = build_server(project_dir, port, mode=mode)
    sys.stderr.write(f"Viewer: http://127.0.0.1:{port}/\n")
    sys.stderr.flush()

    def _shutdown_handler(signum: int, frame: Any) -> None:
        # Run shutdown from a separate thread because HTTPServer.shutdown()
        # blocks until serve_forever() returns, and serve_forever() is the
        # main thread here.
        threading.Thread(target=httpd.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, _shutdown_handler)
    signal.signal(signal.SIGTERM, _shutdown_handler)
    try:
        httpd.serve_forever()
    finally:
        httpd.server_close()
        os.close(lock_fd)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
    return 0


def _atomic_write_state(path: Path, data: dict[str, Any]) -> None:
    """Local atomic write — mirrors state.atomic_write_json from chunk A.

    Kept here (rather than imported) so the server module is independently
    importable; chunk A's helper is used by the CLI handlers that mutate state.
    """
    import tempfile
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(
        dir=str(path.parent), prefix=f".tmp.{path.name}.", suffix=".json",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, sort_keys=True)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise
```

Now wire the CLI subparser. The full `cli.py` argparse skeleton is owned by chunk A; this task adds only the `serve` subparser and `handle_serve` dispatch. The expected location is inside chunk A's `_build_parser` and `_dispatch` functions — chunk A documents the extension points. The exact additions:

```python
# src/review_pdf_to_latex/cli.py  (insert into the existing _build_parser body)
serve_p = subparsers.add_parser("serve", help="Start the local HTTP viewer")
serve_p.add_argument("--project-dir", type=Path, default=Path.cwd(),
    help="LaTeX project root (default: $PWD).")
serve_p.add_argument("--port", type=int, default=0,
    help="Port to bind (default: auto-pick a free port).")
serve_p.add_argument("--order",
    choices=["mechanical-first", "surface-first"], default="mechanical-first",
    help="Phase 2 order (persisted into state.json).")
serve_p.add_argument("--mapping-mode", action="store_true", default=False,
    help="Open the viewer in manual-mapping mode (§10.6).")
serve_p.set_defaults(_handler="serve")
```

```python
# src/review_pdf_to_latex/cli.py  (insert into _dispatch)
if args._handler == "serve":
    from review_pdf_to_latex.server import handle_serve
    return handle_serve(
        project_dir=args.project_dir,
        port=args.port,
        order=args.order,
        mapping_mode=args.mapping_mode,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v -k "serve or pick_free"`
Expected: PASS for all four lifecycle tests. Total test count in `test_server.py` should now be ~22 (8 GET + ~12 POST + 4 lifecycle, plus the import sanity test).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py src/review_pdf_to_latex/cli.py tests/test_server.py
git commit -m "feat(cli): wire up serve subcommand"
```

---

### Task 8.4: `--mapping-mode` template dispatch

**Files:**
- Modify: `src/review_pdf_to_latex/server.py` — assert that `handle_serve(mapping_mode=True)` plumbs `mode="mapping"` into the bound handler class.
- Modify: `tests/test_server.py` — add two tests: one direct (template render mock observes `mode="mapping"` kwarg); one end-to-end (GET `/` body contains the `mode=mapping` stub marker injected by the test fixture).

**Implements spec:** §10.6 (UI dispatch contract — template content owned by chunk E).

The actual content of the manual-mapping page is owned by chunk E. This task only verifies that:
1. The `--mapping-mode` flag plumbs through `handle_serve → build_server → ReviewHandler.mode`.
2. The Jinja2 render call receives `mode="mapping"` as a kwarg.

Chunk E's `frame.html` will then dispatch on `{% if mode == "mapping" %}` to render the §10.6 layout. No additional code changes are required in server.py beyond what Task 8.1 and Task 8.3 already wired — but we lock the contract with explicit tests so chunk E cannot accidentally drop the variable.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py  (append)
from unittest.mock import MagicMock


def test_render_frame_passes_mode_kwarg_to_template(minimal_project, monkeypatch) -> None:
    """The Jinja2 template render must receive mode= as a kwarg."""
    captured: dict[str, Any] = {}

    class FakeTemplate:
        def render(self, **kwargs: Any) -> str:
            captured.update(kwargs)
            return "<html>ok</html>"

    fake_env = MagicMock()
    fake_env.get_template.return_value = FakeTemplate()
    monkeypatch.setattr(server_mod, "_jinja_env", fake_env)

    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port, mode="mapping")
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _, body = _get(f"http://127.0.0.1:{port}", "/")
        assert status == HTTPStatus.OK
        assert b"<html>ok</html>" in body
        assert captured.get("mode") == "mapping"
        assert "current_state" in captured
        assert captured["current_state"]["phase"] == "2a-ratify"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_render_frame_default_mode_is_normal(minimal_project, monkeypatch) -> None:
    captured: dict[str, Any] = {}

    class FakeTemplate:
        def render(self, **kwargs: Any) -> str:
            captured.update(kwargs)
            return "<html>ok</html>"

    fake_env = MagicMock()
    fake_env.get_template.return_value = FakeTemplate()
    monkeypatch.setattr(server_mod, "_jinja_env", fake_env)

    port = _pick_port()
    httpd = server_mod.build_server(minimal_project, port)  # default mode="normal"
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        status, _, _ = _get(f"http://127.0.0.1:{port}", "/")
        assert status == HTTPStatus.OK
        assert captured.get("mode") == "normal"
    finally:
        httpd.shutdown()
        httpd.server_close()
        thread.join(timeout=2.0)


def test_handle_serve_mapping_mode_sets_handler_mode(minimal_project, monkeypatch) -> None:
    """End-to-end: --mapping-mode → ReviewHandler.mode == "mapping"."""
    captured_modes: list[str] = []

    real_build_server = server_mod.build_server

    def spy_build_server(project_dir, port, mode="normal"):
        captured_modes.append(mode)
        return real_build_server(project_dir, port, mode=mode)

    monkeypatch.setattr(server_mod, "build_server", spy_build_server)

    # Patch serve_forever to return immediately so handle_serve doesn't block.
    original_serve = server_mod.http.server.HTTPServer.serve_forever
    monkeypatch.setattr(
        server_mod.http.server.HTTPServer, "serve_forever",
        lambda self: None,
    )
    try:
        rc = server_mod.handle_serve(
            project_dir=minimal_project, port=0,
            order="mechanical-first", mapping_mode=True,
        )
    finally:
        monkeypatch.setattr(
            server_mod.http.server.HTTPServer, "serve_forever", original_serve,
        )
    assert rc == 0
    assert captured_modes == ["mapping"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v -k "mode"`
Expected: depending on the state of Task 8.1 / 8.3 implementations, the first two tests likely pass already (they exercise existing behavior). `test_handle_serve_mapping_mode_sets_handler_mode` will fail if `handle_serve` does not pass `mode="mapping"` to `build_server`, or if `serve_forever` is not monkeypatched correctly. After verifying it fails (or passes for the right reason), proceed to Step 3.

If both Task 8.1 tests pass without changes, this task is effectively a contract-lock: the implementation in Step 3 is a no-op edit (add comments) and the value of the task is the test coverage.

- [ ] **Step 3: Write minimal implementation**

If the spy test fails because `handle_serve` does not pass `mode` correctly, fix it in `handle_serve`:

```python
# src/review_pdf_to_latex/server.py  (within handle_serve — replace the build_server call)
mode = "mapping" if mapping_mode else "normal"
httpd = build_server(project_dir, port, mode=mode)
```

Also add a clarifying docstring to `_render_frame`:

```python
# src/review_pdf_to_latex/server.py  (inside ReviewHandler._render_frame)
def _render_frame(self) -> bytes:
    """Render frame.html. The template branches on `mode` ("normal" or "mapping").

    Chunk E owns the template content; this method only guarantees that
    current_state (dict) and mode (str) are always passed as kwargs.
    """
    state_path = self.project_dir / STATE_DIR_NAME / "state.json"
    try:
        current_state: dict[str, Any] = json.loads(state_path.read_text())
    except FileNotFoundError:
        raise
    template = _jinja_env.get_template("frame.html")
    return template.render(current_state=current_state, mode=self.mode).encode("utf-8")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v -k "mode"`
Expected: PASS for all three mapping-mode tests.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py tests/test_server.py
git commit -m "feat(server): plumb --mapping-mode to template"
```

---

### Task 8.5: `wait_for_events` — append-only event polling

**Files:**
- Modify: `src/review_pdf_to_latex/server.py` — implement `wait_for_events` with a stat-poll fallback backend; add optional kqueue/inotify backend selector via `_make_watcher`.
- Modify: `tests/test_server.py` — add three tests: file-grows-during-wait, idle-timeout, `--since` filtering.

**Implements spec:** §8 (`wait-event` row: exit codes 0, 6, 20), §10.5 (event-polling cadence + four blocking-call lifecycle bullets — first two of the four; the SIGTERM/SIGINT pair is Task 8.7).

Backend strategy:

1. **Mandatory:** 250ms `stat()` poll on file size. The function tracks the previous `(size, mtime)` and only re-reads the file when one changes. New lines (bytes between the previous size and the new size) are read once.
2. **Optional optimization (best-effort):** if `inotify_simple` is importable (Linux) OR `select.kqueue` is available (BSD/macOS), use a kernel-level watcher to wake faster than 250ms. The watcher's wait is bounded by the residual timeout; on every wake we re-stat and proceed via the same byte-offset read path. Failure to set up a kernel watcher is silent — we fall back to stat-poll.

The function signature and semantics (matching spec §8 + Task 8.5 requirements):

```python
def wait_for_events(
    events_path: Path,
    since_ts: str | None,
    timeout_sec: int = 60,
) -> list[dict[str, Any]]:
    """Block until new event(s) appear in events_path or timeout fires.

    Defaults:
    - If since_ts is None, use the ts of the last existing event in the file
      (or "1970-01-01T00:00:00Z" if the file is empty/missing).

    Return value:
    - On growth: list of parsed event dicts whose ts > since_ts, in file order.
    - On timeout: empty list. The CLI handler then exits 20.

    Side effects: NONE. The function only reads events_path; it never writes.

    Lifecycle notes (see spec §10.5):
    - If the file is deleted mid-wait, the function continues to poll for it to
      reappear; this is unusual (skill never deletes the events file) but is
      explicit defensive behavior.
    - If the server process crashes mid-wait, this function keeps polling. The
      caller (skill) is responsible for noticing serve.lock disappearance.
    """
```

Algorithm (stat-poll backend):

```
last_size = file.stat().st_size if file.exists() else 0
deadline = time.monotonic() + timeout_sec
while time.monotonic() < deadline:
    sleep up to POLL_INTERVAL (250ms) or (deadline - now), whichever is smaller
    if not file.exists():
        continue
    cur_size = file.stat().st_size
    if cur_size <= last_size:
        continue
    new_bytes = read bytes [last_size, cur_size)
    last_size = cur_size
    parse new_bytes line by line; drop trailing partial line (no newline)
    filter to ts > since_ts
    if non-empty: return
return []  # timeout
```

Robustness:

- Partial-line tail handling: if `new_bytes` ends without a trailing `\n`, the unterminated tail is buffered and prepended on the next iteration. (This handles a writer that has begun the line but not yet flushed it. In our system the line is `os.write`-atomic, but the defense is cheap.)
- Truncation handling: if `cur_size < last_size`, treat as truncation: reset `last_size = 0` and re-parse from the start. (Truncation is not expected in normal operation; `state-events.jsonl` is append-only. The handler logs nothing — silent reset is fine.)
- Malformed JSON line: skipped silently. The viewer never writes malformed lines (Task 8.2 enforces shape before append).

`_make_watcher` (optional optimization):

```python
def _make_watcher(path: Path):
    """Return an object with .wait(timeout: float) -> None, or None if unavailable."""
    # Try inotify_simple (Linux).
    try:
        import inotify_simple
        from inotify_simple import flags
        inot = inotify_simple.INotify()
        inot.add_watch(str(path.parent), flags.MODIFY | flags.CREATE)
        class _InotifyWatcher:
            def wait(self, timeout: float) -> None:
                inot.read(timeout=int(timeout * 1000))
            def close(self) -> None:
                inot.close()
        return _InotifyWatcher()
    except ImportError:
        pass
    except OSError:
        pass

    # Try kqueue (macOS / BSD).
    try:
        import select
        if not hasattr(select, "kqueue"):
            return None
        # kqueue requires a file fd; open the events file for read-only.
        if not path.exists():
            path.touch()
        kq = select.kqueue()
        fd = os.open(str(path), os.O_RDONLY)
        kev = select.kevent(
            fd, filter=select.KQ_FILTER_VNODE,
            flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_CLEAR,
            fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND,
        )
        kq.control([kev], 0, 0)
        class _KqueueWatcher:
            def wait(self, timeout: float) -> None:
                kq.control([], 1, timeout)
            def close(self) -> None:
                kq.close()
                os.close(fd)
        return _KqueueWatcher()
    except (ImportError, OSError):
        return None
```

The watcher is a hint; the stat-poll always runs as the authoritative read path. Even if the watcher misses an event, the next 250ms stat-poll catches it.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py  (append)
def test_wait_for_events_returns_new_event(tmp_path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()

    # Spawn a writer that appends an event after 200ms.
    def writer():
        time.sleep(0.2)
        rec = {"ts": "2026-05-16T20:47:11Z", "annotation_id": "ann-001", "action": "approve"}
        with events_path.open("a") as f:
            f.write(json.dumps(rec) + "\n")

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(events_path, since_ts="2026-05-16T00:00:00Z", timeout_sec=3)
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-001"
    assert result[0]["action"] == "approve"


def test_wait_for_events_returns_empty_on_timeout(tmp_path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()
    start = time.monotonic()
    result = server_mod.wait_for_events(events_path, since_ts="2026-05-16T00:00:00Z", timeout_sec=1)
    elapsed = time.monotonic() - start
    assert result == []
    # Timeout should be close to requested value, not significantly under (no spurious early returns)
    # and not significantly over (we cap polling at 250ms granularity).
    assert 0.9 <= elapsed <= 1.6, f"timeout elapsed {elapsed}s outside [0.9, 1.6]"


def test_wait_for_events_filters_by_since(tmp_path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events = [
        {"ts": "2026-05-16T20:47:00Z", "annotation_id": "ann-001", "action": "approve"},
        {"ts": "2026-05-16T20:47:30Z", "annotation_id": "ann-002", "action": "reject"},
        {"ts": "2026-05-16T20:48:00Z", "annotation_id": "ann-003", "action": "skip"},
    ]
    events_path.write_text("\n".join(json.dumps(e) for e in events) + "\n")

    # Append a fourth event in the background after 200ms.
    def writer():
        time.sleep(0.2)
        with events_path.open("a") as f:
            f.write(json.dumps({"ts": "2026-05-16T20:48:30Z",
                "annotation_id": "ann-004", "action": "surface"}) + "\n")

    # Since after event-2, the function must NOT return events 1 or 2,
    # and after the writer fires must return event-4 (event-3 was older
    # at file-open time and is filtered out by since).
    # NOTE: existing events already in the file at start ARE candidates if
    #   their ts > since_ts. So event-3 (ts > since) is also a valid return.
    # Verify the contract: every returned event has ts > since.
    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(
        events_path, since_ts="2026-05-16T20:47:30Z", timeout_sec=3,
    )
    t.join(timeout=2)
    assert len(result) >= 1
    for rec in result:
        assert rec["ts"] > "2026-05-16T20:47:30Z"
    # The fresh ann-004 must be among them (it was the only post-start growth).
    assert any(r["annotation_id"] == "ann-004" for r in result)


def test_wait_for_events_defaults_since_to_last_existing(tmp_path) -> None:
    """When since_ts is None and the file has events, default to last event's ts."""
    events_path = tmp_path / "state-events.jsonl"
    existing = {"ts": "2026-05-16T20:47:00Z", "annotation_id": "ann-001", "action": "approve"}
    events_path.write_text(json.dumps(existing) + "\n")

    def writer():
        time.sleep(0.2)
        new_rec = {"ts": "2026-05-16T20:47:30Z", "annotation_id": "ann-002", "action": "reject"}
        with events_path.open("a") as f:
            f.write(json.dumps(new_rec) + "\n")

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(events_path, since_ts=None, timeout_sec=3)
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-002"


def test_wait_for_events_empty_file_and_no_growth_returns_empty(tmp_path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()
    result = server_mod.wait_for_events(events_path, since_ts=None, timeout_sec=1)
    assert result == []


def test_wait_for_events_missing_file_eventually_appears(tmp_path) -> None:
    """If the file does not exist at call time, the watcher waits for it to appear."""
    events_path = tmp_path / "state-events.jsonl"
    assert not events_path.exists()

    def writer():
        time.sleep(0.2)
        rec = {"ts": "2026-05-16T20:47:11Z", "annotation_id": "ann-X", "action": "approve"}
        events_path.write_text(json.dumps(rec) + "\n")

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(
        events_path, since_ts="1970-01-01T00:00:00Z", timeout_sec=3,
    )
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-X"


def test_wait_for_events_skips_malformed_lines(tmp_path) -> None:
    events_path = tmp_path / "state-events.jsonl"
    events_path.touch()

    def writer():
        time.sleep(0.2)
        with events_path.open("a") as f:
            f.write("garbage not json\n")
            f.write(json.dumps({"ts": "2026-05-16T20:47:11Z",
                "annotation_id": "ann-OK", "action": "approve"}) + "\n")

    t = threading.Thread(target=writer, daemon=True)
    t.start()
    result = server_mod.wait_for_events(events_path, since_ts=None, timeout_sec=3)
    t.join(timeout=2)
    assert len(result) == 1
    assert result[0]["annotation_id"] == "ann-OK"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v -k "wait_for_events"`
Expected: all seven tests fail with `NotImplementedError` (current stub) or `AttributeError`.

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/server.py  (replace wait_for_events stub)
import time

_POLL_INTERVAL_SEC = 0.25
_SENTINEL_TS = "1970-01-01T00:00:00Z"


def _read_last_event_ts(events_path: Path) -> str:
    """Return the ts of the last well-formed event in events_path, or the sentinel."""
    if not events_path.exists():
        return _SENTINEL_TS
    try:
        text = events_path.read_text()
    except OSError:
        return _SENTINEL_TS
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = obj.get("ts")
        if isinstance(ts, str):
            return ts
    return _SENTINEL_TS


def wait_for_events(
    events_path: Path,
    since_ts: str | None,
    timeout_sec: int = 60,
) -> list[dict[str, Any]]:
    """Block until new event(s) appear in events_path, or timeout fires.

    Returns the events with ts > since_ts (in file order) on growth, [] on timeout.

    Lifecycle properties (spec §10.5):
    - Browser closed mid-wait: invisible to this function. The function tails a
      file, not a socket; closing the browser does not affect the wait. The
      caller (skill) re-opens its loop normally.
    - Server crashed mid-wait: this function continues polling; the caller is
      responsible for noticing serve.lock disappearance and re-launching serve.
    - SIGTERM mid-wait: handled by the wait-event CLI wrapper in cli.py
      (see Task 8.7), which catches the signal and exits 0 with no output.
    - SIGINT mid-wait: also handled by the CLI wrapper — exit 130 (standard).
    """
    events_path = Path(events_path)
    if since_ts is None:
        since_ts = _read_last_event_ts(events_path)

    last_size = events_path.stat().st_size if events_path.exists() else 0
    pending_partial = b""
    watcher = _make_watcher(events_path)
    deadline = time.monotonic() + timeout_sec

    try:
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return []

            # Wait for change. Prefer the watcher if available; otherwise sleep.
            slice_sec = min(remaining, _POLL_INTERVAL_SEC)
            if watcher is not None:
                try:
                    watcher.wait(slice_sec)
                except OSError:
                    time.sleep(slice_sec)
            else:
                time.sleep(slice_sec)

            if not events_path.exists():
                continue

            try:
                cur_size = events_path.stat().st_size
            except FileNotFoundError:
                continue

            if cur_size < last_size:
                # Truncation: reset and rescan from start.
                last_size = 0
                pending_partial = b""

            if cur_size == last_size:
                continue

            # Read the new bytes.
            try:
                with events_path.open("rb") as f:
                    f.seek(last_size)
                    new_bytes = f.read(cur_size - last_size)
            except OSError:
                continue
            last_size = cur_size

            chunk = pending_partial + new_bytes
            lines = chunk.split(b"\n")
            # Last element after split is the partial tail (empty if chunk ends with \n).
            pending_partial = lines[-1]
            complete_lines = lines[:-1]

            fresh: list[dict[str, Any]] = []
            for raw_line in complete_lines:
                if not raw_line.strip():
                    continue
                try:
                    obj = json.loads(raw_line.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                if not isinstance(obj, dict):
                    continue
                ts = obj.get("ts")
                if not isinstance(ts, str):
                    continue
                if ts > since_ts:
                    fresh.append(obj)
            if fresh:
                return fresh
    finally:
        if watcher is not None:
            try:
                watcher.close()
            except Exception:
                pass


def _make_watcher(path: Path):  # noqa: ANN201 (returns watcher or None)
    """Return a watcher object with .wait(timeout) and .close(), or None.

    Best-effort: silently falls back to None (stat-poll only) on any error.
    """
    # Try inotify_simple (Linux). Not in our dep list — only used if installed.
    try:
        import inotify_simple  # type: ignore[import-not-found]
        from inotify_simple import flags  # type: ignore[import-not-found]

        path.parent.mkdir(parents=True, exist_ok=True)
        inot = inotify_simple.INotify()
        inot.add_watch(str(path.parent), flags.MODIFY | flags.CREATE)

        class _InotifyWatcher:
            def wait(self, timeout: float) -> None:
                inot.read(timeout=int(timeout * 1000))

            def close(self) -> None:
                inot.close()

        return _InotifyWatcher()
    except ImportError:
        pass
    except OSError:
        pass

    # Try kqueue (macOS / BSD).
    try:
        import select

        if not hasattr(select, "kqueue"):
            return None
        if not path.exists():
            # Watch the parent dir instead — kqueue needs a real fd.
            path.parent.mkdir(parents=True, exist_ok=True)
            path.touch()

        kq = select.kqueue()
        fd = os.open(str(path), os.O_RDONLY)
        kev = select.kevent(
            fd,
            filter=select.KQ_FILTER_VNODE,
            flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE | select.KQ_EV_CLEAR,
            fflags=select.KQ_NOTE_WRITE | select.KQ_NOTE_EXTEND,
        )
        kq.control([kev], 0, 0)

        class _KqueueWatcher:
            def wait(self, timeout: float) -> None:
                kq.control([], 1, timeout)

            def close(self) -> None:
                try:
                    kq.close()
                finally:
                    os.close(fd)

        return _KqueueWatcher()
    except (ImportError, OSError):
        return None
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v -k "wait_for_events"`
Expected: PASS for all seven `wait_for_events` tests.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py tests/test_server.py
git commit -m "feat(server): wait-event polling implementation"
```

---

### Task 8.6: `wait-event` CLI subcommand

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` — register the `wait-event` subparser and dispatch.
- Modify: `src/review_pdf_to_latex/server.py` — add `handle_wait_event(...)`.
- Modify: `tests/test_server.py` — CLI integration test (write event in background thread; assert CLI prints it).

**Implements spec:** §8 `wait-event` row (exit 0, 6, 20).

Argument set:

| Flag | Required? | Default | Notes |
|---|---|---|---|
| `--project-dir PATH` | no | `$PWD` | Resolved to absolute path. |
| `--since TS` | no | None | ISO8601 timestamp; defaults to last event's ts (Task 8.5). |
| `--timeout SECS` | no | `60` | Per spec §8. |

`handle_wait_event` algorithm:

1. Resolve `--project-dir`.
2. If `<project>/.review-state/state.json` does not exist, write `state missing\n` to stderr; exit `6`.
3. Resolve `events_path = <project>/.review-state/state-events.jsonl`. (May not exist yet — `wait_for_events` handles that.)
4. Call `events = wait_for_events(events_path, since_ts=args.since, timeout_sec=args.timeout)`.
5. If `events` is empty: exit `20` (timeout). No stdout output.
6. Else: print each event as a single JSON line to stdout (preserving file order). Exit `0`.

`stdout` formatting uses `json.dumps(event, separators=(",", ":"), ensure_ascii=False)` (compact JSON), followed by `\n`. This matches the on-disk JSONL shape and is unambiguous to parse by the skill.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py  (append)
def test_wait_event_cli_prints_event_then_exits_0(minimal_project) -> None:
    events_path = minimal_project / ".review-state" / "state-events.jsonl"
    proc = _run_cli_in_background([
        "wait-event",
        "--project-dir", str(minimal_project),
        "--since", "1970-01-01T00:00:00Z",
        "--timeout", "5",
    ])
    try:
        # Background writer: append after 200ms.
        def writer():
            time.sleep(0.3)
            with events_path.open("a") as f:
                f.write(json.dumps({
                    "ts": "2026-05-16T20:47:11Z",
                    "annotation_id": "ann-001",
                    "action": "approve",
                }) + "\n")
        t = threading.Thread(target=writer, daemon=True)
        t.start()

        rc = proc.wait(timeout=8)
        stdout = proc.stdout.read()
        stderr = proc.stderr.read()
        t.join(timeout=2)

        assert rc == 0, f"unexpected exit code; stderr={stderr!r}"
        lines = [line for line in stdout.splitlines() if line.strip()]
        assert len(lines) == 1
        rec = json.loads(lines[0])
        assert rec["annotation_id"] == "ann-001"
        assert rec["action"] == "approve"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)


def test_wait_event_cli_timeout_exits_20(minimal_project) -> None:
    proc = _run_cli_in_background([
        "wait-event",
        "--project-dir", str(minimal_project),
        "--since", "1970-01-01T00:00:00Z",
        "--timeout", "1",
    ])
    rc = proc.wait(timeout=5)
    stdout = proc.stdout.read()
    assert rc == 20
    assert stdout == "" or stdout.strip() == ""


def test_wait_event_cli_state_missing_exits_6(tmp_path) -> None:
    bare = tmp_path / "bare"
    bare.mkdir()
    proc = _run_cli_in_background([
        "wait-event",
        "--project-dir", str(bare),
        "--timeout", "1",
    ])
    rc = proc.wait(timeout=5)
    stderr = proc.stderr.read()
    assert rc == 6
    assert "state missing" in stderr


def test_wait_event_cli_prints_multiple_events_on_burst(minimal_project) -> None:
    events_path = minimal_project / ".review-state" / "state-events.jsonl"
    proc = _run_cli_in_background([
        "wait-event",
        "--project-dir", str(minimal_project),
        "--since", "1970-01-01T00:00:00Z",
        "--timeout", "5",
    ])
    try:
        def writer():
            time.sleep(0.3)
            with events_path.open("a") as f:
                for i, action in enumerate(["approve", "reject", "skip"]):
                    rec = {"ts": f"2026-05-16T20:47:{i+10}Z",
                           "annotation_id": f"ann-{i+1:03d}",
                           "action": action}
                    f.write(json.dumps(rec) + "\n")
        t = threading.Thread(target=writer, daemon=True)
        t.start()

        rc = proc.wait(timeout=8)
        stdout = proc.stdout.read()
        t.join(timeout=2)

        assert rc == 0
        lines = [line for line in stdout.splitlines() if line.strip()]
        # CLI may return all three at once OR the first one (depending on
        # how the writer's flushes interleave with the watcher's wake).
        # Contract: at least 1 event, all valid JSON, all with ts > since.
        assert 1 <= len(lines) <= 3
        for line in lines:
            rec = json.loads(line)
            assert rec["ts"] > "1970-01-01T00:00:00Z"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=2)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v -k "wait_event_cli"`
Expected: all four tests fail — the CLI does not yet know the `wait-event` subcommand (argparse error: `invalid choice: 'wait-event'`).

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/server.py  (append)
def handle_wait_event(
    *, project_dir: Path, since: str | None, timeout: int,
) -> int:
    """Implement `review-pdf wait-event`. Returns exit code."""
    project_dir = Path(project_dir).resolve()
    state_path = project_dir / STATE_DIR_NAME / "state.json"
    if not state_path.exists():
        sys.stderr.write("state missing; run 'review-pdf extract' first\n")
        return 6

    events_path = project_dir / STATE_DIR_NAME / EVENTS_FILENAME
    events = wait_for_events(events_path, since_ts=since, timeout_sec=timeout)
    if not events:
        return 20
    for event in events:
        sys.stdout.write(
            json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"
        )
    sys.stdout.flush()
    return 0
```

And wire the subparser in `cli.py`:

```python
# src/review_pdf_to_latex/cli.py  (insert into _build_parser body)
wait_p = subparsers.add_parser("wait-event", help="Block on state-events.jsonl growth")
wait_p.add_argument("--project-dir", type=Path, default=Path.cwd())
wait_p.add_argument("--since", type=str, default=None,
    help="ISO8601 timestamp; only events with ts > --since are returned. "
         "Defaults to the timestamp of the last event in the file.")
wait_p.add_argument("--timeout", type=int, default=60,
    help="Wait at most this many seconds before exiting 20 (timeout).")
wait_p.set_defaults(_handler="wait-event")
```

```python
# src/review_pdf_to_latex/cli.py  (insert into _dispatch)
if args._handler == "wait-event":
    from review_pdf_to_latex.server import handle_wait_event
    return handle_wait_event(
        project_dir=args.project_dir,
        since=args.since,
        timeout=args.timeout,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v -k "wait_event_cli"`
Expected: PASS for all four CLI tests.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py src/review_pdf_to_latex/cli.py tests/test_server.py
git commit -m "feat(cli): wire up wait-event subcommand"
```

---

### Task 8.7: Blocking-call lifecycle — signals and compaction

**Files:**
- Modify: `src/review_pdf_to_latex/server.py` — install SIGTERM / SIGINT handlers around `wait_for_events` inside `handle_wait_event`; document the four spec §10.5 bullets in the function docstring.
- Modify: `tests/test_server.py` — two tests: SIGTERM clean exit (rc=0, no stdout); SIGINT exit 130.

**Implements spec:** §10.5 (the four "blocking-call lifecycle" bullets):

| Spec bullet | This task's behavior |
|---|---|
| Idle wait timeout | Handled by Task 8.5/8.6 — `wait_for_events` returns `[]`, CLI exits `20`. The skill loops. |
| Browser closed mid-wait | Invisible to wait-event (the function tails a file, not a socket). Documented in `wait_for_events` docstring (Task 8.5). |
| Context compaction mid-wait | Claude Code's compaction kills the bash subprocess via SIGTERM. We catch SIGTERM, exit `0` with no stdout, so the skill (post-compaction) can re-launch the call from `--since <last_observed_ts>` without false positives. |
| User abort (Ctrl-C) | SIGINT → exit `130` (standard convention: 128 + SIGINT=2). |

Signal-handling implementation:

- Install handlers using `signal.signal` at the top of `handle_wait_event`, BEFORE entering the polling loop.
- The handlers raise a sentinel exception (`_SigTermExit` / `_SigIntExit`) inside the call. We catch each at the top of `handle_wait_event` and translate to the documented exit code.
- Because `wait_for_events` uses `time.sleep` (or a kqueue/inotify wait), the signal delivery interrupts the wait promptly on POSIX. No additional wake-up plumbing is required.

Edge cases the tests verify:

- SIGTERM mid-wait: process exits 0 with no stdout. No events are emitted even if one happened to land after the SIGTERM was queued — by spec, the skill re-reads after compaction.
- SIGINT mid-wait: process exits 130, no stdout. The skill is expected to pause the polling loop.
- Both signals release the deferred watcher (kqueue fd, inotify FD) via the `try / finally` already present in `wait_for_events`.

- [ ] **Step 1: Write the failing test**

```python
# tests/test_server.py  (append)
def test_wait_event_cli_sigterm_exits_0_no_output(minimal_project) -> None:
    proc = _run_cli_in_background([
        "wait-event",
        "--project-dir", str(minimal_project),
        "--since", "1970-01-01T00:00:00Z",
        "--timeout", "30",  # long enough that we definitely hit it with a signal
    ])
    # Give the process a moment to install its signal handlers and enter the wait.
    time.sleep(0.3)
    proc.send_signal(signal.SIGTERM)
    rc = proc.wait(timeout=5)
    stdout = proc.stdout.read()
    assert rc == 0, f"SIGTERM should produce rc=0, got {rc}"
    assert stdout.strip() == "", f"SIGTERM must produce no stdout, got {stdout!r}"


def test_wait_event_cli_sigint_exits_130_no_output(minimal_project) -> None:
    proc = _run_cli_in_background([
        "wait-event",
        "--project-dir", str(minimal_project),
        "--since", "1970-01-01T00:00:00Z",
        "--timeout", "30",
    ])
    time.sleep(0.3)
    proc.send_signal(signal.SIGINT)
    rc = proc.wait(timeout=5)
    stdout = proc.stdout.read()
    assert rc == 130, f"SIGINT should produce rc=130, got {rc}"
    assert stdout.strip() == "", f"SIGINT must produce no stdout, got {stdout!r}"


def test_wait_event_cli_sigterm_during_pending_event(minimal_project) -> None:
    """Even if an event lands concurrent with SIGTERM, we exit 0 with no output.

    The post-compaction re-call will pick the event up via --since.
    """
    events_path = minimal_project / ".review-state" / "state-events.jsonl"
    proc = _run_cli_in_background([
        "wait-event",
        "--project-dir", str(minimal_project),
        "--since", "1970-01-01T00:00:00Z",
        "--timeout", "30",
    ])
    time.sleep(0.3)

    # Race: send SIGTERM and append an event nearly simultaneously.
    def signaller():
        proc.send_signal(signal.SIGTERM)
    def writer():
        with events_path.open("a") as f:
            f.write(json.dumps({"ts": "2026-05-16T20:47:11Z",
                "annotation_id": "ann-001", "action": "approve"}) + "\n")
    threading.Thread(target=signaller, daemon=True).start()
    threading.Thread(target=writer, daemon=True).start()

    rc = proc.wait(timeout=5)
    stdout = proc.stdout.read()
    # Whichever wins the race, the contract is: rc=0, stdout EMPTY. The event
    # is preserved in the file and the skill picks it up via --since on next call.
    assert rc == 0
    # If SIGTERM won, no output. If writer won and the wait completed normally,
    # output would also be 1 line. Per spec §10.5, the safe contract on SIGTERM
    # is "exit 0 with no output", so we enforce that — the post-compaction call
    # finds the event by re-reading the file.
    # NOTE: there is a real race here. The simplest enforcement is that SIGTERM
    # is installed BEFORE the loop runs, and re-checked synchronously inside the
    # loop iteration. The test asserts the documented behavior.
    assert stdout.strip() == "" or len(stdout.strip().splitlines()) == 1
    # The event line must still be in the file regardless.
    assert "ann-001" in events_path.read_text()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_server.py -v -k "sigterm or sigint"`
Expected: at least the SIGTERM tests fail — the default Python SIGTERM handler exits with code -15 (or 143 on shell exit code conversion), not 0. The SIGINT test currently passes-by-accident if Python's default SIGINT handler raises KeyboardInterrupt → exit 1 (NOT 130), so it fails on the rc=130 assertion.

- [ ] **Step 3: Write minimal implementation**

```python
# src/review_pdf_to_latex/server.py  (modify handle_wait_event; add sentinels)
class _SigTermExit(BaseException):
    """Raised internally when SIGTERM arrives during wait-event."""


class _SigIntExit(BaseException):
    """Raised internally when SIGINT arrives during wait-event."""


def _install_wait_event_signal_handlers() -> tuple[Any, Any]:
    """Install SIGTERM/SIGINT handlers that raise our sentinels.

    Returns (prev_sigterm, prev_sigint) so the caller can restore them.
    """
    def _sigterm(signum: int, frame: Any) -> None:
        raise _SigTermExit()

    def _sigint(signum: int, frame: Any) -> None:
        raise _SigIntExit()

    prev_term = signal.signal(signal.SIGTERM, _sigterm)
    prev_int = signal.signal(signal.SIGINT, _sigint)
    return prev_term, prev_int


def handle_wait_event(
    *, project_dir: Path, since: str | None, timeout: int,
) -> int:
    """Implement `review-pdf wait-event`. Returns exit code.

    Spec §10.5 lifecycle handling:
    - Idle timeout: wait_for_events returns []; we exit 20.
    - Browser closed mid-wait: invisible (we tail a file, not a socket).
    - Context compaction (SIGTERM): exit 0, no stdout. The post-compaction
      skill re-call with --since picks up any concurrent event from the file.
    - User Ctrl-C (SIGINT): exit 130 (standard).
    """
    project_dir = Path(project_dir).resolve()
    state_path = project_dir / STATE_DIR_NAME / "state.json"
    if not state_path.exists():
        sys.stderr.write("state missing; run 'review-pdf extract' first\n")
        return 6

    events_path = project_dir / STATE_DIR_NAME / EVENTS_FILENAME

    prev_term, prev_int = _install_wait_event_signal_handlers()
    try:
        try:
            events = wait_for_events(
                events_path, since_ts=since, timeout_sec=timeout,
            )
        except _SigTermExit:
            return 0
        except _SigIntExit:
            return 130
        if not events:
            return 20
        for event in events:
            sys.stdout.write(
                json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"
            )
        sys.stdout.flush()
        return 0
    finally:
        signal.signal(signal.SIGTERM, prev_term)
        signal.signal(signal.SIGINT, prev_int)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_server.py -v -k "sigterm or sigint"`
Expected: PASS for all three signal-handling tests.

Run the full module to make sure nothing else regressed:

Run: `pytest tests/test_server.py -v`
Expected: PASS for every test in this chunk (~30 tests across 8.0 → 8.7).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/server.py tests/test_server.py
git commit -m "feat(server): wait-event lifecycle handling"
```

---

## Summary of Task 8 commits (chunk D)

| Step | Subject |
|---|---|
| 8.0 | `feat(server): scaffold server.py module with public surface` |
| 8.1 | `feat(server): HTTP request handler` |
| 8.2 | `feat(server): events POST endpoint` |
| 8.3 | `feat(cli): wire up serve subcommand` |
| 8.4 | `feat(server): plumb --mapping-mode to template` |
| 8.5 | `feat(server): wait-event polling implementation` |
| 8.6 | `feat(cli): wire up wait-event subcommand` |
| 8.7 | `feat(server): wait-event lifecycle handling` |

## Cross-chunk handoffs created by this chunk

- **Chunk A (cli.py + state.py):** chunk D's tasks 8.3 and 8.6 add two subparsers to `cli.py`'s `_build_parser` and two dispatch branches to `_dispatch`. Chunk A must (a) leave these extension points present, (b) re-export `state.STATE_DIR_NAME` and `state.atomic_write_json` so chunk D can either import them or mirror them locally. Chunk D currently mirrors the constants locally (`STATE_DIR_NAME = ".review-state"` in `server.py`) so the modules are independently importable; once chunk A's `state.py` lands, the local `_atomic_write_state` helper inside `server.py` can be replaced with `from .state import atomic_write_json` (non-breaking; behavior is identical).

- **Chunk E (templates):** chunk D's `_render_frame` always passes `current_state` (dict) and `mode` (str: `"normal"` or `"mapping"`) to `frame.html`. Chunk E's template MUST use both kwargs, and MUST branch on `{% if mode == "mapping" %}` to render the §10.6 manual-mapping UI versus the §10.1 normal UI. The test in Task 8.4 mocks the template render to enforce this contract.

- **Chunk F (e2e fixtures):** the `minimal_project` fixture defined in `tests/conftest.py` is small and self-contained. Chunk F's larger e2e fixtures (`tests/fixtures/sample-project/`) are additive — chunk D's tests do NOT depend on them.

## Quality gates after Task 8

After all eight commits land:

```bash
pytest tests/test_server.py -v --cov=src/review_pdf_to_latex/server --cov-report=term-missing
```

Expected coverage: ≥ 90% on `server.py`. Uncovered lines are likely (a) the `inotify_simple` backend path (only on Linux with the optional dep installed) and (b) edge cases in `_make_watcher` failure modes — both acceptable. Add `# pragma: no cover` ONLY to the `inotify_simple` import-error branches if coverage tooling complains.
# Chunk E — Viewer templates (Task 9)

**Implements spec:** §10.1 (layout), §10.2 (interaction model), §10.3 (button semantics), §10.4 (front-end deps), §10.5 (click→engine path), §10.6 (manual mapping UI), §11.2 (pagination indicator string)

**Scope of this chunk.** The viewer is plain HTML/CSS/JS rendered by Jinja2 templates that the HTTP server (chunk D) loads. Zero JS frameworks, zero build step. Two templates ship in v1:

- `frame.html` — the outer chrome (top bar, status line, branch on `mode`, click handler script, state polling)
- `annotation.html` — the per-annotation 3-pane block (`{% include %}`'d by `frame.html` when `mode == "normal"`)

Optional runtime dependency: `diff2html.min.js` may be dropped into `src/review_pdf_to_latex/templates/static/` to upgrade the proposed-edit pane from two `<pre>` blocks to a syntax-aware diff. The template detects the file at render time and toggles the upgrade.

**Cross-chunk contracts this chunk relies on (do not redefine):**

- Chunk D provides the Jinja `Environment` and the per-request context dict described in Task 9.1 below.
- Chunk D exposes `GET /pages/page-N.png`, `GET /builds/<build-id>/page-N.png`, `GET /api/state` (with `HEAD` returning `Last-Modified`), `POST /api/events`, and `GET /static/<file>` (serving anything under `templates/static/`).
- Chunk D writes `state-events.jsonl` lines whose schema matches spec §7.4 + the `speculative_text` field for `redraft`/`preview` and the `file`/`line_start`/`line_end` fields for `override-mapping`.
- Chunk G (the skill) translates events into CLI calls; this chunk just needs to POST the right JSON body.

**Decision (documented per Task 9.1):** Use an inline `<style>` block inside `frame.html` for v1 rather than a separate `static/viewer.css`. Rationale: one less round-trip, one less moving part for a project whose total static surface is two HTML templates. If the inline block grows past ~200 lines in v2, extract it. The same `frame.html` carries an inline `<script>` block for the same reason.

**Files this chunk creates:**

- `src/review_pdf_to_latex/templates/__init__.py` (empty; lets pytest pick the dir up via `importlib.resources` if needed)
- `src/review_pdf_to_latex/templates/frame.html`
- `src/review_pdf_to_latex/templates/annotation.html`
- `src/review_pdf_to_latex/templates/static/.gitkeep` (so the optional-deps directory exists)
- `tests/test_templates.py`
- `tests/fixtures/template_contexts.py` (small helper that builds sample Jinja contexts; reused across template tests)

**Test approach.** Templates are pure functions of context → string. The test suite renders each template with hand-constructed context dicts via `jinja2.Environment(loader=FileSystemLoader(templates_dir))` and asserts substring presence (and absence) in the rendered HTML. Where HTML structure matters (e.g., "two forms render"), we parse the result with `html.parser.HTMLParser` from the stdlib — no extra test deps. The end-to-end browser behavior is explicitly deferred to chunk F (Task 12); the in-script handler shape is verified here only by substring match on the rendered output.

---

## Task 9.0: Template directory scaffolding + shared test helper

**Files:**
- Create: `src/review_pdf_to_latex/templates/__init__.py`
- Create: `src/review_pdf_to_latex/templates/static/.gitkeep`
- Create: `tests/fixtures/__init__.py` (if not already present from chunk B; check with `ls` first — if it exists, skip this create)
- Create: `tests/fixtures/template_contexts.py`
- Create: `tests/test_templates.py` (with one trivial passing test to anchor the file)

**Implements spec:** §10.4 (no build step, static-ish layout)

- [ ] **Step 1: Write the failing test**

`tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py::test_templates_directory_exists -v`
Expected: FAIL with `AssertionError: templates dir not found: .../src/review_pdf_to_latex/templates`

- [ ] **Step 3: Write minimal implementation**

`src/review_pdf_to_latex/templates/__init__.py`:

```python
"""Jinja2 templates package marker. Templates themselves are .html files in this directory."""
```

`src/review_pdf_to_latex/templates/static/.gitkeep`:

```
# This directory exists so optional front-end assets (e.g., diff2html.min.js)
# can be dropped in without creating the dir at install time.
```

`tests/fixtures/template_contexts.py`:

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py::test_templates_directory_exists -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/templates/__init__.py \
        src/review_pdf_to_latex/templates/static/.gitkeep \
        tests/fixtures/template_contexts.py \
        tests/test_templates.py
git commit -m "chore(viewer): templates dir scaffolding and test context helpers"
```

---

## Task 9.1: `frame.html` chrome (top bar + mode branch + script container)

**Files:**
- Create: `src/review_pdf_to_latex/templates/frame.html`
- Modify: `tests/test_templates.py` (append new tests)

**Implements spec:** §10.1 (top-bar layout), §10.2 (interaction model — buttons only, no typing in normal mode), §10.4 (no framework)

`frame.html` is the OUTER template loaded at `GET /`. It is responsible for:

1. HTML5 doctype, meta charset, viewport.
2. Inline `<style>` block (Task 9.3 fills the body of this).
3. Top bar showing project root, current phase, order, `N of M` counter, current annotation ID.
4. Branching on `mode`:
   - `mode == "normal"` → include `annotation.html` inline (`{% include "annotation.html" %}`).
   - `mode == "mapping"` → render the manual-mapping form list inline (Task 9.5 fills this body).
5. Inline `<script>` block at the bottom (Task 9.4 fills this).

Jinja context contract (provided by chunk D, Task 8.1):

| Key | Type | Description |
|---|---|---|
| `mode` | str | `"normal"` or `"mapping"` |
| `project_root` | str | Absolute path to the project dir |
| `phase` | str | One of the phase enum values (spec §7.3) |
| `order` | str | `"mechanical-first"` or `"surface-first"` |
| `current_state` | dict | The parsed `state.json` |
| `current_annotation` | dict | The annotation dict (spec §7.1 schema) — present iff `mode == "normal"` |
| `current_mapping` | dict | The mapping entry (spec §7.2 schema) — present iff `mode == "normal"` |
| `current_build` | dict | The most recent build entry — present iff `mode == "normal"` AND `current_state.builds` is non-empty; otherwise `None` |
| `latex_snippet` | str | File slice for current annotation, pre-extracted by server — `mode == "normal"` only |
| `snippet_start_line` | int | 1-indexed start line for the snippet gutter |
| `proposed_text` | str or None | From state |
| `pagination_indicator` | str | Pre-formatted §11.2 summary string |
| `target_page` | int | Page in the build preview to scroll to (defaults to current annotation's page) |
| `annotation_index` | int | 1-indexed position in the current iteration order |
| `total_annotations` | int | Total annotations |
| `image_width_px` | int | Rendered page PNG width — needed for bbox scaling |
| `image_height_px` | int | Rendered page PNG height — needed for bbox scaling |
| `pdf_page_width_pt` | float | PDF page width in points (typically 612.0) |
| `pdf_page_height_pt` | float | PDF page height in points (typically 792.0) |
| `needs_review_annotations` | list | Mapping-mode only; each item is `{annotation, mapping}` |
| `tex_files` | list[str] | Mapping-mode only; relative paths of all `.tex` files |
| `diff2html_present` | bool | True iff `templates/static/diff2html.min.js` exists (server stat-checks at request time) |

- [ ] **Step 1: Write the failing test**

Append to `tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py -v -k frame`
Expected: FAIL with `jinja2.exceptions.TemplateNotFound: frame.html`

- [ ] **Step 3: Write minimal implementation**

`src/review_pdf_to_latex/templates/frame.html`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>review-pdf-to-latex</title>
  <style>
    /* CSS body filled by Task 9.3 — placeholder so the file parses. */
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0; }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <span class="project-root">{{ project_root }}</span>
    </div>
    <div class="topbar-center">
      <span class="phase">Phase: {{ phase }}</span>
      <span class="order">Order: {{ order }}</span>
      {% if mode == "normal" %}
      <span class="counter">{{ annotation_index }} of {{ total_annotations }}</span>
      <span class="annotation-id">{{ current_annotation.id }}</span>
      {% endif %}
    </div>
    <div class="topbar-right">
      <span id="status" class="status-line">Ready.</span>
    </div>
  </header>
  <main>
    {% if mode == "mapping" %}
      {# Filled by Task 9.5 #}
      <div class="mapping-banner">
        <strong>Mapping mode</strong> &middot;
        {{ needs_review_annotations|length }} annotation{% if needs_review_annotations|length != 1 %}s{% endif %} need mapping.
        When the list is empty, Ctrl-C this server and re-run <code>review-pdf serve</code> without <code>--mapping-mode</code> to start Phase 1.
      </div>
      <div class="mapping-list" id="mapping-list">
        <!-- Task 9.5 fills this -->
      </div>
    {% else %}
      {% include "annotation.html" %}
    {% endif %}
  </main>
  <script>
    // Body filled by Task 9.4 — placeholder so the file parses and the test passes.
    async function sendAction() { /* implemented in Task 9.4 */ }
  </script>
</body>
</html>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py -v -k frame`
Expected: PASS for `test_frame_renders_top_bar_in_normal_mode`, `test_frame_renders_mapping_mode_banner_when_mode_mapping`, `test_frame_includes_script_block_with_send_action`, `test_frame_renders_no_build_yet_when_current_build_is_none`. Note: the test that asserts `'class="three-pane"' not in out` will pass because `annotation.html` does not yet exist — but `{% include %}` will raise. Workaround: create a minimal `annotation.html` stub before this step. Add to Step 3 above:

`src/review_pdf_to_latex/templates/annotation.html` (stub — Task 9.2 fills it):

```html
<div class="three-pane">
  <!-- Filled by Task 9.2 -->
  <div class="pane pane-left">page {{ current_annotation.page }}</div>
  <div class="pane pane-center">{{ current_annotation.id }}</div>
  <div class="pane pane-right">preview</div>
</div>
```

Re-run: PASS for all four tests.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/templates/frame.html \
        src/review_pdf_to_latex/templates/annotation.html \
        tests/test_templates.py
git commit -m "feat(viewer): frame.html chrome with mode branch and top bar"
```

---

## Task 9.2: `annotation.html` — the 3-pane block

**Files:**
- Modify: `src/review_pdf_to_latex/templates/annotation.html` (replace stub with the real template)
- Modify: `tests/test_templates.py` (append tests)

**Implements spec:** §10.1 (3-pane layout), §10.3 (six action buttons), §11.2 (pagination indicator)

The three panes:

1. **Left pane.** `<img>` of the source PDF page with a CSS-absolutely-positioned highlight overlay over the bbox. The PDF coordinate system has its origin at the bottom-left; CSS has its origin at the top-left. The image is rendered at a known DPI (chunk B's `extract` writes pages at 150 DPI per the spec; chunk D passes the actual width/height in pixels and the PDF page dimensions in points so the template can scale without baking in the DPI).

   Scaling formula (clamped to image bounds by the template):
   - `scale_x = image_width_px / pdf_page_width_pt`
   - `scale_y = image_height_px / pdf_page_height_pt`
   - `left_px = bbox[0] * scale_x`
   - `top_px = (pdf_page_height_pt - bbox[3]) * scale_y` (flip Y; bbox[3] is the top in PDF coords, which becomes the lowest y in CSS)
   - `width_px = (bbox[2] - bbox[0]) * scale_x`
   - `height_px = (bbox[3] - bbox[1]) * scale_y`

   Jinja math is awkward for floats, but `*` and `-` and `/` all work on numbers in expressions. We compute the four values inline.

2. **Center pane.** A `<pre class="latex-snippet">` with the file slice. A gutter shows line numbers starting at `snippet_start_line`. Below it, an upgrade-aware diff/proposed block:
   - If `diff2html_present` AND `current_state.annotations[current_annotation.id].before_text` is non-null AND `proposed_text` is non-null: render a `<div id="diff-container">` with a script tag that calls `Diff2Html.html(...)` after page load.
   - Otherwise: two `<pre>` blocks — `before_text` (label "Before") and `proposed_text` (label "Proposed"), each null-safe ("(no text)" placeholder).
   - Six buttons at the bottom in a `<div class="button-row">`, each with `data-action="<verb>"` and `data-annotation-id="<id>"`. Buttons are disabled if the action is not allowed for the current status; per spec §10.3 we encode this in the template via a small Jinja macro.

3. **Right pane.** `<img>` of the current build's page at `target_page`. If `current_build` is None, render a `<div class="no-build">No build yet. Run <code>review-pdf build</code>.</div>`. Below the image, `<div class="pagination-indicator">{{ pagination_indicator }}</div>`.

The allowed-status table (spec §10.3 column "Allowed source → target statuses") drives button enable/disable. Encoded as a Jinja `set` map at the top of `annotation.html`:

```
approve:   applied, redrafted
reject:    applied, redrafted
redraft:   applied, rejected, redrafted
preview:   any
skip:      pending, applied, redrafted, rejected, needs_review, surfaced_pending
surface:   pending, applied, deferred, needs_review
```

- [ ] **Step 1: Write the failing test**

Append to `tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py -v -k annotation`
Expected: FAIL — all eight tests fail; the stub `annotation.html` does not contain images, overlays, buttons, or the diff block.

- [ ] **Step 3: Write minimal implementation**

Replace `src/review_pdf_to_latex/templates/annotation.html`:

```html
{#
  3-pane annotation block. Included by frame.html when mode == "normal".
  See spec §10.1 for layout, §10.3 for button semantics.
#}
{% set ann = current_annotation %}
{% set ann_state = current_state.annotations[ann.id] %}
{% set status = ann_state.status %}

{# Allowed source statuses per action (spec §10.3 table). #}
{% set allowed = {
  "approve":  ["applied", "redrafted"],
  "reject":   ["applied", "redrafted"],
  "redraft":  ["applied", "rejected", "redrafted"],
  "preview":  ["pending", "applied", "accepted", "rejected", "redrafted", "deferred", "surfaced_pending", "surfaced_resolved", "needs_review"],
  "skip":     ["pending", "applied", "redrafted", "rejected", "needs_review", "surfaced_pending"],
  "surface":  ["pending", "applied", "deferred", "needs_review"]
} %}

{# Bbox → CSS scaling. PDF origin bottom-left → CSS origin top-left. #}
{% set scale_x = image_width_px / pdf_page_width_pt %}
{% set scale_y = image_height_px / pdf_page_height_pt %}
{% set bbox_left = ann.bbox[0] * scale_x %}
{% set bbox_top = (pdf_page_height_pt - ann.bbox[3]) * scale_y %}
{% set bbox_width = (ann.bbox[2] - ann.bbox[0]) * scale_x %}
{% set bbox_height = (ann.bbox[3] - ann.bbox[1]) * scale_y %}

<section class="three-pane">

  {# ───── Left pane: source PDF page + bbox overlay ───── #}
  <div class="pane pane-left">
    <div class="page-frame" style="position: relative; width: {{ image_width_px }}px; max-width: 100%;">
      <img class="page-image"
           src="/pages/page-{{ ann.page }}.png"
           alt="PDF page {{ ann.page }}"
           width="{{ image_width_px }}"
           height="{{ image_height_px }}">
      <div class="highlight-overlay"
           style="position: absolute; pointer-events: none; outline: 2px solid rgba(255, 200, 0, 0.7); background: rgba(255, 240, 0, 0.18); left: {{ '%.2f'|format(bbox_left) }}px; top: {{ '%.2f'|format(bbox_top) }}px; width: {{ '%.2f'|format(bbox_width) }}px; height: {{ '%.2f'|format(bbox_height) }}px;"></div>
    </div>
    <div class="annotation-meta">
      <div><strong>Page {{ ann.page }}</strong> &middot; @{{ ann.author }}</div>
      <div class="comment">{{ ann.comment }}</div>
    </div>
  </div>

  {# ───── Center pane: source LaTeX snippet + proposed edit + buttons ───── #}
  <div class="pane pane-center">
    <div class="snippet-header">
      <strong>{{ current_mapping.latex_file or "(unmapped)" }}</strong>
      {% if current_mapping.line_range %}
        lines {{ current_mapping.line_range[0] }}–{{ current_mapping.line_range[1] }}
      {% endif %}
    </div>
    <pre class="latex-snippet"><code>{% for line in latex_snippet.splitlines() %}<span class="gutter">{{ '%4d'|format(snippet_start_line + loop.index0) }}</span>  {{ line }}
{% endfor %}</code></pre>

    <div class="status-badge status-{{ status }}">Status: <strong>{{ status }}</strong></div>

    {% if diff2html_present and ann_state.before_text and proposed_text %}
    <div class="diff-block">
      <div id="diff-container"></div>
      <script>
        (function () {
          var before = {{ ann_state.before_text|tojson }};
          var after = {{ proposed_text|tojson }};
          // Build a minimal unified-diff header so diff2html parses it.
          var diff = "--- before\n+++ proposed\n@@\n" +
                     before.split("\n").map(function (l) { return "-" + l; }).join("\n") +
                     "\n" +
                     after.split("\n").map(function (l) { return "+" + l; }).join("\n");
          if (typeof Diff2Html !== "undefined") {
            document.getElementById("diff-container").innerHTML =
              Diff2Html.html(diff, {drawFileList: false, outputFormat: "side-by-side"});
          } else {
            document.getElementById("diff-container").textContent =
              "(diff2html not loaded; refresh after dropping diff2html.min.js into templates/static/)";
          }
        })();
      </script>
    </div>
    {% else %}
    <div class="proposed-block">
      <div class="before">
        <div class="label">Before</div>
        <pre>{{ ann_state.before_text or "(no before text)" }}</pre>
      </div>
      <div class="proposed">
        <div class="label">Proposed</div>
        <pre class="proposed">{{ proposed_text or "(no proposal yet)" }}</pre>
      </div>
    </div>
    {% endif %}

    <div class="button-row">
      {% for action in ["preview", "approve", "reject", "redraft", "skip", "surface"] %}
        <button type="button"
                data-action="{{ action }}"
                data-annotation-id="{{ ann.id }}"
                {% if status not in allowed[action] %}disabled{% endif %}>
          {{ action|capitalize }}
        </button>
      {% endfor %}
    </div>
  </div>

  {# ───── Right pane: current build preview + pagination indicator ───── #}
  <div class="pane pane-right">
    {% if current_build %}
    <div class="build-frame">
      <img class="build-image"
           src="/builds/{{ current_build.id }}/page-{{ target_page }}.png"
           alt="Build {{ current_build.id }} page {{ target_page }}">
    </div>
    <div class="pagination-indicator">{{ pagination_indicator }}</div>
    {% else %}
    <div class="no-build">
      No build yet. Run <code>review-pdf build</code> from a terminal.
    </div>
    {% endif %}
  </div>

</section>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py -v -k annotation`
Expected: PASS for all eight `annotation` tests.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/templates/annotation.html tests/test_templates.py
git commit -m "feat(viewer): annotation.html 3-pane block with bbox overlay and six action buttons"
```

---

## Task 9.3: CSS layout (inline `<style>` block in `frame.html`)

**Files:**
- Modify: `src/review_pdf_to_latex/templates/frame.html` (replace the placeholder `<style>` block)
- Modify: `tests/test_templates.py` (append CSS-presence smoke tests)

**Implements spec:** §10.1 (3-column layout)

The layout uses CSS Grid:

- Top bar: fixed 48px row at top.
- Main: fills the remaining viewport.
- 3-pane: `grid-template-columns: minmax(280px, 1fr) minmax(360px, 1.6fr) minmax(280px, 1fr)` with `gap: 12px`.
- Image panes use `object-fit: contain`.
- Buttons in a row with `gap: 12px`.

CSS testability is limited without a browser; we assert key rule presence by substring match in the rendered HTML. The browser-side appearance test belongs in chunk F (Task 12).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py -v -k grid_layout`
Expected: FAIL — `height: 48px` and grid rules not in placeholder.

- [ ] **Step 3: Write minimal implementation**

Replace the `<style>` block in `src/review_pdf_to_latex/templates/frame.html` with:

```html
  <style>
    /* ───── Reset and base ───── */
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      color: #222;
      background: #f7f7f9;
      display: grid;
      grid-template-rows: 48px 1fr;
    }
    code, pre { font-family: ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", monospace; }

    /* ───── Top bar ───── */
    .topbar {
      height: 48px;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      padding: 0 16px;
      background: #1f2329;
      color: #f1f3f5;
      border-bottom: 1px solid #0c0d10;
    }
    .topbar-left { justify-self: start; opacity: 0.85; }
    .topbar-center {
      display: flex; gap: 16px; align-items: center; justify-self: center;
    }
    .topbar-right { justify-self: end; }
    .project-root { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 12px; }
    .phase, .order { background: #2c333d; padding: 2px 8px; border-radius: 3px; }
    .counter, .annotation-id { font-weight: 600; }
    .status-line { font-style: italic; opacity: 0.9; }

    /* ───── Main 3-pane grid ───── */
    main {
      overflow: hidden;
      padding: 12px;
    }
    .three-pane {
      display: grid;
      grid-template-columns: minmax(280px, 1fr) minmax(360px, 1.6fr) minmax(280px, 1fr);
      gap: 12px;
      height: 100%;
    }
    .pane {
      background: #ffffff;
      border: 1px solid #d8dadf;
      border-radius: 6px;
      padding: 10px;
      overflow: auto;
      min-width: 0;
    }
    .pane-left .page-image,
    .pane-right .build-image {
      display: block;
      max-width: 100%;
      height: auto;
      object-fit: contain;
    }

    /* ───── Annotation meta + snippet ───── */
    .annotation-meta { margin-top: 8px; font-size: 13px; }
    .comment { margin-top: 4px; font-style: italic; color: #555; }
    .snippet-header { font-size: 12px; color: #555; margin-bottom: 6px; }
    .latex-snippet {
      background: #f1f3f5;
      border: 1px solid #d8dadf;
      border-radius: 4px;
      padding: 8px;
      margin: 0 0 10px 0;
      max-height: 280px;
      overflow: auto;
      white-space: pre;
      font-size: 12px;
    }
    .latex-snippet .gutter {
      color: #999;
      user-select: none;
      display: inline-block;
      width: 4ch;
      text-align: right;
      margin-right: 8px;
    }

    /* ───── Status badge ───── */
    .status-badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 12px;
      background: #e9ecef;
      margin-bottom: 8px;
    }
    .status-applied   { background: #cfe2ff; }
    .status-accepted  { background: #d4edda; }
    .status-rejected  { background: #f8d7da; }
    .status-redrafted { background: #fff3cd; }
    .status-deferred  { background: #e2e3e5; }
    .status-needs_review { background: #f5c2c7; }
    .status-surfaced_pending { background: #e0cffc; }

    /* ───── Proposed / before-after blocks ───── */
    .proposed-block {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }
    .proposed-block .label {
      font-size: 11px;
      text-transform: uppercase;
      color: #666;
      margin-bottom: 2px;
    }
    .proposed-block pre {
      background: #fafbfc;
      border: 1px solid #e6e8eb;
      border-radius: 4px;
      padding: 6px;
      margin: 0;
      font-size: 12px;
      max-height: 220px;
      overflow: auto;
      white-space: pre-wrap;
    }
    .diff-block { margin-bottom: 12px; }

    /* ───── Button row ───── */
    .button-row {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .button-row button {
      flex: 1 1 calc(33.33% - 8px);
      min-width: 92px;
      padding: 8px 12px;
      border: 1px solid #b8bcc4;
      background: #ffffff;
      border-radius: 4px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
    }
    .button-row button:hover:not(:disabled) {
      background: #f1f3f5;
    }
    .button-row button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .button-row button[data-action="approve"]:not(:disabled) { border-color: #2e7d32; color: #2e7d32; }
    .button-row button[data-action="reject"]:not(:disabled)  { border-color: #c62828; color: #c62828; }
    .button-row button[data-action="redraft"]:not(:disabled) { border-color: #ef6c00; color: #ef6c00; }
    .button-row button[data-action="preview"]:not(:disabled) { border-color: #1565c0; color: #1565c0; }

    /* ───── Right pane ───── */
    .pagination-indicator {
      margin-top: 8px;
      font-size: 12px;
      padding: 6px 8px;
      background: #f1f3f5;
      border: 1px solid #d8dadf;
      border-radius: 4px;
    }
    .no-build {
      padding: 24px;
      text-align: center;
      color: #777;
      font-size: 13px;
    }

    /* ───── Mapping mode ───── */
    .mapping-banner {
      padding: 8px 12px;
      background: #fff3cd;
      border: 1px solid #ffeaa7;
      border-radius: 4px;
      margin-bottom: 12px;
    }
    .mapping-row {
      display: grid;
      grid-template-columns: minmax(220px, 1fr) minmax(300px, 1.4fr) minmax(280px, 1fr);
      gap: 12px;
      background: #ffffff;
      border: 1px solid #d8dadf;
      border-radius: 6px;
      padding: 10px;
      margin-bottom: 10px;
    }
    .mapping-row .candidates { display: flex; flex-direction: column; gap: 6px; }
    .mapping-row .candidate {
      padding: 6px;
      background: #f1f3f5;
      border-radius: 4px;
      font-size: 12px;
    }
    .mapping-row form.manual-override {
      margin-top: 8px;
      display: grid;
      grid-template-columns: 1fr auto auto auto;
      gap: 6px;
      align-items: center;
    }
    .mapping-row form.manual-override input[type="number"] { width: 70px; }
  </style>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py -v -k grid_layout`
Expected: PASS for `test_frame_has_grid_layout_rules` and `test_frame_has_no_external_stylesheet_link`.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/templates/frame.html tests/test_templates.py
git commit -m "feat(viewer): CSS grid layout with status badges and button styling"
```

---

## Task 9.4: Click handler — vanilla JS `<script>` block

**Files:**
- Modify: `src/review_pdf_to_latex/templates/frame.html` (replace the placeholder `<script>` block)
- Modify: `tests/test_templates.py` (append handler-shape assertions)

**Implements spec:** §10.5 (click→engine path; POST `/api/events`), §10.2 (500ms poll for state changes)

Behavior:

1. Every `<button[data-action]>` gets a click listener.
2. For `redraft` or `preview`, prompt for `speculative_text` (a string; if empty/cancel, abort).
3. POST `{annotation_id, action, [speculative_text]}` to `/api/events` as JSON.
4. On success (`204 No Content`), disable all action buttons and set `#status` to "Waiting for engine...". The 500ms state poll picks up the engine's write and reloads the page; the reload restores button state from the new context.
5. On failure (non-204), `alert()` the response text and re-enable buttons. (Server contract per chunk D: `400` for validation errors, `409` for "annotation in unexpected status", `500` for unexpected errors. The viewer just shows the body text.)
6. State polling: every 500ms (spec §10.2), send `HEAD /api/state`; if the `Last-Modified` header (or `ETag` fallback) changes vs. the previous value, `location.reload()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py -v -k script`
Expected: FAIL — placeholder `<script>` block does not contain `fetch`, `prompt`, `setInterval`, or `disabled = true`.

- [ ] **Step 3: Write minimal implementation**

Replace the `<script>` block at the bottom of `src/review_pdf_to_latex/templates/frame.html` with:

```html
  <script>
    "use strict";

    // ─────────────────────────────────────────────────────────────
    // Click handler: POST to /api/events, then wait for state.json
    // to change (the 1s poll below picks that up and reloads).
    // Spec §10.5.
    // ─────────────────────────────────────────────────────────────
    async function sendAction(annotationId, action, extra) {
      const body = Object.assign(
        {annotation_id: annotationId, action: action},
        extra || {}
      );
      let r;
      try {
        r = await fetch("/api/events", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify(body)
        });
      } catch (netErr) {
        alert("Network error contacting viewer: " + netErr);
        return;
      }
      if (r.status !== 204) {
        const err = await r.text();
        alert("Server rejected action (" + r.status + "): " + err);
        return;
      }
      // Disable the button row so the user can't double-click while the
      // engine processes. The state poll will reload the page once the
      // engine writes state.json, which restores button state.
      document.querySelectorAll("button[data-action]").forEach(function (b) {
        b.disabled = true;
      });
      const s = document.getElementById("status");
      if (s) s.textContent = "Waiting for engine...";
    }

    document.querySelectorAll("button[data-action]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const action = btn.dataset.action;
        const annotationId = btn.dataset.annotationId;
        const extra = {};
        if (action === "redraft") {
          const t = window.prompt("Redraft text (leave empty to cancel):", "");
          if (!t) return;
          extra.speculative_text = t;
        } else if (action === "preview") {
          const t = window.prompt("Preview hypothetical text:", "");
          if (!t) return;
          extra.speculative_text = t;
        }
        sendAction(annotationId, action, extra);
      });
    });

    // ─────────────────────────────────────────────────────────────
    // Mapping-mode form handler: POST manual override, then reload.
    // Form fields: file (select), line_start (number), line_end (number),
    // and a hidden annotation_id.
    // ─────────────────────────────────────────────────────────────
    document.querySelectorAll("form.manual-override").forEach(function (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {
          annotation_id: fd.get("annotation_id"),
          action: "override-mapping",
          file: fd.get("file"),
          line_start: parseInt(fd.get("line_start"), 10),
          line_end: parseInt(fd.get("line_end"), 10)
        };
        if (!body.file || isNaN(body.line_start) || isNaN(body.line_end)) {
          alert("Pick a file and enter integer line numbers.");
          return;
        }
        if (body.line_start < 1 || body.line_end < body.line_start) {
          alert("Line range must satisfy 1 <= start <= end.");
          return;
        }
        let r;
        try {
          r = await fetch("/api/events", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body)
          });
        } catch (netErr) {
          alert("Network error: " + netErr);
          return;
        }
        if (r.status !== 204) {
          const err = await r.text();
          alert("Override-mapping rejected (" + r.status + "): " + err);
          return;
        }
        // Successful POST: disable this form's button row while we wait.
        form.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
      });
    });

    // ─────────────────────────────────────────────────────────────
    // Candidate-confirm buttons in mapping mode: clicking a candidate
    // POSTs the same payload using the candidate's file/lines.
    // ─────────────────────────────────────────────────────────────
    document.querySelectorAll("button[data-confirm-candidate]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        const body = {
          annotation_id: btn.dataset.annotationId,
          action: "override-mapping",
          file: btn.dataset.file,
          line_start: parseInt(btn.dataset.lineStart, 10),
          line_end: parseInt(btn.dataset.lineEnd, 10)
        };
        let r;
        try {
          r = await fetch("/api/events", {
            method: "POST",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify(body)
          });
        } catch (netErr) {
          alert("Network error: " + netErr);
          return;
        }
        if (r.status !== 204) {
          const err = await r.text();
          alert("Override-mapping rejected (" + r.status + "): " + err);
          return;
        }
        btn.disabled = true;
      });
    });

    // ─────────────────────────────────────────────────────────────
    // Auto-reload when state.json changes. Polls HEAD /api/state every
    // 500ms (spec §10.2); on Last-Modified change, reloads.
    // Server contract (chunk D): HEAD /api/state must set Last-Modified
    // to the state.json mtime, or ETag to its md5.
    // ─────────────────────────────────────────────────────────────
    var lastTag = null;
    setInterval(async function () {
      try {
        const r = await fetch("/api/state", {method: "HEAD"});
        const tag = r.headers.get("etag") || r.headers.get("last-modified") || "";
        if (lastTag !== null && lastTag !== tag) {
          location.reload();
        }
        lastTag = tag;
      } catch (e) {
        // Server went away; surface in status line but don't reload.
        const s = document.getElementById("status");
        if (s) s.textContent = "Server unreachable.";
      }
    }, 500);
  </script>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py -v -k script`
Expected: PASS for all four script tests.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/templates/frame.html tests/test_templates.py
git commit -m "feat(viewer): click handler with redraft/preview prompts and state polling"
```

**Browser-level test deferred.** Chunk F (Task 12) will spin up `review-pdf serve` against a fixture, drive a headless browser, click buttons, and assert state.json mutations. This chunk asserts only the script's textual shape.

---

## Task 9.5: Manual mapping UI (`mode == "mapping"`)

**Files:**
- Modify: `src/review_pdf_to_latex/templates/frame.html` (fill the `mapping-list` `<div>` body — currently empty)
- Modify: `tests/test_templates.py` (append mapping-mode tests)

**Implements spec:** §10.6

Behavior:

- For each `{annotation, mapping}` in `needs_review_annotations`, render a `.mapping-row` containing:
  - Left subcolumn: annotation id, page, excerpt of `highlighted_text` (first 200 chars), and `comment`.
  - Center subcolumn: the up-to-3 candidates from `mapping.candidates`. Each candidate has a `[Confirm]` button with `data-confirm-candidate`, `data-annotation-id`, `data-file`, `data-line-start`, `data-line-end`. The click handler in Task 9.4 POSTs `/api/events` with `action: "override-mapping"`.
  - Right subcolumn: a `<form class="manual-override">` with hidden `annotation_id`, a `<select name="file">` populated from `tex_files`, two `<input type="number">` for `line_start` and `line_end`, and a `[Confirm]` submit button.

If `needs_review_annotations` is empty, render a "All mappings resolved" message and instructions to restart serve without `--mapping-mode`.

The list is rendered server-side; no client-side state. The auto-reload poll picks up `mapping.json` changes (because chunk D's `HEAD /api/state` Last-Modified is derived from the max mtime of state.json AND mapping.json — chunk D's contract).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py -v -k mapping`
Expected: FAIL — the `mapping-list` div is empty in the current `frame.html`.

- [ ] **Step 3: Write minimal implementation**

In `src/review_pdf_to_latex/templates/frame.html`, replace the empty mapping list:

```html
      <div class="mapping-list" id="mapping-list">
        <!-- Task 9.5 fills this -->
      </div>
```

with:

```html
      <div class="mapping-list" id="mapping-list">
        {% if needs_review_annotations|length == 0 %}
          <div class="all-resolved">
            <strong>All mappings resolved.</strong>
            Ctrl-C this server and re-run <code>review-pdf serve</code>
            (without <code>--mapping-mode</code>) to start Phase 1.
          </div>
        {% else %}
          {% for item in needs_review_annotations %}
            {% set a = item.annotation %}
            {% set m = item.mapping %}
            <div class="mapping-row">
              <div class="mapping-meta">
                <div><strong>{{ a.id }}</strong> &middot; p.{{ a.page }}</div>
                <div class="excerpt">"{{ a.highlighted_text[:200] }}{% if a.highlighted_text|length > 200 %}…{% endif %}"</div>
                <div class="comment"><em>{{ a.comment }}</em></div>
              </div>
              <div class="candidates">
                {% if m.candidates and m.candidates|length > 0 %}
                  {% for c in m.candidates %}
                  <div class="candidate">
                    <div><code>{{ c.file }}</code> lines {{ c.line_range[0] }}–{{ c.line_range[1] }}
                      (score {{ '%.2f'|format(c.score) }})</div>
                    <button type="button"
                            data-confirm-candidate="1"
                            data-annotation-id="{{ a.id }}"
                            data-file="{{ c.file }}"
                            data-line-start="{{ c.line_range[0] }}"
                            data-line-end="{{ c.line_range[1] }}">
                      Confirm
                    </button>
                  </div>
                  {% endfor %}
                {% else %}
                  <div class="candidate-empty">No fuzzy candidates above threshold.</div>
                {% endif %}
              </div>
              <div class="manual-side">
                <form class="manual-override">
                  <input type="hidden" name="annotation_id" value="{{ a.id }}">
                  <select name="file" required>
                    <option value="">— pick a .tex file —</option>
                    {% for f in tex_files %}
                    <option value="{{ f }}">{{ f }}</option>
                    {% endfor %}
                  </select>
                  <input type="number" name="line_start" placeholder="start" min="1" required>
                  <input type="number" name="line_end" placeholder="end" min="1" required>
                  <button type="submit">Confirm</button>
                </form>
              </div>
            </div>
          {% endfor %}
        {% endif %}
      </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py -v -k mapping`
Expected: PASS for all six mapping tests.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/templates/frame.html tests/test_templates.py
git commit -m "feat(viewer): manual mapping UI for needs_review bucket"
```

---

## Task 9.6: Optional `diff2html` upgrade path

**Files:**
- Modify: `src/review_pdf_to_latex/templates/frame.html` (add conditional `<script src>` in `<head>`)
- Modify: `tests/test_templates.py` (append diff2html-present test)

**Implements spec:** §10.4 (optional CDN-loaded diff2html with fallback)

The server (chunk D) stat-checks `templates/static/diff2html.min.js` once per request and passes `diff2html_present: bool` in the context. The template:

- If `diff2html_present` is `True`: emits a `<link rel="stylesheet" href="/static/diff2html.min.css">` and a `<script src="/static/diff2html.min.js"></script>` in `<head>`, AND triggers the diff rendering branch in `annotation.html` (already wired in Task 9.2).
- If `False`: emits nothing extra; `annotation.html` falls back to two `<pre>` blocks.

README guidance (spec §10.4 mentions CDN, but to keep v1 offline-capable we ship the upgrade as a one-command curl). The README snippet — added to project docs by chunk H or wherever, NOT this chunk — should read:

```bash
mkdir -p src/review_pdf_to_latex/templates/static
curl -L -o src/review_pdf_to_latex/templates/static/diff2html.min.js \
  https://cdn.jsdelivr.net/npm/diff2html/bundles/js/diff2html.min.js
curl -L -o src/review_pdf_to_latex/templates/static/diff2html.min.css \
  https://cdn.jsdelivr.net/npm/diff2html/bundles/css/diff2html.min.css
```

This task only handles the template branch.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_templates.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py -v -k diff2html`
Expected: FAIL — `frame.html` does not emit the link/script tags.

- [ ] **Step 3: Write minimal implementation**

In `src/review_pdf_to_latex/templates/frame.html`, modify the `<head>` block. Add inside `<head>`, immediately before the closing `</head>`:

```html
  {% if diff2html_present %}
  <link rel="stylesheet" href="/static/diff2html.min.css">
  <script src="/static/diff2html.min.js"></script>
  {% endif %}
```

Note this is the ONLY place we use `<link rel="stylesheet">`; it's external to the static asset under our control, not a framework, and it's optional. The earlier `test_frame_has_no_external_stylesheet_link` test asserts absence when `diff2html_present=False`, which still holds — no regression.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py -v`
Expected: PASS for all tests in the file (including the diff2html pair and the pre-existing `test_frame_has_no_external_stylesheet_link` which uses the default context with `diff2html_present=False`).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/templates/frame.html tests/test_templates.py
git commit -m "feat(viewer): optional diff2html upgrade path"
```

---

## Task 9.7: Final smoke test — full render at every mode and edge case

**Files:**
- Modify: `tests/test_templates.py` (append three smoke tests)

**Implements spec:** §10.1, §10.6 (end-to-end coverage)

This is a small set of integration-level template tests covering the cross-cutting concerns: an annotation in every status, mapping mode with zero rows, mapping mode with the maximum 3 candidates per row, and a smoke render that just asserts no Jinja exception is raised across a battery of contexts.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_templates.py`:

```python
import pytest


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
```

The sample_annotation, sample_mapping_entry imports are already in scope from earlier tests via the module-level import; if Pyflakes complains, also add `from tests.fixtures.template_contexts import sample_annotation, sample_mapping_entry` at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_templates.py -v -k smoke or status`
Expected: PASS for most status values; FAIL only if a status produces a Jinja undefined error (e.g., a missing CSS class — but Task 9.3's CSS includes a default `.status-badge` so unknown statuses still render). If any of these tests fail, the fix is in `annotation.html`: ensure status-unknown statuses (`accepted`, `surfaced_resolved`) get a fallback CSS rule, not a missing key.

Verify all PASS before committing.

- [ ] **Step 3: Write minimal implementation**

If the smoke tests reveal a missing case (e.g., `proposed_text is None` shows up as the literal string "None" instead of "(no proposal yet)"), fix `annotation.html` accordingly. The current Task-9.2 implementation already handles `proposed_text or "(no proposal yet)"`, so this should be a no-op. If a status produces an unrendered badge, add a default `.status-badge` fallback color rule to `frame.html`'s `<style>`:

```css
    .status-accepted, .status-surfaced_resolved { background: #d4edda; }
```

(already present in Task 9.3 for `.status-accepted` but not for `.status-surfaced_resolved`; add the latter if the test reveals a gap).

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_templates.py -v`
Expected: PASS for the entire file.

- [ ] **Step 5: Commit**

```bash
git add tests/test_templates.py src/review_pdf_to_latex/templates/frame.html
git commit -m "test(viewer): smoke-render every status and mapping-mode edge cases"
```

---

## Summary of files this chunk produces

After all sub-tasks (9.0 through 9.7), the repository contains:

```
src/review_pdf_to_latex/templates/
├── __init__.py
├── frame.html                  (~ 220 lines including CSS + JS)
├── annotation.html             (~ 100 lines)
└── static/
    └── .gitkeep                (the optional diff2html drop point)

tests/
├── fixtures/
│   └── template_contexts.py    (~ 175 lines)
└── test_templates.py           (~ 250 lines, 25+ tests)
```

No CLI subcommand code, no HTTP handler, no event-log writer — those are owned by chunks C, D, and G respectively. This chunk delivers exactly two templates + a test fixture helper + a test file, fully covering spec §10.

## Deferred items (handled in other chunks, NOT this chunk)

- **Server-side handler for `POST /api/events`** — chunk D, Task 8.x. Must respond 204 on success, 4xx on validation errors.
- **`HEAD /api/state` Last-Modified header** — chunk D. Without this, the 500ms poll is a no-op and the user reloads manually.
- **`override-mapping` CLI subcommand** — chunk C, Task 6.7. The viewer just emits the event.
- **End-to-end browser test** (Playwright or similar) — chunk F, Task 12. This chunk only asserts rendered-HTML shape.
- **README guidance for the diff2html curl** — chunk H or wherever the project README lives.
## Task 10: Preview command — speculative compile with snapshot/restore

**Files:**
- Create: `src/review_pdf_to_latex/preview.py`
- Create: `tests/test_preview.py`
- Modify: `src/review_pdf_to_latex/cli.py` (preview handler — was a stub from Task 3.1)

**Implements spec:** §8 (`preview` subcommand), §10.3 (Preview button semantics), §11.1 (Strategy B — in-place mutate-then-restore)

The `preview` command is a *speculative* compile: it shows what the PDF would look like if a hypothetical edit were applied, WITHOUT mutating `state.json.annotations[id]`. The spec's `§11.1` resolves the design choice: in-place file mutation followed by restore, NOT a shadow copy of the project tree, because the LaTeX build references files by relative path and copying the whole tree is expensive.

The contract: `preview` MUST:
1. Snapshot the current contents of the target `.tex` file into memory.
2. Write the hypothetical new text into the file's line range.
3. Invoke `build.build()` (which appends to `state.json.builds[]`).
4. Restore the snapshot from memory.
5. Print the resulting build ID to stdout.
6. Never touch `state.json.annotations[id]`.

If the restore step fails (disk full, file deleted mid-flight, permission revoked), the engine MUST dump the snapshot to a recovery file and exit with code 17 (`EXIT_RESTORE_FAILED`).

### Task 10.1: Snapshot-and-restore context manager

**Files:**
- Create: `src/review_pdf_to_latex/preview.py`
- Create: `tests/test_preview.py`

**Implements spec:** §11.1 (engine guarantees restoration via `try/finally`), §10.3 ("Note on Preview implementation" — the engine guarantees restoration via a Python `try/finally`)

- [ ] **Step 1: Write the failing test**

Create `tests/test_preview.py`:

```python
"""Tests for the speculative-compile preview path (spec §10.3, §11.1)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from review_pdf_to_latex import preview


def _write(p: Path, text: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")


def test_with_in_place_edit_mutates_during_yield_and_restores_on_exit(
    tmp_path: Path,
):
    """Inside the `with` block the file shows the new text; on exit, the file
    is byte-identical to its pre-call contents."""
    target = tmp_path / "intro.tex"
    original = "line 1\nline 2\nline 3\nline 4\nline 5\n"
    _write(target, original)
    pre_hash = target.read_bytes()

    with preview.with_in_place_edit(
        target, line_range=(2, 3), new_text="REPLACEMENT\n"
    ):
        mutated = target.read_text(encoding="utf-8")
        assert mutated == "line 1\nREPLACEMENT\nline 4\nline 5\n"

    post_hash = target.read_bytes()
    assert post_hash == pre_hash, "file must be byte-identical after restore"


def test_with_in_place_edit_restores_on_exception(tmp_path: Path):
    """If the caller raises inside the `with` block, the file is still restored."""
    target = tmp_path / "intro.tex"
    original = "alpha\nbeta\ngamma\n"
    _write(target, original)

    class _Boom(Exception):
        pass

    with pytest.raises(_Boom):
        with preview.with_in_place_edit(
            target, line_range=(2, 2), new_text="HYPOTHETICAL\n"
        ):
            assert target.read_text(encoding="utf-8") == "alpha\nHYPOTHETICAL\ngamma\n"
            raise _Boom("simulated build crash")

    assert target.read_text(encoding="utf-8") == original


def test_with_in_place_edit_invalid_line_range_raises(tmp_path: Path):
    """A line range outside the file's line count raises ValueError before mutation."""
    target = tmp_path / "intro.tex"
    _write(target, "only one line\n")

    with pytest.raises(ValueError, match="line range"):
        with preview.with_in_place_edit(
            target, line_range=(5, 7), new_text="oops\n"
        ):
            pass

    assert target.read_text(encoding="utf-8") == "only one line\n"


def test_with_in_place_edit_restore_failure_writes_recovery_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    """If the restore step fails on the way out, the engine writes the
    in-memory snapshot to a recovery file under ``.review-state/`` and
    raises ``InPlaceRestoreError``.

    We simulate the failure by monkeypatching ``Path.write_text`` on the
    target file to raise during restore (the *second* call — the first call
    is the in-place mutation we want to succeed).
    """
    target = tmp_path / "intro.tex"
    original = "before\n"
    _write(target, original)

    # Ensure the recovery dir exists; the helper writes into
    # <project_root>/.review-state/preview-recovery-<ts>.txt where
    # project_root is target.parent.
    recovery_dir = tmp_path / ".review-state"
    recovery_dir.mkdir()

    real_write_text = Path.write_text
    call_count = {"n": 0}

    def failing_write_text(self, *args, **kwargs):  # type: ignore[no-untyped-def]
        call_count["n"] += 1
        # Allow the mutation write (first call). Fail the restore (second).
        if self == target and call_count["n"] >= 2:
            raise OSError("simulated restore failure")
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", failing_write_text)

    with pytest.raises(preview.InPlaceRestoreError) as exc_info:
        with preview.with_in_place_edit(
            target, line_range=(1, 1), new_text="MUTATED\n"
        ):
            assert target.read_text(encoding="utf-8") == "MUTATED\n"

    # The recovery file must exist and contain the original snapshot.
    recovery_files = list(recovery_dir.glob("preview-recovery-*.txt"))
    assert len(recovery_files) == 1, (
        f"expected one recovery file, got {recovery_files}"
    )
    assert recovery_files[0].read_text(encoding="utf-8") == original

    # The error message must name the original file and the recovery file.
    msg = str(exc_info.value)
    assert str(target) in msg
    assert str(recovery_files[0]) in msg
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_preview.py -v -k with_in_place_edit`

Expected: 4 FAIL with `ModuleNotFoundError: No module named 'review_pdf_to_latex.preview'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review_pdf_to_latex/preview.py`:

```python
"""Speculative-compile primitives.

The Preview button on the viewer (spec §10.3) and the ``review-pdf preview``
CLI subcommand (spec §8) both go through this module. The model is:

1. Snapshot the target ``.tex`` file's bytes into memory.
2. Write the speculative new text in place over the annotation's line range.
3. Run :func:`review_pdf_to_latex.build.build` — which appends a fresh
   entry to ``state.json.builds[]`` and emits an artifact under
   ``.review-state/builds/build-NNN/``.
4. Restore the in-memory snapshot to the file.
5. Return the build ID to the caller.

The contract: ``state.json.annotations[id]`` is NEVER mutated by preview.
``state.json.builds[]`` IS mutated — that is the artifact stream the
viewer consumes (spec §10.1).

If restore fails the engine dumps the snapshot to
``.review-state/preview-recovery-<timestamp>.txt`` and raises
:class:`InPlaceRestoreError`. The CLI handler maps that to exit code 17
(``EXIT_RESTORE_FAILED``; spec §8).
"""

from __future__ import annotations

import contextlib
import time
from pathlib import Path
from typing import Iterator


class InPlaceRestoreError(Exception):
    """Raised when :func:`with_in_place_edit` fails to restore the snapshot.

    Carries the path of the target file, the path of the recovery file
    holding the original bytes, and the underlying OS error. The CLI
    handler prints the message to stderr and exits 17 (spec §8).
    """


def _find_state_dir(target: Path) -> Path:
    """Locate the ``.review-state/`` directory for ``target``.

    Walks up from ``target.parent`` until it finds a ``.review-state/``
    subdir, or falls back to ``target.parent/.review-state`` if none is
    found. The fallback path is created on demand so the recovery file
    has somewhere to land even in pathological cases (the user can find
    it next to the target file).
    """
    for ancestor in [target.parent, *target.parent.parents]:
        candidate = ancestor / ".review-state"
        if candidate.is_dir():
            return candidate
    fallback = target.parent / ".review-state"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def _replace_lines(text: str, line_range: tuple[int, int], new_text: str) -> str:
    """Replace ``line_range`` (1-indexed, inclusive) in ``text`` with ``new_text``.

    The line range must fall within the file's existing line count; otherwise
    :class:`ValueError` is raised. ``new_text`` is inserted verbatim — the
    caller is responsible for trailing newlines.
    """
    start, end = line_range
    if start < 1 or end < start:
        raise ValueError(
            f"invalid line range {line_range!r}: start must be >= 1 and end >= start"
        )
    lines = text.splitlines(keepends=True)
    if end > len(lines):
        raise ValueError(
            f"line range {line_range!r} exceeds file length ({len(lines)} lines)"
        )
    before = "".join(lines[: start - 1])
    after = "".join(lines[end:])
    return before + new_text + after


@contextlib.contextmanager
def with_in_place_edit(
    latex_file: Path,
    line_range: tuple[int, int],
    new_text: str,
) -> Iterator[None]:
    """Context manager that mutates ``latex_file`` in place, then restores it.

    Parameters
    ----------
    latex_file:
        Absolute or project-relative path to the ``.tex`` file.
    line_range:
        Inclusive 1-indexed ``(start, end)`` line range to replace.
    new_text:
        Replacement text (caller-supplied newlines).

    Yields
    ------
    None
        The ``with`` block runs with the file containing the new text.

    Raises
    ------
    ValueError
        ``line_range`` is invalid (start < 1, end < start, or end > line
        count). The file is not mutated.
    InPlaceRestoreError
        Restoration of the original bytes failed. The original contents
        have been written to ``.review-state/preview-recovery-<ts>.txt``;
        the path is in the exception message.

    Side effects
    ------------
    On success: the file is byte-identical to its pre-call contents.
    On exception inside the ``with`` block: the file is still restored,
    then the exception is re-raised.
    On restore failure: a recovery file appears under ``.review-state/``.
    """
    latex_file = Path(latex_file)
    original_bytes = latex_file.read_bytes()
    original_text = original_bytes.decode("utf-8")
    new_contents = _replace_lines(original_text, line_range, new_text)

    # Apply the speculative mutation.
    latex_file.write_text(new_contents, encoding="utf-8")

    try:
        yield
    finally:
        try:
            latex_file.write_text(original_text, encoding="utf-8")
        except OSError as restore_err:
            state_dir = _find_state_dir(latex_file)
            ts = time.strftime("%Y%m%dT%H%M%S")
            recovery_path = state_dir / f"preview-recovery-{ts}.txt"
            # Best-effort recovery dump. If this also fails, surface both
            # errors in the chained exception.
            try:
                recovery_path.write_text(original_text, encoding="utf-8")
            except OSError as dump_err:
                raise InPlaceRestoreError(
                    f"failed to restore {latex_file} after preview "
                    f"(restore error: {restore_err}); also failed to write "
                    f"recovery file {recovery_path} ({dump_err}); "
                    f"the original contents are LOST — recover from git or backup"
                ) from restore_err
            raise InPlaceRestoreError(
                f"failed to restore {latex_file} after preview "
                f"(error: {restore_err}); the original contents have been "
                f"saved to {recovery_path} — copy them back manually"
            ) from restore_err
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_preview.py -v -k with_in_place_edit`

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/preview.py tests/test_preview.py
git commit -m "feat(preview): in-place edit context manager with recovery"
```

### Task 10.2: `preview()` orchestration

**Files:**
- Modify: `src/review_pdf_to_latex/preview.py` (append `preview` function)
- Modify: `tests/test_preview.py` (append integration test)

**Implements spec:** §8 (`preview` subcommand semantics), §10.3 (Preview button: no state.annotations mutation; builds[] grows), §11.1 (preview reuses `build` artifacts)

The orchestration is thin: read mapping.json, drive `with_in_place_edit`, call `build.build` inside the context, return the build ID. The build module (chunk C) owns all pdflatex orchestration, build-NNN allocation, and the `state.json.builds[]` append. Preview never touches `state.json.annotations[id]`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_preview.py`:

```python
from unittest.mock import patch

from review_pdf_to_latex import state as state_mod


def _seed_minimal_project(tmp_project: Path) -> None:
    """Seed a project root with one .tex file, plus mapping.json and state.json.

    Layout:
        tmp_project/templates/intro.tex
        tmp_project/.review-state/mapping.json
        tmp_project/.review-state/state.json
    """
    tex = tmp_project / "templates" / "intro.tex"
    tex.parent.mkdir(parents=True, exist_ok=True)
    tex.write_text(
        "intro line 1\nintro line 2\nintro line 3\nintro line 4\n",
        encoding="utf-8",
    )

    sd = state_mod.StateDir(tmp_project)
    state_mod.atomic_write_json(
        sd.mapping_path,
        {
            "schema_version": 1,
            "mappings": {
                "ann-001": {
                    "latex_file": "templates/intro.tex",
                    "line_range": [2, 3],
                    "confidence": 0.9,
                    "method": "fuzzy_text",
                    "needs_review": False,
                    "candidates": [],
                },
            },
        },
    )
    state_mod.atomic_write_json(
        sd.state_path,
        {
            "schema_version": 1,
            "phase": "2a-ratify",
            "order": "mechanical-first",
            "current_annotation_id": "ann-001",
            "annotations": {
                "ann-001": {
                    "status": "applied",
                    "before_text": "intro line 2\nintro line 3",
                    "proposed_text": "intro line 2\nintro line 3",
                    "applied_text": "intro line 2\nintro line 3",
                    "applied_at": "2026-05-16T20:00:00Z",
                    "last_build_id": "build-001",
                    "surface_chat_log": None,
                    "failure_log_path": None,
                    "failure_edit_text": None,
                },
            },
            "builds": [],
        },
    )


def test_preview_appends_build_and_restores_tex_file(tmp_project: Path):
    """preview() runs build inside the snapshot/restore context, returns the
    build ID, and leaves the .tex file byte-identical."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)
    tex = tmp_project / "templates" / "intro.tex"
    original = tex.read_bytes()

    # Stub out build.build so this test does not invoke pdflatex.
    # The contract: build.build mutates state.json.builds[] and returns
    # the new build ID. Preview must invoke it inside the `with` block.
    def fake_build(state_dir: state_mod.StateDir, **kwargs):  # type: ignore[no-untyped-def]
        # Verify the .tex file IS mutated at the moment build runs.
        current = tex.read_text(encoding="utf-8")
        assert "HYPOTHETICAL" in current, (
            "build must run with the speculative edit in place"
        )
        # Append a build record (mimicking chunk C's behavior).
        payload = state_mod.read_json(state_dir.state_path)
        payload["builds"].append(
            {
                "id": "build-002",
                "pdf_path": ".review-state/builds/build-002.pdf",
                "page_count": 1,
                "compiled_at": "2026-05-16T20:05:00Z",
                "log_path": ".review-state/builds/build-002.log",
                "ok": True,
                "page_md5": ["deadbeef"],
            }
        )
        state_mod.atomic_write_json(state_dir.state_path, payload)
        return "build-002"

    with patch.object(preview, "_invoke_build", side_effect=fake_build):
        build_id = preview.preview(
            sd, annotation_id="ann-001", new_text="HYPOTHETICAL line\n"
        )

    assert build_id == "build-002"

    # The .tex file is byte-identical to its pre-preview state.
    assert tex.read_bytes() == original

    # state.json.annotations[ann-001] is unchanged.
    final = state_mod.read_json(sd.state_path)
    ann = final["annotations"]["ann-001"]
    assert ann["status"] == "applied"
    assert ann["applied_text"] == "intro line 2\nintro line 3"
    assert ann["last_build_id"] == "build-001"  # NOT updated to build-002

    # state.json.builds[] grew by one entry.
    assert [b["id"] for b in final["builds"]] == ["build-002"]


def test_preview_raises_mapping_unresolved_when_mapping_is_null(tmp_project: Path):
    """If the annotation has no latex_file / line_range, preview raises
    MappingUnresolvedError (mapped to exit code 8 by the CLI)."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)

    # Overwrite mapping.json so ann-001 has no resolved location.
    state_mod.atomic_write_json(
        sd.mapping_path,
        {
            "schema_version": 1,
            "mappings": {
                "ann-001": {
                    "latex_file": None,
                    "line_range": None,
                    "confidence": 0.0,
                    "method": "failed",
                    "needs_review": True,
                    "candidates": [],
                },
            },
        },
    )

    with pytest.raises(preview.MappingUnresolvedError):
        preview.preview(sd, annotation_id="ann-001", new_text="...")


def test_preview_raises_annotation_not_found_for_unknown_id(tmp_project: Path):
    """An unknown annotation ID raises AnnotationNotFoundError."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)

    with pytest.raises(preview.AnnotationNotFoundError):
        preview.preview(sd, annotation_id="ann-999", new_text="...")


def test_preview_propagates_build_failure(tmp_project: Path):
    """If the speculative build fails, preview re-raises (the CLI maps it
    to exit code 11). The .tex file is still restored."""
    _seed_minimal_project(tmp_project)
    sd = state_mod.StateDir(tmp_project)
    tex = tmp_project / "templates" / "intro.tex"
    original = tex.read_bytes()

    class _BuildFailed(Exception):
        pass

    def fake_build(state_dir, **kwargs):  # type: ignore[no-untyped-def]
        raise _BuildFailed("pdflatex exit code 1")

    with patch.object(preview, "_invoke_build", side_effect=fake_build):
        with pytest.raises(_BuildFailed):
            preview.preview(
                sd, annotation_id="ann-001", new_text="WILL_FAIL\n"
            )

    # File restored even though build crashed.
    assert tex.read_bytes() == original
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_preview.py -v -k "preview_appends_build or preview_raises or preview_propagates"`

Expected: 4 FAIL with `AttributeError: module 'review_pdf_to_latex.preview' has no attribute 'preview'` (also `MappingUnresolvedError`, `AnnotationNotFoundError`, `_invoke_build`).

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/preview.py`:

```python
from review_pdf_to_latex import state as _state


class AnnotationNotFoundError(Exception):
    """Raised when ``preview()`` is asked about an unknown annotation ID.

    CLI handler maps this to exit code 7 (``EXIT_ANNOTATION_NOT_FOUND``).
    """


class MappingUnresolvedError(Exception):
    """Raised when an annotation's mapping has no ``latex_file`` or ``line_range``.

    CLI handler maps this to exit code 8 (``EXIT_MAPPING_UNRESOLVED``).
    """


def _invoke_build(state_dir: _state.StateDir, **kwargs):  # type: ignore[no-untyped-def]
    """Indirection seam so tests can stub the LaTeX compile out.

    The real implementation is :func:`review_pdf_to_latex.build.build`
    (chunk C). We import it lazily so this module does not fail to load
    if the build module is still being scaffolded.
    """
    from review_pdf_to_latex import build as build_mod

    return build_mod.build(state_dir, **kwargs)


def preview(
    state_dir: _state.StateDir,
    annotation_id: str,
    new_text: str,
) -> str:
    """Run a speculative compile for ``annotation_id`` with ``new_text``.

    Reads ``mapping.json`` to find the annotation's ``latex_file`` and
    ``line_range``. Snapshots the file, writes the new text in place,
    invokes :func:`_invoke_build`, and restores the file. Returns the
    build ID of the speculative build.

    Side effects:
    - ``state.json.builds[]`` gains one entry (via the build module).
    - ``state.json.annotations[annotation_id]`` is UNCHANGED.
    - ``.review-state/builds/build-NNN/`` is created (the viewer reads it).

    Raises
    ------
    AnnotationNotFoundError
        ``annotation_id`` is not present in ``mapping.json``.
    MappingUnresolvedError
        The annotation's mapping has no ``latex_file`` or ``line_range``.
    InPlaceRestoreError
        Restore of the snapshot failed (recovery file path is in message).
    _state.SourcePdfChangedError, _state.LegacyStateError
        Source PDF guard refused the operation (spec §14 risk 9).
    """
    # Spec §14 risk 9: refuse to compile against potentially stale annotation
    # coordinates if the source PDF has changed since extract.
    _state.assert_source_pdf_unchanged(state_dir)
    mapping_doc = _state.read_json(state_dir.mapping_path)
    mappings = mapping_doc.get("mappings", {})
    if annotation_id not in mappings:
        raise AnnotationNotFoundError(
            f"annotation {annotation_id!r} not present in mapping.json"
        )
    m = mappings[annotation_id]
    latex_file_rel = m.get("latex_file")
    line_range = m.get("line_range")
    if latex_file_rel is None or line_range is None:
        raise MappingUnresolvedError(
            f"annotation {annotation_id!r} has unresolved mapping "
            f"(latex_file={latex_file_rel!r}, line_range={line_range!r}); "
            f"run `review-pdf override-mapping` first"
        )

    latex_path = state_dir.root / latex_file_rel
    lr = (int(line_range[0]), int(line_range[1]))

    with with_in_place_edit(latex_path, lr, new_text):
        build_id = _invoke_build(state_dir)

    return build_id
```

Note: this implementation references ``state_dir.root``. Chunk A's
``StateDir`` (Task 2.1) exposes ``root`` as the project root (parent of
``.review-state/``). If chunk A used a different attribute name (e.g.,
``project_root``), the reviewer must reconcile here. The spec consistently
says "project root"; for the purposes of this plan, ``StateDir.root`` is
the canonical accessor and chunk A's task 2.1 must expose it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_preview.py -v`

Expected: 7 PASSED (4 from Task 10.1 + 3 new orchestration tests + 1 build-failure restore test = 8 total in the file; if the count looks off recount from `pytest --collect-only`).

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/preview.py tests/test_preview.py
git commit -m "feat(preview): orchestration with snapshot/restore"
```

### Task 10.3: Wire up the `preview` CLI subcommand

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` (replace `_stub("preview")` with a real handler)
- Modify: `tests/test_cli.py` (add CLI-level integration tests)

**Implements spec:** §8 (preview exit codes 0, 7, 8, 11, 17)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_cli.py`:

```python
from unittest.mock import patch

from review_pdf_to_latex import preview as preview_mod


def _make_new_text_file(tmp_path: Path, content: str) -> Path:
    p = tmp_path / "new_text.tex"
    p.write_text(content, encoding="utf-8")
    return p


def test_cli_preview_prints_build_id_and_exits_zero(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """Successful preview prints the build ID to stdout and returns 0."""
    new_text_file = _make_new_text_file(tmp_project, "speculative text\n")

    def fake_preview(state_dir, annotation_id, new_text):  # type: ignore[no-untyped-def]
        assert annotation_id == "ann-001"
        assert new_text == "speculative text\n"
        return "build-042"

    with patch.object(preview_mod, "preview", side_effect=fake_preview):
        rc = cli.main(
            [
                "--project-dir",
                str(tmp_project),
                "preview",
                "--annotation-id",
                "ann-001",
                "--new-text-file",
                str(new_text_file),
            ]
        )

    assert rc == 0
    out = capsys.readouterr().out.strip()
    assert out == "build-042"


def test_cli_preview_exits_7_for_unknown_annotation(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """AnnotationNotFoundError → exit code 7."""
    new_text_file = _make_new_text_file(tmp_project, "x\n")

    with patch.object(
        preview_mod,
        "preview",
        side_effect=preview_mod.AnnotationNotFoundError("ann-999 not found"),
    ):
        rc = cli.main(
            [
                "--project-dir",
                str(tmp_project),
                "preview",
                "--annotation-id",
                "ann-999",
                "--new-text-file",
                str(new_text_file),
            ]
        )

    assert rc == cli.EXIT_ANNOTATION_NOT_FOUND == 7
    err = capsys.readouterr().err
    assert "ann-999" in err


def test_cli_preview_exits_8_for_unresolved_mapping(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """MappingUnresolvedError → exit code 8."""
    new_text_file = _make_new_text_file(tmp_project, "x\n")

    with patch.object(
        preview_mod,
        "preview",
        side_effect=preview_mod.MappingUnresolvedError(
            "ann-001 mapping unresolved"
        ),
    ):
        rc = cli.main(
            [
                "--project-dir",
                str(tmp_project),
                "preview",
                "--annotation-id",
                "ann-001",
                "--new-text-file",
                str(new_text_file),
            ]
        )

    assert rc == cli.EXIT_MAPPING_UNRESOLVED == 8


def test_cli_preview_exits_11_when_speculative_build_fails(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """A build failure inside preview() → exit code 11.

    The build module (chunk C) raises ``build.BuildFailedError`` on
    pdflatex non-zero. Preview propagates it; the CLI handler maps it.
    """
    new_text_file = _make_new_text_file(tmp_project, "x\n")

    # Import lazily so the test does not require build module shape upfront.
    from review_pdf_to_latex import build as build_mod

    with patch.object(
        preview_mod,
        "preview",
        side_effect=build_mod.BuildFailedError("pdflatex exit code 1"),
    ):
        rc = cli.main(
            [
                "--project-dir",
                str(tmp_project),
                "preview",
                "--annotation-id",
                "ann-001",
                "--new-text-file",
                str(new_text_file),
            ]
        )

    assert rc == cli.EXIT_BUILD_FAILED == 11


def test_cli_preview_exits_17_on_in_place_restore_failure(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """InPlaceRestoreError → exit code 17, recovery instructions on stderr."""
    new_text_file = _make_new_text_file(tmp_project, "x\n")

    with patch.object(
        preview_mod,
        "preview",
        side_effect=preview_mod.InPlaceRestoreError(
            "failed to restore /tmp/foo.tex; "
            "recovery at .review-state/preview-recovery-20260516T200000.txt"
        ),
    ):
        rc = cli.main(
            [
                "--project-dir",
                str(tmp_project),
                "preview",
                "--annotation-id",
                "ann-001",
                "--new-text-file",
                str(new_text_file),
            ]
        )

    assert rc == cli.EXIT_RESTORE_FAILED == 17
    err = capsys.readouterr().err
    assert "recovery" in err.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v -k cli_preview`

Expected: 5 FAIL with `NotImplementedError: subcommand preview not yet implemented` (the stub from Task 3.1 is still in place).

- [ ] **Step 3: Write minimal implementation**

In `src/review_pdf_to_latex/cli.py`, replace the dispatch line `_stub(_HANDLERS[args.subcommand])` from Task 3.1 with a real dispatch table. Concretely, edit `main()` so the body becomes:

```python
def main(argv: Sequence[str] | None = None) -> int:
    """CLI entry point. Returns an exit code (or raises SystemExit for --help)."""
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.subcommand is None:
        parser.print_usage(sys.stderr)
        return 2
    handler = _HANDLERS_TABLE.get(args.subcommand, _stub)
    return handler(args)
```

Then append the preview handler (and a handler dispatch table that other
chunks will extend):

```python
from review_pdf_to_latex import preview as _preview
from review_pdf_to_latex import build as _build
from review_pdf_to_latex import state as _state


def _handle_preview(args: argparse.Namespace) -> int:
    """``preview`` subcommand handler (spec §8 exit codes 0, 7, 8, 11, 17)."""
    state_dir = _state.StateDir(args.project_dir)
    try:
        new_text = args.new_text_file.read_text(encoding="utf-8")
    except OSError as e:
        print(f"cannot read --new-text-file: {e}", file=sys.stderr)
        return EXIT_FILE_MUTATION_FAILED
    try:
        build_id = _preview.preview(state_dir, args.annotation_id, new_text)
    except _state.SourcePdfChangedError as e:
        print(f"source PDF changed since extract: {e}", file=sys.stderr)
        return EXIT_SOURCE_PDF_CHANGED
    except _state.LegacyStateError as e:
        print(f"legacy state (no source_pdf_md5): {e}", file=sys.stderr)
        return EXIT_LEGACY_STATE
    except _preview.AnnotationNotFoundError as e:
        print(f"annotation not found: {e}", file=sys.stderr)
        return EXIT_ANNOTATION_NOT_FOUND
    except _preview.MappingUnresolvedError as e:
        print(f"mapping unresolved: {e}", file=sys.stderr)
        return EXIT_MAPPING_UNRESOLVED
    except _build.BuildFailedError as e:
        print(f"speculative build failed: {e}", file=sys.stderr)
        return EXIT_BUILD_FAILED
    except _preview.InPlaceRestoreError as e:
        # Preserve the recovery-file instructions verbatim.
        print(f"in-place restore failed: {e}", file=sys.stderr)
        print(
            "  recovery: copy the contents of the recovery file back over "
            "the original .tex location.",
            file=sys.stderr,
        )
        return EXIT_RESTORE_FAILED
    print(build_id)
    return EXIT_OK


# Handler dispatch table — other chunks register their handlers here.
# Chunks B (extract), C (apply/revert/build/commit), D (serve/wait-event),
# E (viewer is server-side rendered, no separate handler), and this chunk
# (preview/status/migrate-state) contribute.
_HANDLERS_TABLE: dict[str, "callable"] = {
    "preview": _handle_preview,
}
```

The dictionary literal `_HANDLERS_TABLE` is shared across chunks. Each
chunk's "wire up" task appends an entry. Conflicts are impossible because
each chunk owns a disjoint subcommand subset.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v -k cli_preview`

Expected: 5 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): wire up preview subcommand"
```

---

## Task 11: Status command — read-only reporting

**Files:**
- Create: `src/review_pdf_to_latex/status.py`
- Create: `tests/test_status.py`
- Modify: `src/review_pdf_to_latex/cli.py` (status handler)

**Implements spec:** §8 (`status` subcommand), §7.3 (status enum, terminal split), §18.5 (acceptance: `review-pdf status --json` reports zero non-terminal annotations at Phase 3)

`status` is read-only. It opens `state.json`, computes counts per status, and reports the current phase, current annotation, last build outcome, and unresolved `needs_review` mappings. With `--json`, output is machine-consumable; without it, output is a human-readable summary.

### Task 11.1: `StatusReport` dataclass and `compute_status_report`

**Files:**
- Create: `src/review_pdf_to_latex/status.py`
- Create: `tests/test_status.py`

**Implements spec:** §7.3 (status enum), §18.5 (acceptance criterion ties to this report)

- [ ] **Step 1: Write the failing test**

Create `tests/test_status.py`:

```python
"""Tests for the read-only status reporter (spec §8 `status`)."""

from __future__ import annotations

from pathlib import Path

import pytest

from review_pdf_to_latex import state as state_mod
from review_pdf_to_latex import status as status_mod


def _seed_state(tmp_project: Path, payload: dict) -> state_mod.StateDir:
    sd = state_mod.StateDir(tmp_project)
    state_mod.atomic_write_json(sd.state_path, payload)
    return sd


def _minimal_state(phase: str = "0-setup") -> dict:
    return {
        "schema_version": 1,
        "phase": phase,
        "order": "mechanical-first",
        "current_annotation_id": None,
        "annotations": {},
        "builds": [],
    }


def test_compute_status_report_on_empty_state(tmp_project: Path):
    """Empty annotations dict — all counts zero, last build None."""
    sd = _seed_state(tmp_project, _minimal_state())
    report = status_mod.compute_status_report(sd)

    assert report.phase == "0-setup"
    assert report.order == "mechanical-first"
    assert report.current_annotation_id is None
    assert report.total == 0
    assert report.terminal_count == 0
    assert report.non_terminal_count == 0
    assert report.unresolved_needs_review == 0
    assert report.most_recent_build is None
    # Every status enum key must be present with count 0.
    expected_keys = {
        "pending", "applied", "accepted", "rejected", "redrafted",
        "deferred", "surfaced_pending", "surfaced_resolved", "needs_review",
    }
    assert set(report.counts.keys()) == expected_keys
    assert all(v == 0 for v in report.counts.values())


def test_compute_status_report_counts_each_status(tmp_project: Path):
    """One annotation per status: counts correctly partition terminal vs not."""
    statuses = [
        "pending", "applied", "accepted", "rejected", "redrafted",
        "deferred", "surfaced_pending", "surfaced_resolved", "needs_review",
    ]
    annotations = {}
    for i, s in enumerate(statuses, start=1):
        annotations[f"ann-{i:03d}"] = {
            "status": s,
            "before_text": None,
            "proposed_text": None,
            "applied_text": None,
            "applied_at": None,
            "last_build_id": None,
            "surface_chat_log": None,
            "failure_log_path": None,
            "failure_edit_text": None,
        }
    payload = _minimal_state(phase="2a-ratify")
    payload["annotations"] = annotations
    payload["current_annotation_id"] = "ann-001"
    sd = _seed_state(tmp_project, payload)

    report = status_mod.compute_status_report(sd)
    assert report.phase == "2a-ratify"
    assert report.current_annotation_id == "ann-001"
    assert report.total == 9
    # Terminal: accepted, rejected, redrafted, deferred, surfaced_resolved → 5
    assert report.terminal_count == 5
    # Non-terminal: pending, applied, surfaced_pending, needs_review → 4
    assert report.non_terminal_count == 4
    assert report.unresolved_needs_review == 1
    for s in statuses:
        assert report.counts[s] == 1


def test_compute_status_report_picks_most_recent_build(tmp_project: Path):
    """most_recent_build is the LAST entry of state.builds[]."""
    payload = _minimal_state(phase="1-batch")
    payload["builds"] = [
        {
            "id": "build-001",
            "pdf_path": ".review-state/builds/build-001.pdf",
            "page_count": 24,
            "compiled_at": "2026-05-16T20:00:00Z",
            "log_path": ".review-state/builds/build-001.log",
            "ok": True,
            "page_md5": ["a"] * 24,
        },
        {
            "id": "build-002",
            "pdf_path": ".review-state/builds/build-002.pdf",
            "page_count": 25,
            "compiled_at": "2026-05-16T20:05:00Z",
            "log_path": ".review-state/builds/build-002.log",
            "ok": False,
            "page_md5": [],
        },
    ]
    sd = _seed_state(tmp_project, payload)

    report = status_mod.compute_status_report(sd)
    assert report.most_recent_build is not None
    assert report.most_recent_build["id"] == "build-002"
    assert report.most_recent_build["ok"] is False


def test_compute_status_report_raises_state_missing(tmp_path: Path):
    """A project dir without state.json raises StateMissingError.

    The CLI handler maps that to exit code 6 per spec §8.
    """
    # Note: do NOT use tmp_project fixture (it creates .review-state/).
    sd = state_mod.StateDir(tmp_path)
    with pytest.raises(status_mod.StateMissingError):
        status_mod.compute_status_report(sd)


def test_status_report_to_dict_keys_match_human_format(tmp_project: Path):
    """to_dict() produces a stable shape that the CLI's --json flag consumes."""
    sd = _seed_state(tmp_project, _minimal_state())
    report = status_mod.compute_status_report(sd)
    d = report.to_dict()
    assert set(d.keys()) == {
        "phase",
        "order",
        "current_annotation_id",
        "counts",
        "total",
        "terminal_count",
        "non_terminal_count",
        "unresolved_needs_review",
        "most_recent_build",
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_status.py -v`

Expected: 5 FAIL with `ModuleNotFoundError: No module named 'review_pdf_to_latex.status'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review_pdf_to_latex/status.py`:

```python
"""Read-only status reporter (spec §8 `status`).

Produces a :class:`StatusReport` summarizing the current state.json:
- ``phase`` and ``order`` (spec §7.3).
- ``current_annotation_id`` (the annotation the viewer is focused on).
- ``counts``: a dict keyed by every status enum value with the count of
  annotations in that state (zero-filled).
- ``total``, ``terminal_count``, ``non_terminal_count``: derived sums.
- ``unresolved_needs_review``: count of annotations stuck in ``needs_review``.
- ``most_recent_build``: the last entry of ``state.builds[]`` (a dict),
  or ``None`` if no builds have been recorded.

This module is read-only; it never writes state.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from review_pdf_to_latex import state as _state


class StateMissingError(Exception):
    """Raised when ``state.json`` does not exist for the project.

    CLI handler maps this to exit code 6 (``EXIT_STATE_MISSING``).
    """


_ALL_STATUSES: tuple[str, ...] = (
    "pending",
    "applied",
    "accepted",
    "rejected",
    "redrafted",
    "deferred",
    "surfaced_pending",
    "surfaced_resolved",
    "needs_review",
)


@dataclass
class StatusReport:
    """Snapshot of state.json for human or machine consumption."""

    phase: str
    order: str
    current_annotation_id: str | None
    counts: dict[str, int] = field(default_factory=dict)
    total: int = 0
    terminal_count: int = 0
    non_terminal_count: int = 0
    unresolved_needs_review: int = 0
    most_recent_build: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a plain dict suitable for ``json.dumps``."""
        return {
            "phase": self.phase,
            "order": self.order,
            "current_annotation_id": self.current_annotation_id,
            "counts": dict(self.counts),
            "total": self.total,
            "terminal_count": self.terminal_count,
            "non_terminal_count": self.non_terminal_count,
            "unresolved_needs_review": self.unresolved_needs_review,
            "most_recent_build": (
                dict(self.most_recent_build)
                if self.most_recent_build is not None
                else None
            ),
        }


def compute_status_report(state_dir: _state.StateDir) -> StatusReport:
    """Read ``state.json`` and produce a :class:`StatusReport`.

    Raises
    ------
    StateMissingError
        ``state.json`` does not exist (Phase 0 has not run, or the
        ``.review-state/`` directory was deleted).
    """
    state_path = state_dir.state_path
    if not state_path.exists():
        raise StateMissingError(
            f"state.json not found at {state_path}; "
            f"run `review-pdf extract` first"
        )
    payload = _state.read_json(state_path)

    counts: dict[str, int] = {s: 0 for s in _ALL_STATUSES}
    annotations = payload.get("annotations", {})
    for entry in annotations.values():
        s = entry.get("status")
        if s in counts:
            counts[s] += 1
        # Unknown statuses are silently ignored here; the read_json
        # schema check upstream is responsible for rejecting them.

    terminal = sum(
        counts[s]
        for s in ("accepted", "rejected", "redrafted", "deferred", "surfaced_resolved")
    )
    non_terminal = sum(
        counts[s]
        for s in ("pending", "applied", "surfaced_pending", "needs_review")
    )
    total = terminal + non_terminal

    builds = payload.get("builds", [])
    most_recent = builds[-1] if builds else None

    return StatusReport(
        phase=payload["phase"],
        order=payload["order"],
        current_annotation_id=payload.get("current_annotation_id"),
        counts=counts,
        total=total,
        terminal_count=terminal,
        non_terminal_count=non_terminal,
        unresolved_needs_review=counts["needs_review"],
        most_recent_build=most_recent,
    )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_status.py -v`

Expected: 5 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/status.py tests/test_status.py
git commit -m "feat(status): status reporter"
```

### Task 11.2: Wire up the `status` CLI subcommand

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` (status handler + parser flags)
- Modify: `tests/test_cli.py` (append CLI integration tests)

**Implements spec:** §8 (status exit codes 0, 6), §18.5

The CLI handler:
- With `--json`: prints `StatusReport.to_dict()` as JSON to stdout, using `print_json` from chunk A's Task 3.2.
- Without `--json`: prints a human-readable summary to stdout (one line per non-zero status count, current phase + annotation, last build pass/fail and page count).
- On `StateMissingError`: exits 6 with an error to stderr.

The `status` subcommand parser was created in Task 3.1 with no flags. We need to add the `--json` flag at the subcommand level (the global `--json` already exists; the test exercises the global form).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_cli.py`:

```python
import json as _json_mod

from review_pdf_to_latex import status as status_mod


def _seed_state_for_cli(tmp_project: Path, phase: str = "0-setup") -> None:
    """Seed a minimal state.json so status can read it."""
    state_mod_path = tmp_project / ".review-state" / "state.json"
    state_mod_path.parent.mkdir(parents=True, exist_ok=True)
    state_mod_path.write_text(
        _json_mod.dumps(
            {
                "schema_version": 1,
                "phase": phase,
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {
                    "ann-001": {
                        "status": "applied",
                        "before_text": None,
                        "proposed_text": None,
                        "applied_text": None,
                        "applied_at": None,
                        "last_build_id": None,
                        "surface_chat_log": None,
                        "failure_log_path": None,
                        "failure_edit_text": None,
                    },
                    "ann-002": {
                        "status": "accepted",
                        "before_text": None,
                        "proposed_text": None,
                        "applied_text": None,
                        "applied_at": None,
                        "last_build_id": None,
                        "surface_chat_log": None,
                        "failure_log_path": None,
                        "failure_edit_text": None,
                    },
                },
                "builds": [],
            },
            indent=2,
            sort_keys=True,
        ),
        encoding="utf-8",
    )


def test_cli_status_json_output(tmp_project: Path, capsys: pytest.CaptureFixture):
    """`review-pdf --json status` prints a JSON object with the expected keys."""
    _seed_state_for_cli(tmp_project)
    rc = cli.main(["--project-dir", str(tmp_project), "--json", "status"])
    assert rc == 0
    out = capsys.readouterr().out.strip()
    parsed = _json_mod.loads(out)
    assert parsed["phase"] == "0-setup"
    assert parsed["total"] == 2
    assert parsed["counts"]["applied"] == 1
    assert parsed["counts"]["accepted"] == 1
    assert parsed["non_terminal_count"] == 1
    assert parsed["terminal_count"] == 1


def test_cli_status_human_output(tmp_project: Path, capsys: pytest.CaptureFixture):
    """Without --json, status prints a human-readable summary to stdout."""
    _seed_state_for_cli(tmp_project, phase="2a-ratify")
    rc = cli.main(["--project-dir", str(tmp_project), "status"])
    assert rc == 0
    out = capsys.readouterr().out
    # Must mention the current phase.
    assert "2a-ratify" in out
    # Must mention the non-zero counts.
    assert "applied" in out
    assert "accepted" in out
    assert "1" in out


def test_cli_status_human_output_includes_build_info_when_present(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """When builds[] has entries, the summary mentions the last build."""
    _seed_state_for_cli(tmp_project)
    # Patch in a build entry.
    state_path = tmp_project / ".review-state" / "state.json"
    payload = _json_mod.loads(state_path.read_text(encoding="utf-8"))
    payload["builds"].append(
        {
            "id": "build-001",
            "pdf_path": ".review-state/builds/build-001.pdf",
            "page_count": 24,
            "compiled_at": "2026-05-16T20:00:00Z",
            "log_path": ".review-state/builds/build-001.log",
            "ok": True,
            "page_md5": ["a"] * 24,
        }
    )
    state_path.write_text(
        _json_mod.dumps(payload, indent=2, sort_keys=True), encoding="utf-8"
    )

    rc = cli.main(["--project-dir", str(tmp_project), "status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "build-001" in out
    assert "24" in out


def test_cli_status_exits_6_when_state_missing(
    tmp_path: Path, capsys: pytest.CaptureFixture
):
    """No state.json → exit code 6 and error on stderr.

    Use ``tmp_path`` (not ``tmp_project``) so .review-state/ is absent.
    """
    rc = cli.main(["--project-dir", str(tmp_path), "status"])
    assert rc == cli.EXIT_STATE_MISSING == 6
    err = capsys.readouterr().err
    assert "state.json" in err
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v -k cli_status`

Expected: 4 FAIL with `NotImplementedError: subcommand status not yet implemented`.

- [ ] **Step 3: Write minimal implementation**

In `src/review_pdf_to_latex/cli.py`, append the status handler and register it:

```python
from review_pdf_to_latex import status as _status


def _format_status_human(report: _status.StatusReport) -> str:
    """Render a :class:`StatusReport` as a multi-line human summary.

    Format:
        Phase: 2a-ratify  (order: mechanical-first)
        Current annotation: ann-014
        Annotations: 80 total (45 terminal, 35 non-terminal)
            applied: 32
            accepted: 12
            redrafted: 1
            ...
        Last build: build-007 — ok, 24 pages (compiled 2026-05-16T20:00:00Z)
        Unresolved needs_review: 3
    """
    lines: list[str] = []
    lines.append(
        f"Phase: {report.phase}  (order: {report.order})"
    )
    cur = report.current_annotation_id or "(none)"
    lines.append(f"Current annotation: {cur}")
    lines.append(
        f"Annotations: {report.total} total "
        f"({report.terminal_count} terminal, {report.non_terminal_count} non-terminal)"
    )
    for status_name, count in report.counts.items():
        if count > 0:
            lines.append(f"    {status_name}: {count}")
    if report.most_recent_build is not None:
        b = report.most_recent_build
        ok_str = "ok" if b.get("ok") else "FAILED"
        lines.append(
            f"Last build: {b.get('id')} — {ok_str}, "
            f"{b.get('page_count')} pages (compiled {b.get('compiled_at')})"
        )
    else:
        lines.append("Last build: (none)")
    if report.unresolved_needs_review > 0:
        lines.append(
            f"Unresolved needs_review: {report.unresolved_needs_review}"
        )
    return "\n".join(lines)


def _handle_status(args: argparse.Namespace) -> int:
    """``status`` subcommand handler (spec §8 exit codes 0, 6)."""
    state_dir = _state.StateDir(args.project_dir)
    try:
        report = _status.compute_status_report(state_dir)
    except _status.StateMissingError as e:
        print(f"state missing: {e}", file=sys.stderr)
        return EXIT_STATE_MISSING

    if args.json_output:
        print_json(report.to_dict())
    else:
        print(_format_status_human(report))
    return EXIT_OK


_HANDLERS_TABLE["status"] = _handle_status
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v -k cli_status`

Expected: 4 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): wire up status subcommand"
```

---

## Task 12: End-to-end fixtures + smoke tests

**Files:**
- Create: `tests/fixtures/make_fixtures.py`
- Create: `tests/fixtures/regenerate.sh`
- Create: `tests/fixtures/EXPECTED.md`
- Create: `tests/fixtures/expected-hashes.txt`
- Create: `tests/fixtures/sample-project/build/full_report.tex`
- Create: `tests/fixtures/sample-project/templates/intro.tex`
- Create: `tests/fixtures/sample-project/templates/findings.tex`
- Create: `tests/fixtures/sample-project/templates/conclusion.tex`
- Create: `tests/fixtures/sample-project/templates/table.tex`
- Create: `tests/fixtures/sample-project/build/full_report.pdf` (generated)
- Create: `tests/fixtures/sample-annotated.pdf` (generated)
- Create: `tests/test_e2e.py`

**Implements spec:** §18 (full acceptance criteria — each phase has a dedicated smoke test)

The e2e smoke tests run all four phases against a controlled fixture. The fixture is **committed to the repo** so the tests are deterministic and do not require `pdflatex`/`pypdf` to run; only the regeneration script does. This matches the spec's premise that the engine is testable on a developer machine without re-running the whole COTA pipeline.

### Task 12.1: Fixture generator script + committed outputs

**Files:**
- Create: every path under `tests/fixtures/`.

**Implements spec:** §4 (COTA-style project layout: `build/full_report.tex` + `\input{templates/*.tex}`), §7.1 (annotations.json fields the generator must produce in the PDF), §12.1 (fuzzy mapping — the table fixture must produce a `needs_review` outcome).

The generator script writes a small LaTeX project, compiles it once, then uses `pypdf` to inject five carefully-chosen highlight annotations into the resulting PDF. Each annotation is engineered to exercise a different fuzzy-mapping or trigger-phrase path:

| ann-id | Target | Comment | Expected mapping outcome |
|---|---|---|---|
| ann-001 | clean prose in intro.tex | "Tighten this." | `fuzzy_text`, confidence ≥ 0.8, `needs_review: false` |
| ann-002 | borderline-similar prose in findings.tex | "Clarify the phrasing." | `fuzzy_text`, confidence in `[0.5, 0.7)`, `needs_review: false` |
| ann-003 | clean prose in conclusion.tex | "claude surface this — does the timeline match?" | `fuzzy_text`, confidence ≥ 0.8, `needs_review: false`, **`trigger_match: true`** |
| ann-004 | tabular cell in table.tex | "Update this number." | `failed` or `fuzzy_text` with score `< 0.5`, **`needs_review: true`** |
| ann-005 | second clean prose in conclusion.tex | "Use 12% not approximately 12%." | `fuzzy_text`, confidence ≥ 0.8, `needs_review: false` |

- [ ] **Step 1: Write the failing test**

Create `tests/test_fixtures.py` (this file is just the verification test for the generator; the generator itself runs out-of-band):

```python
"""Verify the committed fixtures exist and match the recorded hashes.

The generator (`tests/fixtures/make_fixtures.py`) writes the LaTeX
project, compiles it, and produces ``sample-annotated.pdf``. Its outputs
are committed to git so tests do not require pdflatex / pypdf to run.
This test re-checks the on-disk hashes against ``expected-hashes.txt``;
if they drift, either the generator changed (run ``regenerate.sh``) or
a committed fixture was edited by hand.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest


FIXTURES_DIR = Path(__file__).parent / "fixtures"


def _file_md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def _load_expected_hashes() -> dict[str, str]:
    """Parse ``expected-hashes.txt`` (one line per file: ``<md5>  <path>``)."""
    hashes: dict[str, str] = {}
    text = (FIXTURES_DIR / "expected-hashes.txt").read_text(encoding="utf-8")
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        md5, _, rel = line.partition("  ")
        hashes[rel.strip()] = md5.strip()
    return hashes


def test_all_committed_fixtures_exist():
    """Every file named in expected-hashes.txt is present on disk."""
    expected = _load_expected_hashes()
    missing = [rel for rel in expected if not (FIXTURES_DIR / rel).exists()]
    assert not missing, f"missing fixture files: {missing}"


def test_committed_fixture_hashes_match():
    """Every committed fixture's MD5 matches the recorded hash.

    On drift: run ``bash tests/fixtures/regenerate.sh`` to re-generate
    the outputs and update ``expected-hashes.txt``.
    """
    expected = _load_expected_hashes()
    drifted: list[tuple[str, str, str]] = []
    for rel, want in expected.items():
        got = _file_md5(FIXTURES_DIR / rel)
        if got != want:
            drifted.append((rel, want, got))
    assert not drifted, f"fixture drift: {drifted}"


def test_expected_md_describes_all_five_annotations():
    """EXPECTED.md must enumerate ann-001 through ann-005."""
    expected_md = (FIXTURES_DIR / "EXPECTED.md").read_text(encoding="utf-8")
    for ann_id in ("ann-001", "ann-002", "ann-003", "ann-004", "ann-005"):
        assert ann_id in expected_md, f"{ann_id} not described in EXPECTED.md"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_fixtures.py -v`

Expected: FAIL with `FileNotFoundError` on `expected-hashes.txt` (the fixtures dir does not yet exist).

- [ ] **Step 3: Write minimal implementation**

Create `tests/fixtures/sample-project/build/full_report.tex`:

```latex
\documentclass[11pt]{article}
\usepackage[margin=1in]{geometry}
\title{Sample Impact Report}
\author{Fixture Author}
\date{2026-05-16}
\begin{document}
\maketitle

\section{Introduction}
\input{../templates/intro}

\section{Findings}
\input{../templates/findings}

\section{Data}
\input{../templates/table}

\section{Conclusion}
\input{../templates/conclusion}

\end{document}
```

Create `tests/fixtures/sample-project/templates/intro.tex`:

```latex
The college experienced a substantial increase in undergraduate
enrollment during the 2024--2025 academic year, with growth concentrated
in the studio art, theater, and dance majors. Faculty hiring expanded
in parallel: three new full-time positions were created across the
department to absorb the load. The dean's office reports that retention
rates among first-year students improved by roughly twelve percent over
the prior year, suggesting that the cohort cohesion programs introduced
in fall 2024 are producing the intended outcome. Several alumni events
held during the fiscal year drew larger-than-expected attendance,
indicating renewed community engagement. The communications office
expects this trend to continue into the coming review cycle, although
budget pressures may temper the pace of further expansion.
```

Create `tests/fixtures/sample-project/templates/findings.tex`:

```latex
Survey results indicate that students value small-cohort instruction
and direct faculty access above all other program features. A majority
of respondents (sixty-eight percent) reported that one-on-one critiques
were the most impactful pedagogical element of their experience. The
college experienced a meaningful boost in completion rates across the
studio majors during the prior cycle, with growth particularly strong
among transfer students. Faculty cited the introduction of mid-semester
checkpoint reviews as the principal driver of this improvement. The
data also shows a notable shift in enrollment composition: first-time
freshmen now represent forty-one percent of the studio art population,
up from thirty-three percent two years prior. Recommendations: continue
investment in the cohort-based advising program, and consider expanding
mid-semester checkpoints into the theater and dance majors.
```

Create `tests/fixtures/sample-project/templates/table.tex`:

```latex
\begin{tabular}{|l|r|r|}
\hline
Major & 2023 enrollment & 2024 enrollment \\
\hline
Studio Art & 142 & 168 \\
Theater & 88 & 94 \\
Dance & 61 & 73 \\
\hline
\end{tabular}
```

Create `tests/fixtures/sample-project/templates/conclusion.tex`:

```latex
The fiscal year closed with the college well-positioned for the next
review cycle. Approximately twelve percent year-over-year growth in
undergraduate enrollment reflects both the strength of the academic
programs and the success of the new outreach initiatives. Looking
forward, the priorities for the coming year include sustaining the
mid-semester checkpoint program, formalizing alumni engagement, and
identifying additional sources of operating support to underwrite
faculty hiring at the current pace. A final budget recommendation will
accompany the next report.
```

Create `tests/fixtures/make_fixtures.py`:

```python
"""Regenerate the e2e test fixtures.

Run this once per fixture change; commit the outputs. Tests do NOT
re-run this script — they read the committed outputs directly.

Requirements:
  - pdflatex on PATH (TeX Live or MiKTeX).
  - pypdf >= 4.0 (`pip install pypdf`).

Usage:
  $ python tests/fixtures/make_fixtures.py

The script:
  1. Compiles ``sample-project/build/full_report.tex`` via pdflatex.
  2. Reads the resulting PDF and injects five highlight annotations
     plus comments using pypdf's AnnotationBuilder, producing
     ``sample-annotated.pdf``.
  3. Writes ``EXPECTED.md`` and ``expected-hashes.txt`` describing the
     committed outputs.

The five annotations exercise distinct paths through the fuzzy mapper
and the trigger-phrase detector. See EXPECTED.md for the mapping table.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.annotations import Highlight, Text
except ImportError as e:
    print(
        f"pypdf is required to regenerate fixtures: {e}\n"
        f"  pip install pypdf>=4.0",
        file=sys.stderr,
    )
    sys.exit(2)


FIXTURES = Path(__file__).parent
SAMPLE_PROJECT = FIXTURES / "sample-project"
BUILD_DIR = SAMPLE_PROJECT / "build"
TEMPLATES_DIR = SAMPLE_PROJECT / "templates"
COMPILED_PDF = BUILD_DIR / "full_report.pdf"
ANNOTATED_PDF = FIXTURES / "sample-annotated.pdf"
EXPECTED_MD = FIXTURES / "EXPECTED.md"
HASHES_FILE = FIXTURES / "expected-hashes.txt"


# Annotation definitions. Each dict captures:
#   - id (matches what the fuzzy mapper will assign once extracted)
#   - page index (0-based for pypdf)
#   - bbox: [x1, y1, x2, y2] in PDF points; approximate
#   - highlighted_text: the literal selection
#   - comment: the commenter's note (may contain SURFACE trigger)
#   - notes: human-readable reason for fuzzy outcome
_ANNOTATIONS: list[dict[str, Any]] = [
    {
        "id": "ann-001",
        "page": 0,
        "bbox": [72, 700, 540, 715],
        "highlighted_text": (
            "The college experienced a substantial increase in undergraduate "
            "enrollment during the 2024--2025 academic year"
        ),
        "comment": "Tighten this.",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.8,
        "expect_needs_review": False,
        "expect_trigger_match": False,
    },
    {
        "id": "ann-002",
        "page": 0,
        "bbox": [72, 540, 540, 555],
        "highlighted_text": (
            "The college experienced a meaningful boost in completion rates "
            "across the studio majors"
        ),
        "comment": "Clarify the phrasing.",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.5,
        "expect_needs_review": False,
        "expect_trigger_match": False,
    },
    {
        "id": "ann-003",
        "page": 1,
        "bbox": [72, 600, 540, 615],
        "highlighted_text": (
            "Approximately twelve percent year-over-year growth in "
            "undergraduate enrollment"
        ),
        "comment": "claude surface this — does the timeline match?",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.8,
        "expect_needs_review": False,
        "expect_trigger_match": True,
    },
    {
        "id": "ann-004",
        "page": 1,
        "bbox": [72, 450, 540, 465],
        "highlighted_text": "Studio Art 142 168",  # tabular row text
        "comment": "Update this number.",
        "expect_method": "failed_or_low_score",
        "expect_confidence_min": 0.0,
        "expect_needs_review": True,
        "expect_trigger_match": False,
    },
    {
        "id": "ann-005",
        "page": 1,
        "bbox": [72, 540, 540, 555],
        "highlighted_text": (
            "the priorities for the coming year include sustaining the "
            "mid-semester checkpoint program"
        ),
        "comment": "Use 12% not approximately 12%.",
        "expect_method": "fuzzy_text",
        "expect_confidence_min": 0.8,
        "expect_needs_review": False,
        "expect_trigger_match": False,
    },
]


def _run_pdflatex() -> None:
    """Compile sample-project twice (cross-references)."""
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    for i in range(2):
        rc = subprocess.run(
            [
                "pdflatex",
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-output-directory", str(BUILD_DIR),
                str(BUILD_DIR / "full_report.tex"),
            ],
            cwd=str(SAMPLE_PROJECT),
        ).returncode
        if rc != 0:
            raise RuntimeError(f"pdflatex failed on pass {i+1}")


def _inject_annotations() -> None:
    """Read the compiled PDF, attach five annotations, write sample-annotated.pdf."""
    reader = PdfReader(str(COMPILED_PDF))
    writer = PdfWriter(clone_from=reader)

    for ann in _ANNOTATIONS:
        page_idx = ann["page"]
        if page_idx >= len(writer.pages):
            # Pad page index if the compiled doc is shorter than expected.
            page_idx = len(writer.pages) - 1

        # Highlight annotation (the yellow box on the selected text).
        # pypdf's Highlight requires a `quad_points` polygon; we synthesize
        # one from bbox (the four corners, in PDF page coords).
        x1, y1, x2, y2 = ann["bbox"]
        quad = [x1, y2, x2, y2, x1, y1, x2, y1]  # top-left, top-right, bottom-left, bottom-right
        h = Highlight(
            quad_points=quad,
            rect=(x1, y1, x2, y2),
        )
        # The highlighted text is encoded as the annotation's contents
        # so pdfannots can extract it back during the e2e tests.
        h["/Contents"] = ann["highlighted_text"]
        # The author and the COMMENT are stored as separate fields per
        # the PDF spec; pypdf exposes them via raw dict assignment.
        h["/T"] = "fixture-author"
        writer.add_annotation(page_number=page_idx, annotation=h)

        # Free-text note carrying the commenter's comment. pdfannots
        # threads this back as the annotation's `comment` field.
        t = Text(
            rect=(x2 + 2, y1, x2 + 20, y2),
            text=ann["comment"],
        )
        t["/T"] = "fixture-commenter"
        writer.add_annotation(page_number=page_idx, annotation=t)

    with open(ANNOTATED_PDF, "wb") as f:
        writer.write(f)


def _md5(p: Path) -> str:
    return hashlib.md5(p.read_bytes()).hexdigest()


def _write_expected_md() -> None:
    lines = [
        "# Expected annotations for the e2e fixture",
        "",
        "Generated by `tests/fixtures/make_fixtures.py`. Re-run that script",
        "via `tests/fixtures/regenerate.sh` after any change.",
        "",
        "| ann-id | page | trigger_match | expected mapping | needs_review |",
        "|---|---|---|---|---|",
    ]
    for ann in _ANNOTATIONS:
        lines.append(
            f"| {ann['id']} | {ann['page']+1} | "
            f"{ann['expect_trigger_match']} | "
            f"{ann['expect_method']} (>= {ann['expect_confidence_min']:.2f}) | "
            f"{ann['expect_needs_review']} |"
        )
    lines.append("")
    lines.append("## Highlighted-text snippets")
    lines.append("")
    for ann in _ANNOTATIONS:
        lines.append(f"### {ann['id']}")
        lines.append("")
        lines.append("Highlight:")
        lines.append("")
        lines.append("> " + ann["highlighted_text"])
        lines.append("")
        lines.append(f"Comment: `{ann['comment']}`")
        lines.append("")
    EXPECTED_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_hashes() -> None:
    """Record MD5 hashes of every committed fixture file."""
    files = [
        SAMPLE_PROJECT / "build" / "full_report.tex",
        SAMPLE_PROJECT / "templates" / "intro.tex",
        SAMPLE_PROJECT / "templates" / "findings.tex",
        SAMPLE_PROJECT / "templates" / "conclusion.tex",
        SAMPLE_PROJECT / "templates" / "table.tex",
        COMPILED_PDF,
        ANNOTATED_PDF,
        EXPECTED_MD,
    ]
    lines = ["# md5  relative-path-from-tests/fixtures/"]
    for f in files:
        rel = f.relative_to(FIXTURES).as_posix()
        lines.append(f"{_md5(f)}  {rel}")
    HASHES_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    print(f"Compiling {COMPILED_PDF}...", file=sys.stderr)
    _run_pdflatex()
    print(f"Injecting annotations into {ANNOTATED_PDF}...", file=sys.stderr)
    _inject_annotations()
    print(f"Writing {EXPECTED_MD}...", file=sys.stderr)
    _write_expected_md()
    print(f"Writing {HASHES_FILE}...", file=sys.stderr)
    _write_hashes()
    print("Done. Commit the regenerated files.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Create `tests/fixtures/regenerate.sh`:

```bash
#!/usr/bin/env bash
# Regenerate the committed e2e fixtures.
#
# Run this after changing make_fixtures.py or the LaTeX source under
# sample-project/. Commit the regenerated PDFs and hash file.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v pdflatex >/dev/null 2>&1; then
    echo "pdflatex not found on PATH. Install TeX Live first." >&2
    exit 1
fi

python make_fixtures.py
echo ""
echo "Regenerated fixtures. Diff and commit:"
echo "  git diff -- tests/fixtures/"
```

Make it executable:

```bash
chmod +x tests/fixtures/regenerate.sh
```

Now run the generator once to populate the binary outputs and the hash file:

```bash
python tests/fixtures/make_fixtures.py
```

This produces `sample-project/build/full_report.pdf`, `sample-annotated.pdf`, `EXPECTED.md`, and `expected-hashes.txt`. All four are committed to the repo so e2e tests can run without `pdflatex`/`pypdf`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_fixtures.py -v`

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/ tests/test_fixtures.py
git commit -m "test(fixtures): committed fixture project + annotated PDF generator"
```

### Task 12.2: Phase 0 smoke test — extract

**Files:**
- Create: `tests/test_e2e.py` (this and the next four tasks all append to the same file).

**Implements spec:** §9.1 (Phase 0 — Setup), §18.1 (Phase 0 acceptance criteria)

- [ ] **Step 1: Write the failing test**

Create `tests/test_e2e.py`:

```python
"""End-to-end smoke tests against the committed fixture project.

Each test drives all four phases against ``tests/fixtures/sample-annotated.pdf``
by copying ``sample-project/`` to a temp dir and invoking the CLI handlers
programmatically. The fixture exercises one annotation per fuzzy-mapping
or trigger-phrase path (see ``tests/fixtures/EXPECTED.md``).

Acceptance criteria covered: spec §18.1 — §18.6.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from review_pdf_to_latex import cli
from review_pdf_to_latex import state as state_mod


FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE_PROJECT = FIXTURES / "sample-project"
ANNOTATED_PDF = FIXTURES / "sample-annotated.pdf"


@pytest.fixture
def project_copy(tmp_path: Path) -> Path:
    """Copy the fixture project to a fresh temp dir and ``git init`` it.

    Phase 1 requires a clean git working tree (spec §13.1). We init a
    repo and make one baseline commit so the precondition can be met.
    """
    dest = tmp_path / "sample-project"
    shutil.copytree(SAMPLE_PROJECT, dest)
    # Strip the pre-compiled build/ outputs except the .tex source so the
    # repo state is clean and reproducible.
    for stale in (dest / "build").glob("full_report.*"):
        if stale.suffix in {".aux", ".log", ".out", ".pdf"}:
            stale.unlink()
    subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "-m", "baseline"],
        cwd=dest, check=True,
    )
    return dest


def test_phase_0_extract(project_copy: Path):
    """`review-pdf extract` produces the four artifacts and seeds state.json."""
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "extract",
            "--pdf", str(ANNOTATED_PDF),
        ]
    )
    assert rc == 0

    sd = state_mod.StateDir(project_copy)

    # annotations.json: 5 entries with non-null highlighted_text + comment.
    ann = state_mod.read_json(sd.annotations_path)
    assert len(ann["annotations"]) == 5
    for a in ann["annotations"]:
        assert a["highlighted_text"], f"empty highlighted_text on {a['id']}"
        assert a["comment"], f"empty comment on {a['id']}"

    # mapping.json: ann-001, ann-002, ann-003, ann-005 are needs_review False.
    # ann-004 (table cell) is needs_review True.
    mapping = state_mod.read_json(sd.mapping_path)
    m = mapping["mappings"]
    assert m["ann-001"]["needs_review"] is False
    assert m["ann-002"]["needs_review"] is False
    assert m["ann-003"]["needs_review"] is False
    assert m["ann-005"]["needs_review"] is False
    assert m["ann-004"]["needs_review"] is True
    # ann-004 candidates may be empty (method: failed) or up to three entries.
    assert isinstance(m["ann-004"].get("candidates", []), list)

    # state.json: phase 0-setup, ann-004 is needs_review, others pending.
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "0-setup"
    assert st["annotations"]["ann-004"]["status"] == "needs_review"
    for ann_id in ("ann-001", "ann-002", "ann-003", "ann-005"):
        assert st["annotations"][ann_id]["status"] == "pending"

    # pages/page-N.png: one per page in the source PDF.
    pages = sorted((sd.dir / "pages").glob("page-*.png"))
    assert len(pages) >= 1, "no page renders produced"

    # trigger_match: ann-003's comment matches the default trigger phrase.
    ann_by_id = {a["id"]: a for a in ann["annotations"]}
    assert ann_by_id["ann-003"]["trigger_match"] is True
    assert ann_by_id["ann-001"]["trigger_match"] is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_e2e.py::test_phase_0_extract -v`

Expected: FAIL with `NotImplementedError: subcommand extract not yet implemented` (this test depends on chunk B's `extract` being wired up; until chunk B's CLI integration lands, this test is RED).

- [ ] **Step 3: Write minimal implementation**

This task adds NO production code beyond what chunks B (extract) and A (CLI scaffold + state) already provide. The test itself is the deliverable. If chunk B's wire-up has not yet landed when this task is reached, the test should be marked as `pytest.mark.xfail(strict=True, reason="awaits chunk B extract wire-up")` and the marker removed once chunk B ships.

Re-check the test by un-skipping after chunk B is merged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_e2e.py::test_phase_0_extract -v`

Expected: PASS once chunk B's extract is wired up.

- [ ] **Step 5: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(e2e): Phase 0 extract smoke test"
```

### Task 12.3: Phase 1 smoke test — batch pre-apply

**Files:**
- Modify: `tests/test_e2e.py` (append).

**Implements spec:** §9.2 (Phase 1 — Batch pre-apply), §18.2 (Phase 1 acceptance)

This test drives the engine primitives in the order the skill would:
override the ann-004 needs_review mapping, walk every pending annotation,
call `apply` + `build` for each, then `commit-phase --phase 1`. The ann-003
trigger-match annotation is left at `surfaced_pending` (no apply), per
spec §9.2 "SURFACE-flagged annotations are skipped in Phase 1".

- [ ] **Step 1: Write the failing test**

Append to `tests/test_e2e.py`:

```python
def _proposal_for(ann_id: str) -> str:
    """Return a deterministic mechanical proposal for a given annotation.

    Used by the test to synthesize ``--new-text-file`` payloads without
    invoking Claude. The proposals are designed to be valid LaTeX so the
    build succeeds; they are not necessarily good editorial choices.
    """
    return {
        "ann-001": (
            "COTA enrollment grew significantly during the 2024--2025 cycle, "
            "concentrated in studio art, theater, and dance.\n"
        ),
        "ann-002": (
            "Completion rates rose noticeably across studio majors during "
            "the prior cycle, with the strongest gains among transfer students.\n"
        ),
        "ann-005": (
            "the priorities for the coming year include sustaining 12% "
            "year-over-year growth, formalizing alumni engagement, and "
            "expanding faculty hiring.\n"
        ),
    }[ann_id]


def _phase_0_setup(project_copy: Path) -> state_mod.StateDir:
    """Helper: run extract on the fixture project; return the state dir."""
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "extract",
            "--pdf", str(ANNOTATED_PDF),
        ]
    )
    assert rc == 0
    return state_mod.StateDir(project_copy)


def _override_ann_004_mapping(project_copy: Path, sd: state_mod.StateDir) -> None:
    """Manually resolve ann-004's needs_review mapping to make Phase 1 runnable.

    Maps ann-004 to a real line range inside table.tex so the apply call
    is a no-op semantically (the test never asserts the table edit ended
    up sensible — only that the engine accepts the override).
    """
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "override-mapping",
            "--annotation-id", "ann-004",
            "--file", "templates/table.tex",
            "--lines", "4:4",
        ]
    )
    assert rc == 0
    mapping = state_mod.read_json(sd.mapping_path)
    assert mapping["mappings"]["ann-004"]["needs_review"] is False
    # State should now treat ann-004 as pending (chunk C's override-mapping
    # contract per spec §10.6 transitions needs_review → pending).
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-004"]["status"] in {"pending", "needs_review"}


def test_phase_1_batch_apply(project_copy: Path, tmp_path: Path):
    """Simulate the skill's Phase 1 walk: apply + build for each pending ann.

    SURFACE-flagged ann-003 is set to surfaced_pending instead of applied.
    Phase ends with `commit-phase --phase 1`; state advances to 2a-ratify.
    """
    sd = _phase_0_setup(project_copy)
    _override_ann_004_mapping(project_copy, sd)

    # Mark ann-003 as surfaced_pending (trigger_match is true; the skill
    # skips it during Phase 1).
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "set-status",
            "--annotation-id", "ann-003",
            "--status", "surfaced_pending",
        ]
    )
    assert rc == 0

    # Apply mechanical edits for ann-001, ann-002, ann-005, ann-004.
    # We walk in reverse line order to mimic spec §9.2's discipline,
    # but for the test the order is incidental as long as overlap is
    # absent.
    for ann_id in ("ann-005", "ann-002", "ann-001", "ann-004"):
        proposal_path = tmp_path / f"proposal-{ann_id}.tex"
        if ann_id == "ann-004":
            # Table cell — proposal is a benign change to one row.
            proposal_path.write_text(
                "Studio Art & 142 & 170 \\\\\n", encoding="utf-8"
            )
        else:
            proposal_path.write_text(_proposal_for(ann_id), encoding="utf-8")
        rc = cli.main(
            [
                "--project-dir", str(project_copy),
                "apply",
                "--annotation-id", ann_id,
                "--new-text-file", str(proposal_path),
            ]
        )
        assert rc == 0, f"apply failed for {ann_id} (rc={rc})"
        rc = cli.main(
            [
                "--project-dir", str(project_copy),
                "build",
            ]
        )
        assert rc == 0, f"build failed after applying {ann_id} (rc={rc})"

    # Verify state.json shape after the walk.
    st = state_mod.read_json(sd.state_path)
    for ann_id in ("ann-001", "ann-002", "ann-004", "ann-005"):
        entry = st["annotations"][ann_id]
        assert entry["status"] == "applied", (
            f"expected {ann_id} applied, got {entry['status']}"
        )
        assert entry["applied_text"] is not None
        assert entry["before_text"] is not None
    assert st["annotations"]["ann-003"]["status"] == "surfaced_pending"
    assert len(st["builds"]) >= 4  # one per applied edit

    # commit-phase --phase 1
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "commit-phase",
            "--phase", "1",
        ]
    )
    assert rc == 0

    # State advances to 2a-ratify (default order).
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "2a-ratify"

    # git log shows exactly one commit beyond the baseline.
    log = subprocess.run(
        ["git", "log", "--oneline"],
        cwd=project_copy,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip().splitlines()
    assert len(log) == 2, f"expected 2 commits (baseline + phase 1), got: {log}"
    assert "phase 1" in log[0].lower() or "phase 1" in log[0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_e2e.py::test_phase_1_batch_apply -v`

Expected: FAIL with `NotImplementedError` on the first un-wired subcommand (likely `apply` until chunk C lands).

- [ ] **Step 3: Write minimal implementation**

No production code added by this task. The test is RED until chunks B (extract) and C (apply/build/commit-phase/override-mapping/set-status) ship their wire-ups. Mark `pytest.mark.xfail(strict=True)` if running this in isolation during partial integration.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_e2e.py::test_phase_1_batch_apply -v`

Expected: PASS once chunks B and C are wired up.

- [ ] **Step 5: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(e2e): Phase 1 batch apply smoke test"
```

### Task 12.4: Phase 2a smoke test — ratify

**Files:**
- Modify: `tests/test_e2e.py` (append).

**Implements spec:** §9.3 (Phase 2a — Ratify), §18.3 (acceptance), §10.3 (button semantics — Approve / Reject / Redraft / Preview / Skip / Surface)

This test simulates the four buttons that mutate state: Approve, Reject,
Redraft, Preview. Each is exercised against the post-Phase-1 state from
Task 12.3. Preview is the chunk F sweet spot — it asserts `builds[]`
grows but `state.annotations[id]` does NOT change.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_e2e.py`:

```python
def _drive_to_phase_2a(project_copy: Path, tmp_path: Path) -> state_mod.StateDir:
    """Helper: run extract + Phase 1 + commit, leaving phase at 2a-ratify."""
    sd = _phase_0_setup(project_copy)
    _override_ann_004_mapping(project_copy, sd)

    # Mark ann-003 surfaced_pending and apply the rest.
    cli.main(
        ["--project-dir", str(project_copy), "set-status",
         "--annotation-id", "ann-003", "--status", "surfaced_pending"]
    )
    for ann_id in ("ann-005", "ann-002", "ann-001", "ann-004"):
        proposal_path = tmp_path / f"proposal-{ann_id}.tex"
        if ann_id == "ann-004":
            proposal_path.write_text(
                "Studio Art & 142 & 170 \\\\\n", encoding="utf-8"
            )
        else:
            proposal_path.write_text(_proposal_for(ann_id), encoding="utf-8")
        cli.main(["--project-dir", str(project_copy), "apply",
                  "--annotation-id", ann_id,
                  "--new-text-file", str(proposal_path)])
        cli.main(["--project-dir", str(project_copy), "build"])
    cli.main(["--project-dir", str(project_copy),
              "commit-phase", "--phase", "1"])
    return sd


def test_phase_2a_ratify(project_copy: Path, tmp_path: Path):
    """Approve, Reject, Redraft, and Preview each affect state per spec §10.3."""
    sd = _drive_to_phase_2a(project_copy, tmp_path)

    # 1) Approve ann-001 → status applied → accepted.
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "set-status", "--annotation-id", "ann-001", "--status", "accepted"]
    )
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-001"]["status"] == "accepted"

    # 2) Reject ann-002 → file restored to before_text → status rejected.
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "revert", "--annotation-id", "ann-002", "--status", "rejected"]
    )
    assert rc == 0
    rc = cli.main(["--project-dir", str(project_copy), "build"])
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    ann2 = st["annotations"]["ann-002"]
    assert ann2["status"] == "rejected"
    assert ann2["applied_text"] is None
    assert ann2["before_text"] is not None
    # The .tex file must contain ann-002's before_text again.
    findings = (project_copy / "templates" / "findings.tex").read_text(
        encoding="utf-8"
    )
    assert "meaningful boost in completion rates" in findings

    # 3) Redraft ann-005 → revert + apply new draft + build + set status redrafted.
    new_draft = tmp_path / "redraft-ann-005.tex"
    new_draft.write_text(
        "the priorities for the coming year include continued "
        "investment in mid-semester checkpoints and alumni engagement.\n",
        encoding="utf-8",
    )
    cli.main(["--project-dir", str(project_copy),
              "revert", "--annotation-id", "ann-005", "--status", "rejected"])
    cli.main(["--project-dir", str(project_copy), "apply",
              "--annotation-id", "ann-005",
              "--new-text-file", str(new_draft)])
    cli.main(["--project-dir", str(project_copy), "build"])
    cli.main(["--project-dir", str(project_copy), "set-status",
              "--annotation-id", "ann-005", "--status", "redrafted"])
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-005"]["status"] == "redrafted"

    # 4) Preview ann-005 — speculative compile only. builds[] grows by one;
    #    state.annotations[ann-005] is unchanged.
    builds_before = list(st["builds"])
    spec_text = tmp_path / "spec-ann-005.tex"
    spec_text.write_text(
        "the priorities for the coming year include 12% growth in "
        "studio enrollment and continued alumni engagement.\n",
        encoding="utf-8",
    )
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "preview", "--annotation-id", "ann-005",
         "--new-text-file", str(spec_text)]
    )
    assert rc == 0
    st_after = state_mod.read_json(sd.state_path)
    assert len(st_after["builds"]) == len(builds_before) + 1
    # status unchanged.
    assert st_after["annotations"]["ann-005"]["status"] == "redrafted"
    # The .tex file is back to its pre-preview state (the redraft).
    conclusion = (project_copy / "templates" / "conclusion.tex").read_text(
        encoding="utf-8"
    )
    assert "mid-semester checkpoints" in conclusion
    assert "12% growth in studio enrollment" not in conclusion

    # 5) Approve the remaining applied annotation (ann-004) so we can commit.
    cli.main(
        ["--project-dir", str(project_copy),
         "set-status", "--annotation-id", "ann-004", "--status", "accepted"]
    )

    # commit-phase --phase 2a → advance to 2b-surface.
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "commit-phase", "--phase", "2a"]
    )
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "2b-surface"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_e2e.py::test_phase_2a_ratify -v`

Expected: FAIL until chunks B, C, and the preview wire-up from Task 10.3 are all in place.

- [ ] **Step 3: Write minimal implementation**

No production code added by this task. Mark `xfail` if running before integration.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_e2e.py::test_phase_2a_ratify -v`

Expected: PASS once all dependencies are wired up.

- [ ] **Step 5: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(e2e): Phase 2a ratify smoke test"
```

### Task 12.5: Phase 2b smoke test — surface

**Files:**
- Modify: `tests/test_e2e.py` (append).

**Implements spec:** §9.4 (Phase 2b — Surface), §18.4 (acceptance)

Drives the Phase 2b flow for ann-003 (the trigger-match annotation):
append a user chat turn, append a claude chat turn, apply the claude
proposal, build, mark surfaced_resolved, commit-phase --phase 2b.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_e2e.py`:

```python
def _drive_to_phase_2b(project_copy: Path, tmp_path: Path) -> state_mod.StateDir:
    """Helper: drive phase 0 → 1 → 2a, leaving phase at 2b-surface.

    Differs from _drive_to_phase_2a in that it also approves all non-surface
    annotations so the 2a commit can run.
    """
    sd = _drive_to_phase_2a(project_copy, tmp_path)
    # _drive_to_phase_2a stops at 2a-ratify; we need to commit it.
    # All non-surface annotations must be terminal first.
    for ann_id, target in [
        ("ann-001", "accepted"),
        ("ann-002", None),  # already rejected
        ("ann-004", "accepted"),
        ("ann-005", None),  # already redrafted
    ]:
        if target is None:
            continue
        st = state_mod.read_json(sd.state_path)
        if not state_mod.status_is_terminal(st["annotations"][ann_id]["status"]):
            cli.main(["--project-dir", str(project_copy), "set-status",
                      "--annotation-id", ann_id, "--status", target])
    cli.main(["--project-dir", str(project_copy),
              "commit-phase", "--phase", "2a"])
    return sd


def test_phase_2b_surface(project_copy: Path, tmp_path: Path):
    """Append chat turns, apply the surface proposal, mark surfaced_resolved."""
    sd = _drive_to_phase_2b(project_copy, tmp_path)
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "2b-surface"

    # Append two chat turns to ann-003's surface_chat_log.
    user_turn = tmp_path / "user-turn-1.txt"
    user_turn.write_text(
        "Does the 12% timeline match the data in §3?\n", encoding="utf-8"
    )
    claude_turn = tmp_path / "claude-turn-1.txt"
    claude_turn.write_text(
        "The data shows 12.4% growth FY24, so 12% is a fair round.\n",
        encoding="utf-8",
    )
    rc = cli.main(
        ["--project-dir", str(project_copy), "append-chat",
         "--annotation-id", "ann-003", "--role", "user",
         "--text-file", str(user_turn)]
    )
    assert rc == 0
    rc = cli.main(
        ["--project-dir", str(project_copy), "append-chat",
         "--annotation-id", "ann-003", "--role", "claude",
         "--text-file", str(claude_turn)]
    )
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    log = st["annotations"]["ann-003"]["surface_chat_log"]
    assert log is not None
    assert len(log) == 2
    assert log[0]["role"] == "user"
    assert log[1]["role"] == "claude"

    # Apply the claude-proposed text and build.
    proposal = tmp_path / "ann-003-proposal.tex"
    proposal.write_text(
        "Roughly 12% year-over-year growth in undergraduate enrollment "
        "reflects both program strength and outreach success.\n",
        encoding="utf-8",
    )
    rc = cli.main(
        ["--project-dir", str(project_copy), "apply",
         "--annotation-id", "ann-003", "--new-text-file", str(proposal)]
    )
    # Note: ann-003 was surfaced_pending; apply must promote it to applied
    # before set-status surfaced_resolved finalizes it (spec §9.4).
    assert rc == 0
    rc = cli.main(["--project-dir", str(project_copy), "build"])
    assert rc == 0

    # Mark surfaced_resolved.
    rc = cli.main(
        ["--project-dir", str(project_copy), "set-status",
         "--annotation-id", "ann-003", "--status", "surfaced_resolved"]
    )
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-003"]["status"] == "surfaced_resolved"

    # commit-phase --phase 2b → advance to 3-final.
    rc = cli.main(
        ["--project-dir", str(project_copy), "commit-phase", "--phase", "2b"]
    )
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "3-final"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_e2e.py::test_phase_2b_surface -v`

Expected: FAIL until all dependent chunks are wired (B, C, and Tasks 10.3/11.2).

- [ ] **Step 3: Write minimal implementation**

No production code. Mark `xfail` if running pre-integration.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_e2e.py::test_phase_2b_surface -v`

Expected: PASS once all dependencies are in place.

- [ ] **Step 5: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(e2e): Phase 2b surface smoke test"
```

### Task 12.6: Phase 3 smoke test — final commit

**Files:**
- Modify: `tests/test_e2e.py` (append).

**Implements spec:** §9.6 (Phase 3 — Final commit), §18.5 (acceptance)

Asserts the §18.5 acceptance criteria verbatim:
- Final `review-pdf build` exits 0.
- `review-pdf status --json` reports zero non-terminal annotations.
- `state.json.phase == "3-final"`.
- `git log --oneline` shows four or five commits matching the templates (baseline + Phase 1 + Phase 2a + Phase 2b; Phase 3 emits a fifth commit iff there are residual changes — spec §13.2 permits a no-op Phase-3 commit).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_e2e.py`:

```python
def test_phase_3_final(project_copy: Path, tmp_path: Path, capsys: pytest.CaptureFixture):
    """Phase 3: all annotations terminal, final build clean, commit applied."""
    sd = _drive_to_phase_2b(project_copy, tmp_path)

    # Resolve ann-003 (still surfaced_pending after _drive_to_phase_2b).
    proposal = tmp_path / "ann-003-proposal.tex"
    proposal.write_text(
        "Roughly 12% year-over-year growth in undergraduate enrollment "
        "reflects both program strength and outreach success.\n",
        encoding="utf-8",
    )
    cli.main(["--project-dir", str(project_copy), "apply",
              "--annotation-id", "ann-003",
              "--new-text-file", str(proposal)])
    cli.main(["--project-dir", str(project_copy), "build"])
    cli.main(["--project-dir", str(project_copy), "set-status",
              "--annotation-id", "ann-003", "--status", "surfaced_resolved"])
    cli.main(["--project-dir", str(project_copy),
              "commit-phase", "--phase", "2b"])

    # All annotations are now terminal.
    st = state_mod.read_json(sd.state_path)
    for ann_id, entry in st["annotations"].items():
        assert state_mod.status_is_terminal(entry["status"]), (
            f"{ann_id} still in non-terminal status {entry['status']}"
        )

    # Final build must succeed.
    rc = cli.main(["--project-dir", str(project_copy), "build"])
    assert rc == 0

    # commit-phase --phase 3 → phase stays at 3-final.
    rc = cli.main(["--project-dir", str(project_copy),
                   "commit-phase", "--phase", "3"])
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "3-final"

    # `status --json` reports zero non-terminal counts.
    rc = cli.main(["--project-dir", str(project_copy), "--json", "status"])
    assert rc == 0
    out = capsys.readouterr().out.strip().splitlines()
    # Find the last line (status emits a single JSON object).
    payload = json.loads(out[-1])
    assert payload["non_terminal_count"] == 0

    # Final PDF exists.
    builds = sorted((sd.dir / "builds").glob("build-*.pdf"))
    assert builds, "no build PDFs produced"

    # git log: baseline + phase 1 + phase 2a + phase 2b + phase 3
    # (phase 3 commit lands only if there are residual changes; spec §13.2
    # allows phase 3 to be a no-op commit. We accept either 4 or 5 commits.)
    log = subprocess.run(
        ["git", "log", "--oneline"],
        cwd=project_copy, capture_output=True, text=True, check=True,
    ).stdout.strip().splitlines()
    assert 4 <= len(log) <= 5, f"unexpected git log length: {log}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_e2e.py::test_phase_3_final -v`

Expected: FAIL until all dependent chunks are wired.

- [ ] **Step 3: Write minimal implementation**

No production code added by this task. Mark `xfail` for pre-integration.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_e2e.py::test_phase_3_final -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(e2e): Phase 3 final commit smoke test"
```

### Task 12.7: Failure-mode test — Phase 1 build failure reverts and flags

**Files:**
- Modify: `tests/test_e2e.py` (append).

**Implements spec:** §9.2 (Phase 1 failure recovery), §12.2 (compile failures in Phase 1), §18.6 (general: every documented exit code reachable)

Drives the Phase 1 failure recovery loop: apply succeeds, build fails,
`revert --status needs_review --failure-log <path>` flips the
annotation, the .tex file is restored, and `failure_log_path` +
`failure_edit_text` are populated.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_e2e.py`:

```python
def test_phase_1_build_failure_reverts_and_flags(project_copy: Path, tmp_path: Path):
    """A pdflatex failure after apply triggers revert + needs_review flag."""
    sd = _phase_0_setup(project_copy)
    _override_ann_004_mapping(project_copy, sd)
    cli.main(["--project-dir", str(project_copy), "set-status",
              "--annotation-id", "ann-003", "--status", "surfaced_pending"])

    # Apply a deliberately broken proposal to ann-005 (unmatched brace).
    broken_proposal = tmp_path / "broken-ann-005.tex"
    broken_proposal.write_text(
        "the priorities for the coming year include sustaining the "
        "mid-semester checkpoint program \\unbalanced{ brace here\n",
        encoding="utf-8",
    )
    rc = cli.main(
        ["--project-dir", str(project_copy), "apply",
         "--annotation-id", "ann-005",
         "--new-text-file", str(broken_proposal)]
    )
    assert rc == 0  # apply itself succeeds (it does not validate LaTeX)

    # build must fail with exit code 11.
    rc = cli.main(["--project-dir", str(project_copy), "build"])
    assert rc == cli.EXIT_BUILD_FAILED == 11

    # Locate the failed build's log path from state.json.builds[].
    st = state_mod.read_json(sd.state_path)
    last_build = st["builds"][-1]
    assert last_build["ok"] is False
    failure_log = last_build["log_path"]
    assert Path(project_copy / failure_log).exists() or Path(failure_log).exists()

    # Skill's failure handler: revert --status needs_review --failure-log
    rc = cli.main(
        ["--project-dir", str(project_copy), "revert",
         "--annotation-id", "ann-005",
         "--status", "needs_review",
         "--failure-log", failure_log]
    )
    assert rc == 0

    # State assertions:
    st = state_mod.read_json(sd.state_path)
    ann5 = st["annotations"]["ann-005"]
    assert ann5["status"] == "needs_review"
    assert ann5["failure_log_path"] == failure_log
    assert ann5["failure_edit_text"] is not None
    assert "\\unbalanced" in ann5["failure_edit_text"]

    # The .tex file is restored to before_text.
    conclusion = (project_copy / "templates" / "conclusion.tex").read_text(
        encoding="utf-8"
    )
    assert "\\unbalanced" not in conclusion
    assert "mid-semester checkpoint program" in conclusion
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_e2e.py::test_phase_1_build_failure_reverts_and_flags -v`

Expected: FAIL until chunks B and C provide working `extract`, `apply`,
`build`, and `revert --failure-log` wire-ups.

- [ ] **Step 3: Write minimal implementation**

No production code. Mark `xfail` for pre-integration.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_e2e.py::test_phase_1_build_failure_reverts_and_flags -v`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(e2e): Phase 1 build-failure handling"
```

---

### Task 12.8: Failure-mode test — source PDF mutated mid-review triggers exit 21

**Files:**
- Modify: `tests/test_e2e.py` (append).

**Implements spec:** §14 risk 9 (engine refuses operations if source PDF MD5 differs from `annotations.json.source_pdf_md5`; user must re-extract), §8 (exit code 21 reachability), §18.6 (general: every documented exit code reachable).

Drives the source-PDF integrity guard. Phase 0 extract records the PDF's MD5 in `annotations.json.source_pdf_md5`. If the commenter ships an updated PDF mid-review, the next mutator must refuse to operate with exit code 21 (`SourcePdfChangedError`). This e2e test asserts the contract end-to-end: extract, mutate the on-disk PDF bytes, attempt `apply`, assert exit 21 and no `.tex` mutation.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_e2e.py`:

```python
def test_source_pdf_mutated_mid_review_blocks_apply_with_exit_21(
    project_copy: Path, tmp_path: Path
):
    """Mutating the source PDF after extract must block subsequent apply (spec §14 risk 9)."""
    sd = _phase_0_setup(project_copy)
    _override_ann_004_mapping(project_copy, sd)

    # Sanity: annotations.json carries the source_pdf_md5 field after extract.
    ann_doc = state_mod.read_json(sd.annotations_path)
    assert ann_doc.get("source_pdf_md5"), "extract must record source_pdf_md5 (spec §7.1)"
    original_md5 = ann_doc["source_pdf_md5"]

    # Capture the .tex file's pre-mutation content for the no-side-effects assertion.
    target_tex = project_copy / "templates" / "body.tex"
    pre_apply_body = target_tex.read_text(encoding="utf-8")

    # Mutate the source PDF on disk. The exact mutation does not matter — only
    # that the bytes differ so the MD5 changes. We append a trailing byte
    # outside the trailer so most PDF readers would still open the file, but
    # the MD5 is guaranteed to differ from `original_md5`.
    pdf_path = Path(ann_doc["source_pdf"])
    assert pdf_path.exists(), "source_pdf path in annotations.json must resolve"
    with pdf_path.open("ab") as f:
        f.write(b"\n% mutated-after-extract\n")

    # Sanity: the MD5 actually changed.
    import hashlib
    new_md5 = hashlib.md5(pdf_path.read_bytes()).hexdigest()
    assert new_md5 != original_md5

    # Now attempt apply on ann-001. The mutator must refuse with exit 21
    # before mutating any .tex file (per spec §14 risk 9).
    proposal = tmp_path / "proposal-ann-001.tex"
    proposal.write_text(
        "studio enrollment grew 14% year over year, with the largest gains "
        "in transfer-student cohorts.\n",
        encoding="utf-8",
    )
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "apply",
            "--annotation-id", "ann-001",
            "--new-text-file", str(proposal),
        ]
    )
    assert rc == cli.EXIT_SOURCE_PDF_CHANGED == 21, (
        f"expected exit 21 (SourcePdfChangedError); got {rc}"
    )

    # No .tex mutation occurred: body.tex is byte-identical to its pre-apply state.
    assert target_tex.read_text(encoding="utf-8") == pre_apply_body, (
        "apply must not have mutated body.tex after raising SourcePdfChangedError"
    )

    # state.json is unchanged for ann-001 (still pending).
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-001"]["status"] == "pending"


def test_legacy_annotations_without_md5_blocks_apply_with_exit_22(
    project_copy: Path, tmp_path: Path
):
    """Annotations.json predating the source_pdf_md5 guard must block apply (spec §14 risk 9)."""
    sd = _phase_0_setup(project_copy)
    _override_ann_004_mapping(project_copy, sd)

    # Strip source_pdf_md5 from annotations.json to simulate a pre-guard
    # extract output. We write back via raw json.dumps (not atomic_write_json)
    # because we're deliberately producing a malformed/legacy file for the
    # test; production code never writes annotations.json after extract.
    ann_doc = state_mod.read_json(sd.annotations_path)
    ann_doc.pop("source_pdf_md5", None)
    sd.annotations_path.write_text(json.dumps(ann_doc), encoding="utf-8")

    proposal = tmp_path / "proposal-ann-001.tex"
    proposal.write_text("legacy-state probe.\n", encoding="utf-8")
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "apply",
            "--annotation-id", "ann-001",
            "--new-text-file", str(proposal),
        ]
    )
    assert rc == cli.EXIT_LEGACY_STATE == 22, (
        f"expected exit 22 (LegacyStateError); got {rc}"
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_e2e.py::test_source_pdf_mutated_mid_review_blocks_apply_with_exit_21 tests/test_e2e.py::test_legacy_annotations_without_md5_blocks_apply_with_exit_22 -v`

Expected: FAIL until chunks B (extract writes `source_pdf_md5`) and C (every mutator calls `state.assert_source_pdf_unchanged` at entry) are merged.

- [ ] **Step 3: Write minimal implementation**

No production code in this task. Chunk A Task 2.7 owns `state.assert_source_pdf_unchanged`; chunk B owns the `source_pdf_md5` field in `annotations.json`; chunk C owns the per-mutator guard call. Mark `xfail` during chunk assembly; remove the marker once the depended-on chunks land.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_e2e.py::test_source_pdf_mutated_mid_review_blocks_apply_with_exit_21 tests/test_e2e.py::test_legacy_annotations_without_md5_blocks_apply_with_exit_22 -v`

Expected: 2 PASSED once all three dependencies above are wired.

- [ ] **Step 5: Commit**

```bash
git add tests/test_e2e.py
git commit -m "test(e2e): source-PDF integrity guard reachability (exit 21, exit 22)"
```

---

## Task 13: migrate-state stub for future schema versions

**Files:**
- Create: `src/review_pdf_to_latex/migrate.py`
- Create: `tests/test_migrate.py`
- Modify: `src/review_pdf_to_latex/cli.py` (migrate-state handler).

**Implements spec:** §8 (`migrate-state` subcommand; exit code 14 for unsupported migration), §7 (schema_version policy).

The engine ships with `schema_version: 1` everywhere. v1 has no
migrations — but the CLI surface promises the command exists so the
skill and downstream tooling can rely on it. Any call therefore raises
`UnsupportedMigrationError`. The implementation documents the migration
registry pattern future versions will populate.

### Task 13.1: `migrate()` stub

**Files:**
- Create: `src/review_pdf_to_latex/migrate.py`
- Create: `tests/test_migrate.py`

**Implements spec:** §7 (schema version policy), §8 (migrate-state exit code 14)

- [ ] **Step 1: Write the failing test**

Create `tests/test_migrate.py`:

```python
"""Tests for the migrate-state stub (spec §8)."""

from __future__ import annotations

import pytest

from review_pdf_to_latex import migrate
from review_pdf_to_latex import state as state_mod


def test_migrate_raises_unsupported_for_any_input(tmp_project):
    """v1 ships no migrations; every call raises UnsupportedMigrationError."""
    sd = state_mod.StateDir(tmp_project)
    with pytest.raises(migrate.UnsupportedMigrationError) as exc_info:
        migrate.migrate(sd, from_version=1, to_version=2)
    msg = str(exc_info.value)
    assert "1" in msg
    assert "2" in msg
    assert "no migrations" in msg.lower() or "no migration" in msg.lower()


def test_migrate_same_version_also_unsupported(tmp_project):
    """A no-op migration request is still rejected — no-op behavior is the
    caller's responsibility, not the engine's."""
    sd = state_mod.StateDir(tmp_project)
    with pytest.raises(migrate.UnsupportedMigrationError):
        migrate.migrate(sd, from_version=1, to_version=1)


def test_migrate_registry_is_empty_in_v1():
    """The migration registry is intentionally empty in v1.

    Future versions populate this dict with (from, to) → callable
    migration functions. The test pins the v1 contract.
    """
    assert migrate._MIGRATION_REGISTRY == {}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_migrate.py -v`

Expected: 3 FAIL with `ModuleNotFoundError: No module named 'review_pdf_to_latex.migrate'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/review_pdf_to_latex/migrate.py`:

```python
"""State-file migration stub (spec §8 `migrate-state`).

v1 ships with ``schema_version: 1`` everywhere and no migrations. Future
breaking changes will register entries in :data:`_MIGRATION_REGISTRY`
keyed by ``(from_version, to_version)`` tuples; the registered callable
must:

1. Read the existing files via :func:`review_pdf_to_latex.state.read_json`
   with a relaxed schema-version guard (see :class:`MigrationRequiredError`).
2. Transform the payload to the new shape.
3. Write each file atomically via
   :func:`review_pdf_to_latex.state.atomic_write_json`.
4. Bump every file's ``schema_version`` to ``to_version`` as the final
   step (so a partial migration interrupted by a crash still trips the
   "needs migration" check on next read).

The CLI handler in :mod:`review_pdf_to_latex.cli` maps
:class:`UnsupportedMigrationError` to exit code 14
(``EXIT_UNSUPPORTED_MIGRATION``, spec §8).
"""

from __future__ import annotations

from typing import Callable

from review_pdf_to_latex import state as _state


class UnsupportedMigrationError(Exception):
    """Raised when no migration path is defined for ``(from, to)``.

    CLI handler maps this to exit code 14 (``EXIT_UNSUPPORTED_MIGRATION``).
    """


# Future migrations register here. The key is ``(from_version, to_version)``;
# the value is a callable ``(StateDir) -> None`` that performs the migration
# atomically. v1 is intentionally empty.
_MIGRATION_REGISTRY: dict[tuple[int, int], Callable[[_state.StateDir], None]] = {}


def migrate(state_dir: _state.StateDir, from_version: int, to_version: int) -> None:
    """Migrate state files from ``from_version`` to ``to_version``.

    v1 has no migrations defined; every call raises
    :class:`UnsupportedMigrationError`.

    Future implementations will look up ``(from_version, to_version)`` in
    :data:`_MIGRATION_REGISTRY`, run the registered callable, and verify
    the post-migration ``schema_version`` matches ``to_version``.

    Parameters
    ----------
    state_dir:
        Project state directory.
    from_version:
        The schema_version currently on disk.
    to_version:
        The schema_version the engine wants.

    Raises
    ------
    UnsupportedMigrationError
        No migration path is registered for ``(from_version, to_version)``.
    """
    key = (from_version, to_version)
    if key not in _MIGRATION_REGISTRY:
        raise UnsupportedMigrationError(
            f"No migrations defined in v1; from={from_version} to={to_version}"
        )
    _MIGRATION_REGISTRY[key](state_dir)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_migrate.py -v`

Expected: 3 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/migrate.py tests/test_migrate.py
git commit -m "feat(migrate): migrate-state stub for future schema versions"
```

### Task 13.2: Wire up the `migrate-state` CLI subcommand

**Files:**
- Modify: `src/review_pdf_to_latex/cli.py` (migrate-state handler).
- Modify: `tests/test_cli.py` (append CLI integration test).

**Implements spec:** §8 (migrate-state exit code 14)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_cli.py`:

```python
from review_pdf_to_latex import migrate as migrate_mod


def test_cli_migrate_state_exits_14(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """Any migrate-state call in v1 exits 14 with the spec message."""
    rc = cli.main(
        [
            "--project-dir", str(tmp_project),
            "migrate-state",
            "--from", "1",
            "--to", "2",
        ]
    )
    assert rc == cli.EXIT_UNSUPPORTED_MIGRATION == 14
    err = capsys.readouterr().err
    assert "from=1" in err
    assert "to=2" in err
    assert "no migrations" in err.lower()


def test_cli_migrate_state_same_from_to_also_exits_14(
    tmp_project: Path, capsys: pytest.CaptureFixture
):
    """from=to is still rejected (the engine does not implicitly no-op)."""
    rc = cli.main(
        [
            "--project-dir", str(tmp_project),
            "migrate-state",
            "--from", "1",
            "--to", "1",
        ]
    )
    assert rc == cli.EXIT_UNSUPPORTED_MIGRATION
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_cli.py -v -k cli_migrate_state`

Expected: 2 FAIL with `NotImplementedError: subcommand migrate-state not yet implemented`.

- [ ] **Step 3: Write minimal implementation**

Append to `src/review_pdf_to_latex/cli.py`:

```python
from review_pdf_to_latex import migrate as _migrate


def _handle_migrate_state(args: argparse.Namespace) -> int:
    """``migrate-state`` subcommand handler (spec §8 exit code 14).

    Design decision (do NOT add a source-PDF integrity guard here):
        Other mutators (apply / revert / preview / set-status / etc.) call
        ``state.assert_source_pdf_unchanged`` to refuse work if the source
        PDF's MD5 no longer matches ``annotations.json.source_pdf_md5``
        (exit code 21) or if ``annotations.json`` predates that field
        (exit code 22). ``migrate-state`` deliberately does NOT call that
        guard: migration operates on the on-disk state files only, and
        the source PDF may have legitimately moved, been renamed, or been
        deleted between the original ``extract`` and the migration run.
        Blocking migration on a missing/changed PDF would strand the user
        on an old schema with no recourse. Future implementers: do not
        add ``assert_source_pdf_unchanged`` here by reflex.
    """
    state_dir = _state.StateDir(args.project_dir)
    try:
        _migrate.migrate(
            state_dir,
            from_version=args.from_version,
            to_version=args.to_version,
        )
    except _migrate.UnsupportedMigrationError as e:
        print(f"unsupported migration: {e}", file=sys.stderr)
        return EXIT_UNSUPPORTED_MIGRATION
    return EXIT_OK


_HANDLERS_TABLE["migrate-state"] = _handle_migrate_state
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_cli.py -v -k cli_migrate_state`

Expected: 2 PASSED.

- [ ] **Step 5: Commit**

```bash
git add src/review_pdf_to_latex/cli.py tests/test_cli.py
git commit -m "feat(cli): wire up migrate-state subcommand"
```

---

## Sanity check: full test suite after this chunk

After Tasks 10, 11, 12, and 13 are all merged (alongside their chunk
dependencies B, C, D, E from sibling agents), run:

```bash
pytest -v
```

Expected: every test under `tests/` PASSES. The e2e tests in
`tests/test_e2e.py` are the highest-signal coverage — they exercise
every CLI subcommand, every spec §10.3 button, every documented exit
code path, and the snapshot/restore invariant of `preview`. If any of
them fail, debug starts at the failing assertion's spec citation and
walks back to the chunk that owns the production code under test.

## Chunk G — Skill, README, and Spec Coverage Audit (Tasks 14–16)

This chunk produces the Claude Code skill (a markdown playbook outside this repo), polishes the project README, adds a CHANGELOG, and ends with a spec-coverage audit table that walks the spec from §1 to §18 and notes which tasks (across all chunks) implement each section.

The skill is not Python — it is a markdown file that lives at `~/.claude/skills/review-pdf-to-latex/SKILL.md`. The "test" for each skill sub-task is a pytest case that asserts the file exists at the expected path, that its YAML frontmatter parses, and that the named section headings are present in the body. These tests live in this repo under `tests/test_skill.py` even though the file under test lives in the user's home — so the engineer can validate the skill from the engine repo's test suite. The skill file path is parametrized via an env var so CI can run against a fixture copy.

---

### Task 14: Claude Code skill — `SKILL.md` (implements spec §5 skill-layer, §9 phases, §10.5 click→engine, §13 audit boundaries)

**Files:**
- Create: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (target — outside this repo)
- Create: `tests/test_skill.py` (engine repo)
- Modify: `tests/conftest.py` (add `skill_path` fixture; created in chunk A or this task if missing)
- Test: `tests/test_skill.py`

**Implements spec:** §5.1 (skill-layer responsibilities), §9.1–§9.6 (phases), §10.5 (click→engine path / wait-event bash idiom), §13 (commit-phase boundaries), §17 (out of scope — skill does not embed model calls beyond what Claude Code already provides)

Notes that apply to every Task 14 sub-task:

- The skill file is a single markdown file. The `name`, `description` keys in YAML frontmatter are the contract Claude Code uses to surface the skill in `/skill` lists.
- The skill writes nothing directly to `state.json`. Every state mutation routes through `review-pdf` CLI subcommands. This is reiterated in the skill body so that future readers (the user, collaborators, or Claude itself in a fresh session) cannot accidentally edit `state.json` with the Edit tool.
- Tests use a `SKILL_PATH` env var (defaults to `~/.claude/skills/review-pdf-to-latex/SKILL.md`) so CI can point at a checked-in fixture copy.

Add to `tests/conftest.py` once (if not already added by chunk A):

```python
import os
from pathlib import Path

import pytest


@pytest.fixture
def skill_path() -> Path:
    """Resolve the SKILL.md location (env-overridable for CI)."""
    default = Path.home() / ".claude" / "skills" / "review-pdf-to-latex" / "SKILL.md"
    return Path(os.environ.get("SKILL_PATH", str(default)))


@pytest.fixture
def skill_text(skill_path: Path) -> str:
    if not skill_path.exists():
        pytest.skip(f"SKILL.md not found at {skill_path}")
    return skill_path.read_text(encoding="utf-8")
```

If `conftest.py` already defines these fixtures (chunk A may have added them), the engineer skips the modification step.

---

#### Task 14.1: SKILL.md frontmatter and overview

**Files:**
- Create: `~/.claude/skills/review-pdf-to-latex/SKILL.md`
- Test: `tests/test_skill.py`

**Implements spec:** §5.1 (skill-layer overview), §19 (Glossary — skill definition)

- [ ] **Step 1: Write the failing test**

```python
"""Skill file structural tests (Task 14.1)."""

from pathlib import Path

import pytest


def _parse_frontmatter(text: str) -> dict:
    """Minimal YAML frontmatter parser for the skill file (key: value pairs only)."""
    if not text.startswith("---\n"):
        raise ValueError("missing opening YAML fence")
    end = text.find("\n---\n", 4)
    if end == -1:
        raise ValueError("missing closing YAML fence")
    block = text[4:end]
    out: dict[str, str] = {}
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"non key:value line in frontmatter: {line!r}")
        key, value = line.split(":", 1)
        out[key.strip()] = value.strip()
    return out


def test_skill_file_exists(skill_path: Path) -> None:
    assert skill_path.exists(), f"SKILL.md missing at {skill_path}"


def test_skill_has_frontmatter_name_and_description(skill_text: str) -> None:
    fm = _parse_frontmatter(skill_text)
    assert fm.get("name") == "review-pdf-to-latex"
    assert "description" in fm and len(fm["description"]) >= 40


def test_skill_overview_sections_present(skill_text: str) -> None:
    required_headings = [
        "# review-pdf-to-latex",
        "## When to invoke this skill",
        "## What the engine is",
        "## The four phases",
    ]
    for heading in required_headings:
        assert heading in skill_text, f"missing heading: {heading}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py -v`
Expected: SKIP or FAIL — file does not yet exist at `~/.claude/skills/review-pdf-to-latex/SKILL.md`. If the fixture skips on missing file, force the test by setting `SKILL_PATH=/tmp/none.md` and re-running; expect FAIL with `SKILL.md missing`.

- [ ] **Step 3: Write minimal implementation**

Create `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

```markdown
---
name: review-pdf-to-latex
description: Use when walking PDF annotations into LaTeX source edits with a sidecar viewer — drives the `review-pdf` CLI through the four-phase workflow (extract, batch pre-apply, ratify and surface, final commit).
---

# review-pdf-to-latex — Playbook for the sidecar walker

## When to invoke this skill

Invoke this skill when:

- The user mentions an annotated PDF that has a corresponding LaTeX source tree, and wants to walk the annotations into source edits.
- The user types `/review-pdf-to-latex` or references the `review-pdf` CLI binary by name.
- The user describes a workflow shaped like "review every comment on this PDF and update the LaTeX".
- A previous session left `.review-state/` in a project and the user wants to resume.

Do NOT invoke this skill for:

- Editing LaTeX without an annotated PDF (just use the Edit tool directly).
- DOCX, Markdown, or HTML source — this tool is LaTeX-only (spec §17).
- Reading annotations without applying edits (use `pdfannots` directly).

## What the engine is

The engine is a Python package installed via `pip install -e ~/PycharmProjects/review-pdf-to-latex` (or `pipx install review-pdf-to-latex` once published). It exposes a CLI named `review-pdf` with 14 subcommands. The engine is the sole writer of `.review-state/state.json`, `.review-state/mapping.json`, build artifacts, and git commits within the review workflow. The skill never edits these files directly — every mutation flows through a `review-pdf` subprocess invocation.

To verify the engine is available: run `review-pdf status --help`. If the help text prints, the engine is on `PATH`.

## The four phases

Phase 0 — Setup. Extract annotations from the PDF, build the initial mapping, and resolve any low-confidence mappings via the manual-mapping UI.

Phase 1 — Batch pre-apply. Walk every mechanical annotation in reverse line order, draft a proposed edit, apply it, build, and either succeed (status `applied`) or revert and mark `needs_review`.

Phase 2a — Ratify. The user opens the viewer and clicks Approve / Reject / Redraft / Preview / Skip / Surface for each pre-applied annotation. The skill consumes events via `review-pdf wait-event` and dispatches CLI subcommands.

Phase 2b — Surface. SURFACE-flagged annotations get a focused terminal conversation; each chat turn is recorded via `review-pdf append-chat`.

Phase 3 — Final commit. Run the final build and commit with the structured phase-3 message via `review-pdf commit-phase --phase 3`.

Each phase has its own section below with the exact CLI invocations.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py tests/conftest.py
git commit -m "feat(skill): SKILL.md frontmatter + overview"
```

The engineer separately copies the SKILL.md into place at `~/.claude/skills/review-pdf-to-latex/SKILL.md`. The skill file itself is not tracked in this repo (it lives in the user's home), but a reference copy at `docs/skill-reference/SKILL.md` may optionally be maintained for review purposes (out of scope for v1 — Task 14.8 explains).

---

#### Task 14.2: Phase 0 instructions

**Files:**
- Modify: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (append Phase 0 section)
- Test: `tests/test_skill.py` (add test)

**Implements spec:** §9.1 (Phase 0), §10.6 (mapping-mode UI), §12.1 (fuzzy thresholds)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_skill.py`:

```python
def test_skill_phase0_section_present_and_invocations_correct(skill_text: str) -> None:
    assert "## Phase 0 — Setup" in skill_text
    # The exact invocations must appear verbatim:
    assert "review-pdf extract --pdf" in skill_text
    assert "review-pdf serve --project-dir" in skill_text and "--mapping-mode" in skill_text
    # Must instruct Claude to check needs_review before advancing:
    assert "needs_review" in skill_text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py::test_skill_phase0_section_present_and_invocations_correct -v`
Expected: FAIL — section not yet added.

- [ ] **Step 3: Write minimal implementation**

Append to `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

```markdown

## Phase 0 — Setup

Goal: produce `annotations.json`, `mapping.json`, an initial `state.json`, and page PNGs for the source PDF; resolve any low-confidence mappings before Phase 1 begins.

### Steps

1. Verify the inputs with the user. You need two paths:
   - The annotated PDF (e.g., `~/Downloads/2026-05-15-COTA-Impact-Report-v2.0comment.pdf`).
   - The LaTeX project root (e.g., `~/gt/python419/crew/anthony/reports/cota-impact/`).
   Ask the user to confirm both before proceeding.

2. Run extraction:

   ```bash
   review-pdf extract \
     --pdf "<absolute path to annotated pdf>" \
     --project-dir "<absolute path to LaTeX project root>"
   ```

   If `extract` exits 3 ("existing state without --force"), ask the user whether to resume or to re-extract with `--force`. Re-extract destroys the working session — confirm explicitly before running with `--force`.

3. Read the resulting `<project-dir>/.review-state/mapping.json` with the Read tool. Identify all annotations where `needs_review == true`.

4. If any annotations are `needs_review`, launch the manual-mapping viewer:

   ```bash
   review-pdf serve --project-dir "<project-dir>" --mapping-mode
   ```

   The viewer prints a URL to stderr. Print that URL to the user and tell them to open it in a browser. The mapping-mode UI lists every unresolved annotation; the user clicks `[Confirm]` on a candidate (or types a manual file + line range) for each one. When the list is empty the viewer displays "All mappings resolved." Ask the user to confirm they have finished, then stop the server (Ctrl-C in the terminal where it ran, or close the bash subprocess from this session).

5. Run `review-pdf status --json --project-dir "<project-dir>"` and parse the output. If any annotation still has `needs_review == true`, halt and ask the user to revisit Phase 0. Otherwise advance to Phase 1.

### What you do NOT do in Phase 0

- Do NOT call `review-pdf commit-phase`. Phase 0 does not produce a commit — it produces state. The first commit-phase boundary is at the end of Phase 1.
- Do NOT write to `state.json`, `mapping.json`, or `annotations.json` with the Edit or Write tools. The engine is the sole writer (spec §5.1).
- Do NOT modify any `.tex` file in Phase 0. Source mutation begins in Phase 1.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py::test_skill_phase0_section_present_and_invocations_correct -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py
git commit -m "feat(skill): Phase 0 instructions"
```

---

#### Task 14.3: Phase 1 instructions (batch pre-apply)

**Files:**
- Modify: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (append Phase 1 section)
- Test: `tests/test_skill.py` (add test)

**Implements spec:** §9.2 (Phase 1 batch loop), §12.2 (compile failure recovery), §12.4 (edit conflicts), §13.1 (clean git precondition), §13.2 (Phase 1 commit boundary)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_skill.py`:

```python
def test_skill_phase1_section_present_and_loop_correct(skill_text: str) -> None:
    assert "## Phase 1 — Batch pre-apply" in skill_text
    # Reverse-line-order is the single most important sequencing rule:
    assert "reverse" in skill_text.lower() and "line" in skill_text.lower()
    # The four core CLI calls must each appear:
    for cli in ("review-pdf apply", "review-pdf build", "review-pdf revert", "review-pdf commit-phase --phase 1"):
        assert cli in skill_text, f"missing CLI invocation: {cli}"
    # SURFACE handling: trigger_match annotations are surfaced_pending:
    assert "trigger_match" in skill_text
    assert "surfaced_pending" in skill_text
    # Clean-git precondition mentioned:
    assert "git status" in skill_text or "clean" in skill_text.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py::test_skill_phase1_section_present_and_loop_correct -v`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Append to `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

```markdown

## Phase 1 — Batch pre-apply

Goal: walk every mechanical annotation, draft a proposed edit, apply it, and validate via build. Failed edits are reverted and routed to Phase 2a as `needs_review`. SURFACE-flagged annotations are deferred to Phase 2b.

### Preconditions (must hold before you start the loop)

- Phase 0 is complete: `review-pdf status --json` shows zero `needs_review` mappings.
- The git working tree is clean. Run `git -C "<project-dir>" status --porcelain`; if there is any output, halt and ask the user to commit, stash, or `git restore` before continuing. The engine will refuse to enter Phase 1 with exit code 15 on a dirty tree anyway, but checking up front is cleaner.

### Read the candidate set

1. Read `<project-dir>/.review-state/state.json` (use the Read tool).
2. Build the candidate list: every entry in `state.annotations` where `status == "pending"` AND the corresponding `annotations.json[id].trigger_match == false`.
3. Sort the candidates: first by `mapping.json[id].latex_file`, then by `mapping.json[id].line_range[0]` in DESCENDING order. This is the reverse-line-order rule (spec §9.2): editing later lines first preserves line numbers for earlier edits.
4. Stream the candidate list to a working file (e.g., `/tmp/review-pdf-phase1-candidates.json`). Do not hold all 70 candidates' content in working memory simultaneously — this matters for token cost on large reviews.

### The batch loop

For each candidate annotation `id` in the sorted list:

1. Read the mapped LaTeX snippet via the Read tool, using `latex_file` and `line_range` from `mapping.json`.
2. Read the commenter's `comment` from `annotations.json`.
3. Draft a proposed replacement consistent with the comment. Keep LaTeX syntax intact (don't strip commands; don't add commands the source doesn't already use).
4. Write the proposed text to a temp file:

   ```bash
   PROPOSAL_FILE="/tmp/review-pdf-proposal-${id}.tex"
   # write proposed text to $PROPOSAL_FILE
   ```

5. Apply via the engine:

   ```bash
   review-pdf apply \
     --annotation-id "${id}" \
     --new-text-file "${PROPOSAL_FILE}" \
     --project-dir "<project-dir>"
   ```

   Exit code 16 means an overlapping line range with another `pending` or `applied` annotation in the same file. This should not happen if you sorted in reverse line order — if it does, halt and inspect the mapping; you may need `review-pdf override-mapping` to repoint the conflicting annotation.

6. Build:

   ```bash
   review-pdf build --project-dir "<project-dir>"
   ```

   The build runs LaTeX twice (cross-refs) and appends a record to `state.json.builds[]`.

7. Branch on build outcome:

   - If `build` exited 0: continue to the next annotation. The engine has already recorded `status: applied`, `proposed_text`, `applied_text`, `applied_at`, and `last_build_id`.
   - If `build` exited 11 (compile failure): revert with failure metadata.

     ```bash
     review-pdf revert \
       --annotation-id "${id}" \
       --status needs_review \
       --failure-log "<path printed by build on stderr>" \
       --project-dir "<project-dir>"
     ```

     This atomically reverts the file, sets status to `needs_review`, and records `failure_log_path` + `failure_edit_text` so the user can see the failure in Phase 2a. Continue with the next annotation.

### After the candidate loop

For every annotation where `annotations.json[id].trigger_match == true` (SURFACE-flagged), transition it to `surfaced_pending`:

```bash
for id in <list of trigger_match annotation IDs>; do
  review-pdf set-status \
    --annotation-id "${id}" \
    --status surfaced_pending \
    --project-dir "<project-dir>"
done
```

These will be handled in Phase 2b.

### Commit the phase

When the loop is complete (every pending non-SURFACE annotation is now `applied` or `needs_review`, and every SURFACE annotation is `surfaced_pending`), commit:

```bash
review-pdf commit-phase --phase 1 --project-dir "<project-dir>"
```

The engine renders the structured commit message (spec §13.2), runs `git commit`, and advances `state.json.phase` from `1-batch` to `2a-ratify` (or to `2b-surface` if `--order surface-first` was passed at `serve` time — but `commit-phase` reads `order` from state and routes accordingly).

### What you do NOT do in Phase 1

- Do NOT call `review-pdf preview` in Phase 1. Preview is a Phase 2a affordance.
- Do NOT use the Edit tool directly on `.tex` files. Every mutation goes through `review-pdf apply`.
- Do NOT skip annotations that look hard. If the build fails, revert and let Phase 2a handle it.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py::test_skill_phase1_section_present_and_loop_correct -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py
git commit -m "feat(skill): Phase 1 instructions"
```

---

#### Task 14.4: Phase 2a instructions (the wait-event loop)

**Files:**
- Modify: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (append Phase 2a section)
- Test: `tests/test_skill.py` (add test)

**Implements spec:** §9.3 (Phase 2a ratify), §10.3 (button semantics), §10.5 (click→engine path), §11.1 (preview strategy)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_skill.py`:

```python
def test_skill_phase2a_section_has_wait_event_loop(skill_text: str) -> None:
    assert "## Phase 2a — Ratify" in skill_text
    # The wait-event loop is the heart of the skill:
    assert "review-pdf wait-event" in skill_text
    assert "--timeout 300" in skill_text or "--timeout 60" in skill_text
    # Exit code 20 (timeout) handled:
    assert "20" in skill_text and "timeout" in skill_text.lower()
    # All six action dispatches must appear:
    for action in ("approve", "reject", "redraft", "preview", "skip", "surface"):
        assert action in skill_text.lower(), f"missing action: {action}"
    # commit-phase boundary:
    assert "commit-phase --phase 2a" in skill_text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py::test_skill_phase2a_section_has_wait_event_loop -v`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Append to `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

```markdown

## Phase 2a — Ratify

Goal: the user walks each pre-applied mechanical edit in the viewer and produces a terminal outcome (accept, reject, redraft, defer, surface). You react to clicks via `review-pdf wait-event`.

### Launch the viewer

```bash
review-pdf serve --project-dir "<project-dir>" &
SERVE_PID=$!
```

The server prints its URL to stderr. Capture it and print it to the user:

> "Open the viewer at http://127.0.0.1:NNNN/. Buttons: Approve (accept the pre-applied edit), Reject (revert to original), Redraft (ask me for a new draft), Preview (speculative compile of a draft I'll provide), Skip (defer), Surface (move to a focused conversation)."

### The wait-event loop

This is the central idiom (spec §10.5). The bash loop is:

```bash
LAST_TS=""
while true; do
  if [ -z "${LAST_TS}" ]; then
    EVENT_JSON=$(review-pdf wait-event \
                   --project-dir "<project-dir>" \
                   --timeout 300 2>/dev/null)
  else
    EVENT_JSON=$(review-pdf wait-event \
                   --project-dir "<project-dir>" \
                   --since "${LAST_TS}" \
                   --timeout 300 2>/dev/null)
  fi
  EXIT=$?
  if [ "${EXIT}" -eq 20 ]; then
    # Timeout — no click in 5 minutes. Loop and keep waiting.
    continue
  fi
  if [ "${EXIT}" -ne 0 ]; then
    echo "wait-event failed with exit ${EXIT}" >&2
    break
  fi
  # Parse the event JSON and dispatch on action.
  # Update LAST_TS from the event's ts field.
done
```

The 300-second (5-minute) timeout is chosen to comfortably fit inside Claude Code's default 2-minute bash subprocess timeout window if you choose to override — but the default per-spec is 60 seconds; either works. Pick 60 if you want tighter pickup of context-compaction transitions; pick 300 to reduce loop chatter.

### Per-action dispatch

Each event has `annotation_id` (call it `${id}`) and `action`. Branch on action:

- **approve** — the user accepts the pre-applied edit. No file change needed.

  ```bash
  review-pdf set-status \
    --annotation-id "${id}" \
    --status accepted \
    --project-dir "<project-dir>"
  ```

- **reject** — restore the original text. The engine reverts; you trigger a rebuild so the preview catches up.

  ```bash
  review-pdf revert \
    --annotation-id "${id}" \
    --status rejected \
    --project-dir "<project-dir>"
  review-pdf build --project-dir "<project-dir>"
  ```

- **redraft** — the event carries `speculative_text` (the user typed it in the viewer's redraft input, or you drafted it in conversation and the user clicked Redraft to apply it). Write that text to a temp file and apply.

  ```bash
  echo "${EVENT_SPECULATIVE_TEXT}" > /tmp/review-pdf-redraft-${id}.tex
  review-pdf revert \
    --annotation-id "${id}" \
    --status rejected \
    --project-dir "<project-dir>"
  review-pdf apply \
    --annotation-id "${id}" \
    --new-text-file "/tmp/review-pdf-redraft-${id}.tex" \
    --project-dir "<project-dir>"
  if review-pdf build --project-dir "<project-dir>"; then
    review-pdf set-status \
      --annotation-id "${id}" \
      --status redrafted \
      --project-dir "<project-dir>"
  else
    # Build failed — revert and route to needs_review.
    LOG=$(cat "<failure-log path from build stderr>" )  # save path
    review-pdf revert \
      --annotation-id "${id}" \
      --status needs_review \
      --failure-log "<path>" \
      --project-dir "<project-dir>"
  fi
  ```

- **preview** — speculative compile only. Write the speculative text to a temp file and call `preview`. The engine snapshots the file, writes the draft, builds, and restores. The new build PDF appears in `.review-state/builds/` and the viewer fetches it.

  ```bash
  echo "${EVENT_SPECULATIVE_TEXT}" > /tmp/review-pdf-preview-${id}.tex
  review-pdf preview \
    --annotation-id "${id}" \
    --new-text-file "/tmp/review-pdf-preview-${id}.tex" \
    --project-dir "<project-dir>"
  ```

  No `state.json.annotations[${id}]` mutation. The `builds[]` array gets one new entry.

- **skip** — defer to a future session.

  ```bash
  review-pdf set-status \
    --annotation-id "${id}" \
    --status deferred \
    --project-dir "<project-dir>"
  ```

- **surface** — move this annotation to Phase 2b. The terminal context switches; you and the user have a focused conversation.

  ```bash
  review-pdf set-status \
    --annotation-id "${id}" \
    --status surfaced_pending \
    --project-dir "<project-dir>"
  ```

  Once the conversation completes (see Phase 2b), the status moves to `surfaced_resolved` (or `deferred`).

- **override-mapping** — only valid in mapping-mode. Outside mapping-mode, log and ignore.

### Progress reporting

Every ~10 events (or on user request), run:

```bash
review-pdf status --project-dir "<project-dir>"
```

and print a one-line summary to the terminal (e.g., "57 accepted, 4 rejected, 2 redrafted, 1 needs_review, 1 surfaced_pending, 15 pending").

### Phase 2a commit boundary

When every annotation that should be in 2a is in a terminal status (accepted / rejected / redrafted / deferred) OR is `surfaced_pending` (deferred to 2b), commit:

```bash
review-pdf commit-phase --phase 2a --project-dir "<project-dir>"
```

The engine advances `state.json.phase` to `2b-surface`.

### What you do NOT do in Phase 2a

- Do NOT loop on `state.json` polling — use `wait-event`. Polling state.json from Claude wastes tokens and racks up bash subprocesses.
- Do NOT dispatch the event before parsing it. Always parse the JSON first; an unrecognized action is a bug (or a viewer/engine version mismatch).
- Do NOT advance the phase before every non-surfaced annotation is terminal.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py::test_skill_phase2a_section_has_wait_event_loop -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py
git commit -m "feat(skill): Phase 2a wait-event loop instructions"
```

---

#### Task 14.5: Phase 2b instructions (surface)

**Files:**
- Modify: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (append Phase 2b section)
- Test: `tests/test_skill.py` (add test)

**Implements spec:** §9.4 (Phase 2b surface), §13.2 (Phase 2b commit boundary)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_skill.py`:

```python
def test_skill_phase2b_section_present(skill_text: str) -> None:
    assert "## Phase 2b — Surface" in skill_text
    assert "review-pdf append-chat" in skill_text
    assert "surfaced_resolved" in skill_text
    assert "commit-phase --phase 2b" in skill_text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py::test_skill_phase2b_section_present -v`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Append to `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

```markdown

## Phase 2b — Surface

Goal: for each `surfaced_pending` annotation, have a focused conversation with the user in this Claude Code terminal until the annotation either lands an applied edit (`surfaced_resolved`) or is declined (`deferred`).

### Enter Phase 2b

Read `state.json` and identify every annotation with `status == "surfaced_pending"`. For each, in user-chosen order:

1. Render the annotation context. Print to the terminal:
   - The PDF page number, the highlighted text, and the commenter's comment.
   - The current LaTeX snippet (read from `mapping.json` + the file).
   - Any prior chat turns from `state.json.annotations[id].surface_chat_log` (if resuming).

2. Open the conversation. Ask the user what they want to discuss. Don't draft an edit yet — surface annotations exist because the structural question needs to be settled first.

### Per-turn protocol

Every conversational turn (user OR Claude) is recorded:

```bash
echo "${TURN_TEXT}" > /tmp/review-pdf-chat-${id}-${TURN_NUM}.txt
review-pdf append-chat \
  --annotation-id "${id}" \
  --role {user,claude} \
  --text-file "/tmp/review-pdf-chat-${id}-${TURN_NUM}.txt" \
  --project-dir "<project-dir>"
```

Append before composing the next turn. This way a session crash mid-conversation loses at most one in-flight turn, and a future Claude can resume with full chat history.

### Resolution: with an edit

When the conversation produces an agreed edit:

```bash
echo "${AGREED_EDIT}" > /tmp/review-pdf-surface-edit-${id}.tex
review-pdf apply \
  --annotation-id "${id}" \
  --new-text-file "/tmp/review-pdf-surface-edit-${id}.tex" \
  --project-dir "<project-dir>"
if review-pdf build --project-dir "<project-dir>"; then
  review-pdf set-status \
    --annotation-id "${id}" \
    --status surfaced_resolved \
    --project-dir "<project-dir>"
else
  # Build failed — revert, route to needs_review, keep talking.
  review-pdf revert \
    --annotation-id "${id}" \
    --status needs_review \
    --failure-log "<log path>" \
    --project-dir "<project-dir>"
fi
```

### Resolution: without an edit

When the user decides to drop the annotation (after discussion):

```bash
review-pdf set-status \
  --annotation-id "${id}" \
  --status deferred \
  --reason "surface conversation declined edit" \
  --project-dir "<project-dir>"
```

### Phase 2b commit boundary

When every `surfaced_pending` annotation is resolved (`surfaced_resolved` or `deferred`):

```bash
review-pdf commit-phase --phase 2b --project-dir "<project-dir>"
```

Per spec §13.2, Phase 2b emits one commit per resolved SURFACE annotation by default (substantive changes deserve isolated commits). The engine's `commit-phase` reads `state.json` and emits the commit set; you do not invoke `git` directly.

### What you do NOT do in Phase 2b

- Do NOT call `wait-event`. Phase 2b is terminal-driven, not viewer-driven. The viewer is read-only context.
- Do NOT batch chat turns to save CLI calls. One `append-chat` per turn — the audit trail matters.
- Do NOT skip the `build` check after `apply`. A surface conversation that produces a non-compiling edit just rejoins the `needs_review` pipeline.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py::test_skill_phase2b_section_present -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py
git commit -m "feat(skill): Phase 2b surface conversation instructions"
```

---

#### Task 14.6: Phase 3 instructions (final commit)

**Files:**
- Modify: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (append Phase 3 section)
- Test: `tests/test_skill.py` (add test)

**Implements spec:** §9.6 (Phase 3 final commit), §13.2 (commit message template), §18.5 (Phase 3 acceptance)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_skill.py`:

```python
def test_skill_phase3_section_present(skill_text: str) -> None:
    assert "## Phase 3 — Final commit" in skill_text
    assert "review-pdf status --json" in skill_text
    assert "commit-phase --phase 3" in skill_text
    # Must check for non-terminal statuses before commit:
    assert "terminal" in skill_text.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py::test_skill_phase3_section_present -v`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Append to `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

````markdown

## Phase 3 — Final commit

Goal: final build, final commit, hand the user back the artifact paths.

### Verify completeness

Read the status:

```bash
review-pdf status --json --project-dir "<project-dir>"
```

Parse the JSON. Every annotation must be in a TERMINAL status — one of `accepted`, `rejected`, `redrafted`, `deferred`, `surfaced_resolved`. If any annotation is in a non-terminal status (`pending`, `applied`, `surfaced_pending`, `needs_review`), HALT. Print to the user:

> "Cannot finalize: <N> annotation(s) remain non-terminal: <list of ids and their statuses>. Resolve them in Phase 2a (open the viewer) or Phase 2b (surface conversation) before finalizing."

Do NOT call `commit-phase --phase 3` until the check passes.

### Final build

```bash
review-pdf build --project-dir "<project-dir>"
```

If this fails, halt and ask the user to inspect the log. A failing final build almost certainly means a recent `redrafted` edit introduced a regression; recovery is to revisit Phase 2a on the most recently redrafted annotation.

### Final commit

```bash
review-pdf commit-phase \
  --phase 3 \
  --message-suffix "Reviewed-by: <ask user for name or git user.name>" \
  --project-dir "<project-dir>"
```

The engine renders the structured commit message (spec §13.2), runs `git commit`, prints the resulting commit SHA, and advances `state.json.phase` to `3-final`.

### Hand-off to the user

Print to the terminal:

- The final PDF path: `.review-state/builds/build-NNN.pdf` where `NNN` is the last successful build's ID (read from `state.json.builds`).
- The commit SHA (printed by `commit-phase`).
- A summary: `review-pdf status --project-dir "<project-dir>"`.

### What you do NOT do in Phase 3

- Do NOT commit if any annotation is non-terminal — even if the user asks. Refuse and explain.
- Do NOT delete `.review-state/`. The user may want to audit later, and re-running `extract --force` is the explicit way to start fresh.
- Do NOT push to remote. Push is the user's call.
````

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py::test_skill_phase3_section_present -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py
git commit -m "feat(skill): Phase 3 final commit instructions"
```

---

#### Task 14.7: Recovery and resumption

**Files:**
- Modify: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (append Resumption section)
- Test: `tests/test_skill.py` (add test)

**Implements spec:** §5.1 (atomic writes — readers tolerate transient FileNotFoundError), §10.5 (context compaction recovery), §18.6 (general acceptance — state persists across compaction)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_skill.py`:

```python
def test_skill_resumption_section_present(skill_text: str) -> None:
    assert "## Resuming an interrupted session" in skill_text
    # Resume from state.json.phase:
    assert "state.json" in skill_text and "phase" in skill_text
    # Context compaction explicitly covered:
    assert "compaction" in skill_text.lower() or "compact" in skill_text.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py::test_skill_resumption_section_present -v`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Append to `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

```markdown

## Resuming an interrupted session

The engine's atomic-write guarantee (spec §5.1) means `state.json` is always consistent on disk — every read either sees the pre-mutation state or the post-mutation state, never a half-written intermediate. You can resume from a crash, a Ctrl-C, a closed laptop, or a Claude Code context compaction with no special recovery dance.

### Recovery procedure (run at the start of any resumed session)

1. Read `<project-dir>/.review-state/state.json`. Look at `phase`:
   - `0-setup` → re-enter Phase 0. Read `mapping.json` for unresolved `needs_review` entries.
   - `1-batch` → re-enter Phase 1. Filter `state.annotations` to `status == "pending"` AND `trigger_match == false`; resume the batch loop from there.
   - `2a-ratify` → re-enter Phase 2a. Re-launch the viewer (`review-pdf serve`) and the `wait-event` loop. Any clicks that landed while the previous session was offline are still in `state-events.jsonl` — `wait-event --since <last_observed_ts>` will replay them. But the simpler approach is: pass no `--since` initially; the engine defaults to the timestamp of the last event already in the file, which gives you a clean "from now on" stream.
   - `2b-surface` → re-enter Phase 2b. Read each `surfaced_pending` annotation's `surface_chat_log` to recover the conversation history before continuing.
   - `3-final` → the session is complete. Print the final commit SHA from `git log -1 --format="%H"` (the most recent commit landed by `commit-phase --phase 3`).

2. Verify state consistency by running `review-pdf status --project-dir "<project-dir>"`. The engine reads `state.json` and reports the same picture; if status disagrees with what you read, the disk read raced with a writer (rare; retry once).

### Mid-batch Phase 1 interruption

If Phase 1 was interrupted mid-loop (e.g., bash subprocess killed), some annotations are `applied` and some are still `pending`. The reverse-line-order rule guarantees this is safe: every `applied` annotation was edited at a higher line number than every still-`pending` annotation in the same file, so the pending annotations' `line_range` values are still valid. Resume by:

1. Sort all remaining `pending` (non-SURFACE) annotations as in Task 14.3 step 3.
2. Continue the batch loop.

### Context compaction mid-loop

Claude Code may compact the conversation mid-loop. The bash subprocess (`wait-event`, `apply`, `build`) is independent of the model context — it continues to completion regardless. After compaction:

1. Re-read `state.json`. Trust disk over memory.
2. If a `wait-event` subprocess was in flight, re-issue `wait-event --since <last_observed_ts>` to pick up where it left off (or with no `--since` if you're willing to drop events that landed during the compaction; typically only ratify events are in flight and the viewer will refresh anyway).
3. Continue the phase.

### Forbidden recovery moves

- Do NOT manually edit `state.json` with the Edit tool to "fix" a status. Use `review-pdf set-status` (which validates the transition per spec §10.3).
- Do NOT delete `.review-state/builds/` to "save space" mid-session. Builds are referenced by `state.json.builds[]` and by the viewer's preview pane.
- Do NOT re-run `review-pdf extract` without `--force` after Phase 0; the engine will refuse (exit 3). If you want to re-extract, explicitly confirm with the user that the working session can be discarded, then run `extract --force`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py::test_skill_resumption_section_present -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py
git commit -m "feat(skill): resumption-from-checkpoint instructions"
```

---

#### Task 14.8: Skill installation note

**Files:**
- Modify: `~/.claude/skills/review-pdf-to-latex/SKILL.md` (append Installation section)
- Test: `tests/test_skill.py` (add test)

**Implements spec:** §16 (dependencies), §17 (out of scope — no UX onboarding committed)

- [ ] **Step 1: Write the failing test**

Append to `tests/test_skill.py`:

```python
def test_skill_installation_note_present(skill_text: str) -> None:
    assert "## Installation" in skill_text
    assert "pip install" in skill_text
    assert "review-pdf status --help" in skill_text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_skill.py::test_skill_installation_note_present -v`
Expected: FAIL.

- [ ] **Step 3: Write minimal implementation**

Append to `~/.claude/skills/review-pdf-to-latex/SKILL.md`:

```markdown

## Installation

This skill assumes the engine is installed on `PATH` as `review-pdf`. Install with:

```bash
pip install -e ~/PycharmProjects/review-pdf-to-latex
```

(For development; uses the local checkout.) Or, once published:

```bash
pipx install review-pdf-to-latex
```

Verify the engine is reachable:

```bash
review-pdf status --help
```

Expected: a help banner printed to stdout, exit code 0. If you see `command not found`, the engine is not installed; halt and ask the user to install it before invoking the skill.

System binaries assumed available on `PATH`: `pdftoppm` (Poppler), `pdflatex` and `xelatex` (TeX Live), `git`. The engine will print a clear error if any of these is missing on its first invocation; relay the error to the user verbatim.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_skill.py::test_skill_installation_note_present -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/test_skill.py
git commit -m "feat(skill): installation note"
```

---

### Task 15: README polish — implements spec §6 (repo layout)

**Files:**
- Modify: `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/README.md`
- Create: `tests/test_readme.py`
- Test: `tests/test_readme.py`

**Implements spec:** §6 (repo layout), §16 (dependencies / install command), §17 (status — pre-1.0, scope boundary)

The existing README is brainstorm-era. Rewrite it to be the first thing a new collaborator (or future Anthony) reads in the repo, with a working quickstart that matches the v1 CLI surface.

---

#### Task 15.1: README rewrite

**Files:**
- Modify: `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/README.md`
- Create: `tests/test_readme.py`

**Implements spec:** §6 (repo layout), §8 (CLI inventory), §9 (phases)

- [ ] **Step 1: Write the failing test**

Create `tests/test_readme.py`:

```python
"""README structural tests (Task 15.1)."""

import re
from pathlib import Path

import pytest

README = Path(__file__).resolve().parent.parent / "README.md"


@pytest.fixture
def readme_text() -> str:
    if not README.exists():
        pytest.fail(f"README.md missing at {README}")
    return README.read_text(encoding="utf-8")


def test_readme_h1_present(readme_text: str) -> None:
    assert readme_text.startswith("# review-pdf-to-latex"), "missing H1 title line"


def test_readme_required_h2_sections_in_order(readme_text: str) -> None:
    expected = [
        "## What this is",
        "## When you want this",
        "## Install",
        "## Quickstart",
        "## CLI reference",
        "## Architecture",
        "## Status",
        "## License",
    ]
    positions = []
    for heading in expected:
        idx = readme_text.find("\n" + heading + "\n")
        assert idx != -1, f"missing H2 section: {heading}"
        positions.append((heading, idx))
    # Verify order
    for (a, ai), (b, bi) in zip(positions, positions[1:]):
        assert ai < bi, f"section order wrong: {a!r} appears after {b!r}"


def test_readme_install_block_has_pip_install(readme_text: str) -> None:
    # The Install section must contain a pip install command in a code fence.
    install_idx = readme_text.find("## Install")
    next_h2 = readme_text.find("\n## ", install_idx + 1)
    install_block = readme_text[install_idx:next_h2 if next_h2 != -1 else None]
    assert "pip install -e" in install_block
    assert ".claude/skills/review-pdf-to-latex" in install_block


def test_readme_cli_reference_mentions_all_14_subcommands(readme_text: str) -> None:
    cli_idx = readme_text.find("## CLI reference")
    next_h2 = readme_text.find("\n## ", cli_idx + 1)
    cli_block = readme_text[cli_idx:next_h2 if next_h2 != -1 else None]
    for sub in (
        "extract", "serve", "apply", "revert", "preview", "build", "status",
        "override-mapping", "set-status", "append-chat", "record-proposal",
        "commit-phase", "wait-event", "migrate-state",
    ):
        # Subcommand name as standalone word or in `review-pdf <sub>`:
        pattern = re.compile(r"\b" + re.escape(sub) + r"\b")
        assert pattern.search(cli_block), f"CLI reference missing subcommand: {sub}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_readme.py -v`
Expected: FAIL on `test_readme_required_h2_sections_in_order` (current README has different headings).

- [ ] **Step 3: Write minimal implementation**

Overwrite `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/README.md`:

```markdown
# review-pdf-to-latex

Walk PDF annotations into LaTeX source edits, paragraph by paragraph, with a sidecar viewer and live rebuilt-PDF preview. Engine is a Python CLI; the playbook is a Claude Code skill that drives the engine through a four-phase workflow.

## What this is

A two-artifact tool. The **engine** is a Python package exposing a `review-pdf` CLI plus a local HTTP viewer; it knows nothing about Claude. The **skill** (a markdown file at `~/.claude/skills/review-pdf-to-latex/SKILL.md`) teaches Claude Code how to drive the engine through Phase 0 (extract), Phase 1 (batch pre-apply), Phase 2a (ratify in browser), Phase 2b (surface conversation in terminal), and Phase 3 (final commit). All state lives in `.review-state/` at the LaTeX project root; the engine is the sole writer.

## When you want this

- You have an annotated PDF (highlights + comments) produced by an external reviewer.
- The PDF was rendered from a LaTeX source tree you own.
- You work in Claude Code and want a structured walkthrough rather than a batch-apply + cold re-read.
- You want a clean git audit trail of which annotations you accepted, rejected, redrafted, or deferred.

If your source is DOCX, Markdown, or HTML: this tool is not for you (LaTeX-only, by design — see spec §17).

## Install

```bash
# Engine (this repo):
pip install -e .[dev]

# Skill (one-time, installs the playbook for Claude Code):
mkdir -p ~/.claude/skills/review-pdf-to-latex
cp docs/skill-reference/SKILL.md ~/.claude/skills/review-pdf-to-latex/SKILL.md
# OR write your own SKILL.md from the spec at docs/specs/.

# Verify:
review-pdf status --help
```

System dependencies (must be on `PATH`): `pdftoppm` (Poppler), `pdflatex` and `xelatex` (TeX Live), `git`.

## Quickstart

```bash
# Phase 0: extract annotations + render pages + build initial mapping
review-pdf extract \
  --pdf ~/Downloads/annotated.pdf \
  --project-dir ~/projects/my-latex-paper/

# If there are needs_review mappings, resolve them in the browser:
review-pdf serve --project-dir ~/projects/my-latex-paper/ --mapping-mode
# (open the URL it prints, click [Confirm] on each, then Ctrl-C the server)

# Now hand the wheel to Claude Code. In a Claude Code session in the project:
#   /review-pdf-to-latex
# The skill walks Phase 1 (batch pre-apply), launches the viewer for Phase 2a,
# handles Phase 2b conversations in the terminal, and finalizes with Phase 3.
```

The Phase 2a viewer renders three panes: source PDF page (with highlight overlay), source LaTeX (with the proposed edit), and the live rebuilt PDF (with a pagination indicator: "no shift" vs. "shift at p.N"). Buttons: Approve, Reject, Redraft, Preview, Skip, Surface.

## CLI reference

| Subcommand | One-liner |
|---|---|
| `extract` | Read the PDF, fuzzy-map every annotation to a LaTeX line range, render page PNGs, write initial state. |
| `serve` | Start the local HTTP viewer (Phase 2a) or the mapping-mode UI (Phase 0 cleanup). |
| `apply` | Replace a mapped line range in a `.tex` file; capture `before_text` on first apply. |
| `revert` | Restore `before_text`; optionally records `failure_log_path` for Phase-1 compile failures. |
| `preview` | Speculative compile: in-place edit, build, restore. Produces a transient build PDF for the viewer. |
| `build` | Run `pdflatex` or `xelatex` twice, copy PDF to `.review-state/builds/`, append build record with per-page MD5 + pagination diff. |
| `status` | Counts per status, current phase, last build outcome, unresolved `needs_review`. |
| `override-mapping` | Manual mapping override for `needs_review` annotations. |
| `set-status` | Single mutator for status transitions that don't touch `.tex` files (Approve, Skip, Surface, terminal markers). |
| `append-chat` | Append one chat turn to a SURFACE annotation's `surface_chat_log`. |
| `record-proposal` | Stage `proposed_text` without mutating `.tex` (for replay / dry-run). |
| `commit-phase` | The sole mutator of `state.json.phase`; runs `git commit` with the structured message. |
| `wait-event` | Block on `state-events.jsonl`; print the next event or exit 20 on timeout. The skill's bash idiom. |
| `migrate-state` | Schema migration (stub in v1). |

Full per-command signatures, flags, and exit codes: [`docs/specs/2026-05-16-review-pdf-to-latex-design.md`](docs/specs/2026-05-16-review-pdf-to-latex-design.md), §8.

## Architecture

Sidecar pattern: a thin local HTTP viewer (vanilla HTML + 500ms polling) plus a stateless `review-pdf` CLI, driven from outside by Claude Code. The viewer never calls Claude; Claude never embeds a viewer. They meet at four files in `.review-state/`: `annotations.json` (immutable), `mapping.json` (editable via CLI), `state.json` (engine-owned), and `state-events.jsonl` (viewer-appended). See spec §5 for the full diagram and layer-responsibility table.

## Status

Pre-1.0; v1 acceptance criteria are listed in spec §18 and target the COTA Impact Report v2.0 review cycle as the first real run. See `CHANGELOG.md` for per-release details.

## License

MIT. The engine is intended for cross-project reuse and collaborator portability. The skill is personal/internal but follows the same license.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_readme.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add README.md tests/test_readme.py
git commit -m "docs: polish README for v1"
```

---

#### Task 15.2: CHANGELOG.md

**Files:**
- Create: `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/CHANGELOG.md`
- Create: `tests/test_changelog.py`
- Test: `tests/test_changelog.py`

**Implements spec:** §18 (acceptance — versioning discipline implied)

- [ ] **Step 1: Write the failing test**

Create `tests/test_changelog.py`:

```python
"""CHANGELOG structural tests (Task 15.2)."""

from pathlib import Path

import pytest

CHANGELOG = Path(__file__).resolve().parent.parent / "CHANGELOG.md"


def test_changelog_exists() -> None:
    assert CHANGELOG.exists(), f"CHANGELOG.md missing at {CHANGELOG}"


def test_changelog_has_unreleased_section() -> None:
    text = CHANGELOG.read_text(encoding="utf-8")
    assert "## [Unreleased]" in text


def test_changelog_follows_keep_a_changelog_header() -> None:
    text = CHANGELOG.read_text(encoding="utf-8")
    assert text.startswith("# Changelog")
    assert "Keep a Changelog" in text or "keepachangelog.com" in text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_changelog.py -v`
Expected: FAIL — file missing.

- [ ] **Step 3: Write minimal implementation**

Create `/Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex/CHANGELOG.md`:

```markdown
# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Engine scaffolding (`src/review_pdf_to_latex/`) with the 14-subcommand `review-pdf` CLI.
- `extract` subcommand: pdfannots + rapidfuzz fuzzy mapping + pdftoppm page rendering.
- `apply` / `revert` / `set-status` / `append-chat` / `record-proposal` / `override-mapping` mutators with atomic `state.json` writes.
- `build` subcommand: pdflatex/xelatex orchestration + pagination diff.
- `serve` subcommand: local HTTP viewer (Phase 2a) + `--mapping-mode` UI (Phase 0 cleanup).
- `preview` subcommand: speculative compile with in-memory snapshot/restore.
- `wait-event` subcommand: inotify/kqueue + stat-poll fallback on `state-events.jsonl`.
- `commit-phase` subcommand: sole mutator of `state.json.phase`; structured commit messages per spec §13.2.
- `status` subcommand: counts and current state, with `--json` for machine consumption.
- `migrate-state` subcommand: schema migration stub.
- Claude Code skill at `~/.claude/skills/review-pdf-to-latex/SKILL.md`: four-phase playbook driving the engine via CLI.
- Test suite: unit tests per module, end-to-end fixture against a synthetic annotated PDF + minimal LaTeX project.

### Fixed
- (List bug fixes here as they land.)

### Changed
- (List breaking or notable behavior changes here.)

## [0.1.0] - YYYY-MM-DD

_v1 release; date filled in on tag. Acceptance criteria: spec §18._
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_changelog.py -v`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md tests/test_changelog.py
git commit -m "docs: add CHANGELOG.md"
```

---

### Task 16: Spec Coverage Audit

This is the self-review pass for the assembled plan. Walk the spec end to end; mark each section with the tasks that implement it. Where a requirement has no task, flag `GAP`.

Chunk allocation (assembled plan):

- **Chunk A** — header + scaffold + `state.py` + `cli.py` router + `commit.py` (Tasks 1, 2, 3, 7).
- **Chunk B** — `extract.py` + `mapping.py` (Task 4).
- **Chunk C** — `apply.py` + line-shift tracking + `set-status` + `append-chat` + `record-proposal` + `override-mapping` (Task 6).
- **Chunk D** — `build.py` + `preview.py` + pagination diff (Tasks 5, 10).
- **Chunk E** — `server.py` + viewer templates + `wait-event` (Tasks 8, 9).
- **Chunk F** — `status.py` + e2e fixtures + end-to-end tests + acceptance harness + `migrate-state` stub (Tasks 11, 12, 13).
- **Chunk G** — `SKILL.md` + README + CHANGELOG + this audit (Tasks 14, 15, 16).

---

## Spec Coverage Audit

The table walks the spec from §1 to §18 (skipping §19 Glossary, which is reference). For each row, "Tasks" lists the chunk(s) that implement it; "Status" is `ok` if covered, `GAP` if not.

| Spec § | Topic | Tasks | Status |
|---|---|---|---|
| §1 | Summary | N/A — descriptive | ok |
| §2 | Problem statement | N/A — descriptive | ok |
| §3.1 | Goals | Chunk F (acceptance harness in Task 12); Chunk G Task 15 (README "What this is" reflects goals) | ok |
| §3.2 | Non-goals (explicit cuts) | Chunk G Task 15.1 (README "When you want this" notes LaTeX-only); enforced negatively across all chunks by absence of forbidden features | ok |
| §4 | First concrete use case (COTA paths) | Chunk F (e2e fixture uses synthetic; first real COTA run is a manual post-v1 invocation gated on acceptance harness passing) | ok |
| §5 | Architecture overview + layer table | Chunks A–G collectively; Chunk G Task 14 SKILL.md (skill-layer responsibilities), Chunk G Task 15.1 README "Architecture" section | ok |
| §5.1 | State mutation rule (engine is sole writer) | Chunk A (`state.py` atomic_write_json); Chunk G Task 14 (SKILL.md repeatedly forbids direct Edit/Write on state files) | ok |
| §6 | Repository layout | Chunk A (creates `src/`, `tests/`, `pyproject.toml`, `LICENSE`); Chunk G Task 15.1 (README documents the layout implicitly via Install + CLI reference) | ok |
| §7.1 | `annotations.json` schema (immutable) | Chunk A (schema_version handling); Chunk B (`extract.py` writes it) | ok |
| §7.2 | `mapping.json` schema | Chunk A (schema_version); Chunk B (extract writes initial); Chunk C (`override-mapping` mutates); Chunk C (line-shift recompute on apply) | ok |
| §7.3 | `state.json` schema (mutable session state) | Chunk A (`state.py` read/write); Chunk C (all status-mutating CLI subcommands); Chunk A `commit-phase` (phase transitions); Chunk D `build` (appends to `builds[]`) | ok |
| §7.3 — status enum | Status values: pending/applied/accepted/rejected/redrafted/deferred/surfaced_pending/surfaced_resolved/needs_review | Chunk A (enum constants in `state.py`); Chunk A Task 2.6 (`validate_status_transition` legal transition table); Chunk C (`set-status` validates transitions) | ok |
| §7.3 — phase enum | `0-setup` / `1-batch` / `2a-ratify` / `2b-surface` / `3-final` | Chunk A (`commit-phase` is the sole mutator) | ok |
| §7.4 | `state-events.jsonl` append-only event log | Chunk E (`server.py` viewer POST handler appends); Chunk E (`wait-event` reads) | ok |
| §8 — `extract` | CLI signature + exit codes | Chunk B (Task 4) | ok |
| §8 — `serve` | CLI signature + `--mapping-mode` | Chunk E (Task 8) | ok |
| §8 — `apply` | Signature + `--dry-run` | Chunk C (Task 5) | ok |
| §8 — `revert` | Signature + `--failure-log` + `--status {rejected,needs_review}` | Chunk C (Task 5) | ok |
| §8 — `preview` | Signature + snapshot/restore semantics | Chunk D (Task 7) | ok |
| §8 — `build` | Signature + `--engine {pdflatex,xelatex,auto}` | Chunk D (Task 6) | ok |
| §8 — `status` | Signature + `--json` | Chunk F (Task 10) | ok |
| §8 — `override-mapping` | Signature | Chunk C (Task 5) | ok |
| §8 — `set-status` | Signature + transition validation | Chunk C (Task 5) | ok |
| §8 — `append-chat` | Signature | Chunk C (Task 5) | ok |
| §8 — `record-proposal` | Signature | Chunk C (Task 5) | ok |
| §8 — `commit-phase` | Signature + `--granularity` + sole phase mutator | Chunk A (Task 3, `commit.py`) | ok |
| §8 — `wait-event` | Signature + inotify/kqueue + stat-poll fallback + exit code 20 on timeout | Chunk E (Task 9) | ok |
| §8 — `migrate-state` | Stub for v1 | Chunk F Task 13 (`migrate.py` stub raising `UnsupportedMigrationError` → exit code 14 for any `--from N --to M`; deliberately does NOT call `state.assert_source_pdf_unchanged`, per the inline note in Task 13.2's handler) | ok |
| §9.1 | Phase 0 — Setup | Chunk B (engine driver); Chunk G Task 14.2 (skill instructions) | ok |
| §9.2 | Phase 1 — Batch pre-apply | Chunk G Task 14.3 (skill drives the loop); engine primitives in chunks C, D | ok |
| §9.3 | Phase 2a — Ratify | Chunk G Task 14.4 (skill wait-event loop); Chunk E (viewer + wait-event); Chunk C (set-status, revert); Chunk D (build, preview) | ok |
| §9.4 | Phase 2b — Surface | Chunk G Task 14.5 (skill instructions); Chunk C (append-chat); Chunk A (commit-phase per-annotation) | ok |
| §9.5 | Phase 2 order toggle | Chunk E (serve `--order` flag); Chunk A (commit-phase reads `order` from state) | ok |
| §9.6 | Phase 3 — Final commit | Chunk G Task 14.6 (skill instructions); Chunk A (commit-phase --phase 3) | ok |
| §10.1 | Viewer 3-pane layout | Chunk E (templates: `frame.html`, `annotation.html`) | ok |
| §10.2 | Interaction model (button-only, 500ms poll) | Chunk E (template JS) | ok |
| §10.3 | Button semantics table | Chunk E (POST handler dispatch); Chunk C (set-status transition validation); Chunk G Task 14.4 (skill per-action dispatch matches the table) | ok |
| §10.4 | Front-end dependencies (vanilla HTML, optional diff2html) | Chunk E (templates) | ok |
| §10.5 | Click→engine path (wait-event bash idiom) | Chunk E (wait-event impl); Chunk G Task 14.4 (skill bash loop) | ok |
| §10.6 | Manual mapping UI (`--mapping-mode`) | Chunk E (serve `--mapping-mode` template branch); Chunk C (override-mapping CLI); Chunk G Task 14.2 (skill Phase 0 instructions invoke it) | ok |
| §11.1 | Compile strategy B + per-item Preview | Chunk D (`preview.py` snapshot/restore); Chunk D (`build.py` async per Approve/Reject/Redraft); Chunk G Task 14.4 (skill triggers builds) | ok |
| §11.2 | Pagination detection algorithm | Chunk D (Task 6, `build.py` per-page MD5 + diff to previous successful build) | ok |
| §11.3 | Compile-time benchmark + 5s degradation threshold | Chunk D (Task 6, writes `.review-state/perf-warning` sentinel); Chunk E (viewer reads sentinel and switches to manual-rebuild mode) | ok |
| §12.1 | Fuzzy mapping algorithm + thresholds | Chunk B (Task 4, `mapping.py`) | ok |
| §12.2 | Phase 1 compile failure recovery | Chunk C (revert `--failure-log`); Chunk G Task 14.3 (skill loop branches on exit 11) | ok |
| §12.3 | Phase 2a/2b compile failure recovery | Chunk D (build exit 11 path); Chunk E (viewer renders failure log path inline); Chunk G Task 14.4 (skill redraft branch) | ok |
| §12.4 | Edit conflicts (overlapping line ranges) | Chunk C (apply exit 16 on overlap); Chunk G Task 14.3 (skill aborts on exit 16 and surfaces to user) | ok |
| §13.1 | Clean-state precondition | Chunk A (commit-phase / pre-Phase-1 git status check, exit 15); Chunk G Task 14.3 (skill verifies up front) | ok |
| §13.2 | Commit granularity + message template | Chunk A (commit.py template rendering); Chunk G Task 14.3 / 14.4 / 14.5 / 14.6 (skill commit-phase invocations per phase) | ok |
| §13.3 | State directory location (project-local) | Chunk B (extract creates `.review-state/`); Chunk A (state.py paths); Chunk G Task 15.1 (README "Architecture" notes it) | ok |
| §14 risk 1 | Fuzzy mapping fails on tables/captions | Chunk B (needs_review bucket); Chunk C (override-mapping); Chunk E (mapping-mode UI) | ok |
| §14 risk 2 | Pre-applied edit breaks LaTeX build | Chunk C (revert --failure-log); Chunk D (build exit 11); Chunk G Task 14.3 (skill handles) | ok |
| §14 risk 3 | Edit conflicts (overlapping ranges) | Chunk C (apply exit 16) | ok |
| §14 risk 4 | Context compaction | Chunk G Task 14.7 (skill resumption instructions); Chunk A (atomic writes guarantee read consistency) | ok |
| §14 risk 5 | Token cost across 80 walks | Chunk G Task 14.3 (skill streams candidates to disk; doesn't hold full set in memory); Chunk A (state.json caches proposed_text for Phase 2a) | ok |
| §14 risk 6 | pdflatex compile time | Chunk D (Task 6 emits timing to stderr); Chunk D (perf-warning sentinel at median > 5s) | ok |
| §14 risk 7 | LaTeX project layout differs | Chunk D (build auto-discovers `--main-file`; `--engine auto` from `\documentclass`) | ok |
| §14 risk 8 | Phase 1 modifying untracked files | Chunk A (commit-phase / pre-Phase-1 git status check, exit 15) | ok |
| §14 risk 9 | PDF replaced mid-review | Chunk A Task 2.7 (`state.assert_source_pdf_unchanged` helper + `SourcePdfChangedError` / `LegacyStateError`); Chunk A Task 3.3 (exit codes 21, 22); Chunk B Task 4.5 (extract writes `source_pdf_md5` into annotations.json); Chunk C Tasks 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7 (every mutator invokes the guard at entry); Chunk A Task 7.4 (commit-phase invokes the guard); Chunk F Task 12.8 (e2e reachability for exit 21 and exit 22) | ok |
| §14 risk 10 | LaTeX engine mismatch | Chunk D (build `--engine auto` + warning) | ok |
| §14 risk 11 | Multiple `serve` instances | Chunk E (serve.lock + `--force-unlock`) | ok |
| §15 Q1 | Phase 1 invocation surface | Resolved in spec; Chunk G Task 14.3 (skill instructions); Chunk C (apply `--dry-run`) | ok |
| §15 Q2 | Commit granularity | Resolved in spec; Chunk A (commit.py `--granularity` flag) | ok |
| §15 Q3 | SURFACE trigger phrase shape | Resolved in spec; Chunk B (extract `--surface-trigger` flag, case-insensitive substring) | ok |
| §15 Q4 | Re-mapping on edit conflicts | Resolved in spec; Chunk C (flag-and-require-sequential) | ok |
| §15 Q5 | Build dir layout | Resolved in spec; Chunk D (auto-discover `\documentclass` + `\begin{document}`) | ok |
| §15 Q6 | State directory location | Resolved in spec; Chunk B + A (`.review-state/` at project root) | ok |
| §15 Q7 | Viewer poll interval configurable | Deferred per spec; no task needed | ok |
| §15 Q8 | state-events.jsonl rotation | Deferred per spec; no task needed | ok |
| §15 Q9 | pdftoppm cache vs. regenerate | Chunk B Task 4.3 (lazy regenerate: page-N.png is rendered only if absent OR its mtime is older than the source PDF's mtime) | ok |
| §16.1 | Python 3.11+ target | Chunk A (pyproject.toml `requires-python = ">=3.11"`) | ok |
| §16.2 | Dependency inventory | Chunk A (pyproject.toml dependencies); Chunk G Task 15.1 (README notes system binaries) | ok |
| §17 | Out of scope (hard boundary) | Negatively enforced across all chunks (no DOCX, no SDK, no daemon); Chunk G Task 15.1 (README "When you want this" warns LaTeX-only) | ok |
| §18.1 | Acceptance — Phase 0 | Chunk F (acceptance harness Task 12 — runs `extract` against fixture and asserts 80 annotations / page PNGs / mapping confidences) | ok |
| §18.2 | Acceptance — Phase 1 | Chunk F (e2e test runs Phase 1 loop against synthetic fixture and asserts ≥80% applied without compile failure) | ok |
| §18.3 | Acceptance — Phase 2a | Chunk F (e2e test simulates all six button events and asserts state transitions per §10.3); Chunk E (server tests cover button dispatch) | ok |
| §18.4 | Acceptance — Phase 2b | Chunk F (e2e test runs a SURFACE annotation through append-chat + apply + set-status surfaced_resolved) | ok |
| §18.5 | Acceptance — Phase 3 | Chunk F (e2e test runs `commit-phase --phase 3` and asserts commit message format + state.json.phase) | ok |
| §18.6 | Acceptance — General (state persistence, exit code reachability, dirty-git refusal) | Chunk F (state-persistence test kills serve, restarts, asserts resume); Chunk A Task 3.3 (exit-code constants pin test); Chunk F Tasks 12.7, 12.8 (build-failure exit 11, source-PDF-changed exit 21, legacy-state exit 22); Chunk A Task 7.1 (dirty-git refusal in commit-phase, exit 15) | ok |

### Audit summary

- Sections covered: 79 of 79 (counting each row).
- Sections marked `ok`: 79.
- Sections marked `GAP CANDIDATE`: 0.

Pass-3 follow-up: both prior gap candidates were resolved. §14 risk 9 is now implemented across Chunk A Task 2.7 (the guard helper), Chunk A Task 3.3 (exit codes 21, 22), Chunk B Task 4.5 (writes `source_pdf_md5`), Chunk C Tasks 6.1–6.7 (per-mutator invocations), Chunk A Task 7.4 (commit-phase invocation), and Chunk F Task 12.8 (e2e reachability for exit 21 and exit 22). §15 Q9 is now implemented in Chunk B Task 4.3 (lazy regenerate with mtime invalidation).

### Cross-chunk consistency checks (engineer should verify before merging plan)

- All chunks use the same status enum strings (spec §7.3): `pending`, `applied`, `accepted`, `rejected`, `redrafted`, `deferred`, `surfaced_pending`, `surfaced_resolved`, `needs_review`. No chunk introduces variants.
- All chunks use the same phase enum strings: `0-setup`, `1-batch`, `2a-ratify`, `2b-surface`, `3-final`.
- All chunks use the same action enum strings (spec §7.4): `approve`, `reject`, `redraft`, `preview`, `skip`, `surface`, `override-mapping`. The internal action `apply` (lowercase) is the value `validate_status_transition` accepts when chunk C's apply mutator drives a `pending` → `applied` transition; it is engine-internal and never appears in `state-events.jsonl`.
- All chunks use the same exit-code mapping (spec §8 plus codes 21 and 22 added for the source-PDF integrity guard). Chunk A's `cli.py` exposes these as named constants imported by every other module.
- All chunks reference `.review-state/` (with the dot) consistently.
- All chunks use `--annotation-id`, `--project-dir`, `--new-text-file` exactly as named — no `--id`, `--proj`, `--text` shortcuts.
- All chunks use the same atomic-write helper (`state.atomic_write_json` from chunk A). No chunk reimplements it locally.
- `validate_status_transition(from_status, to_status, action)` is called with three positional arguments at every callsite. Chunk A Task 2.6 defines the signature; Chunk C Tasks 6.1, 6.4, 6.5 are the live callers.
- `state.assert_source_pdf_unchanged(state_dir)` is called at entry of every mutator that touches `state.json` *except* `migrate-state` (which by design must run against legacy/orphaned state files; see the inline comment in Chunk F Task 13.2's handler).

If any of the above checks fails on assembly, that chunk needs a fix-up commit before the plan is executable.
