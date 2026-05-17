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
