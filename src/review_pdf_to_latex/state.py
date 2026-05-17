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
