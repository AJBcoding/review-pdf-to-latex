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

Dataclass-vs-dict direction (decided at schema-v2, rev-l2)
----------------------------------------------------------
The persisted **JSON dict keys are the normative schema**; the dataclasses
below (``Annotation``, ``Mapping``, ``AnnotationState``, …) are
**bootstrap/validation builders**, not the runtime carriers. Only the
``extract`` bootstrap path constructs them; every mutator in ``apply.py``
reads and writes raw dicts. This direction was chosen over "route all
mutators through the dataclasses" because the latter is a large, high-risk
rewrite of the least-typed boundary in the repo (spec D7 §7 pt 2: the
dataclasses are "write-only"). The contract that keeps this safe: each
``from_dict``/``to_dict`` MUST mirror the dict schema exactly — every key a
mutator writes is a declared field — so the dataclasses stay an accurate
description of what is on disk. The three pre-v2 drifts (REVIEW.md
"Half-adopted typed layer") are closed under this rule: ``last_status_reason``
is now a declared ``AnnotationState`` field, ``Mapping.from_dict`` tolerates a
``candidates: null``, and ``Annotation.created`` is typed ``str | None``.
"""

from __future__ import annotations

from pathlib import Path

from .exit_codes import (
    EXIT_MIGRATION_REQUIRED,
    EXIT_SCHEMA_UNSUPPORTED,
    EngineError,
)


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


SUPPORTED_SCHEMA = 2
"""The schema_version this build of the engine reads and writes.

Bumped only on breaking changes per spec §7. A backwards-compatible
field addition does NOT bump this constant. The ``review-pdf
migrate-state`` subcommand handles upgrades when the major version
changes.

v2 (rev-l2, spec D7 §7) is the first real bump: ``annotations.json`` gains
``subtype``/``native_id``/``in_reply_to`` (PDF round-trip fields), and
``mapping.json`` renames ``latex_file`` → ``file``. The ``(1, 2)`` migration
is registered in :mod:`review_pdf_to_latex.migrate`.
"""


class SchemaVersionError(EngineError):
    """Raised when a state file's schema_version is missing or unsupported.

    Distinct from :class:`MigrationRequiredError`, which signals a known
    older version that the engine could migrate forward via
    ``review-pdf migrate-state``.

    Carries ``exit_code = EXIT_SCHEMA_UNSUPPORTED`` (24) so the top-level
    ``cli.main`` catch — and the ``_guard_source_pdf``-style wrappers in
    ``apply``/``commit`` — map it to a single spec-§8 code (rides X10).
    """

    exit_code = EXIT_SCHEMA_UNSUPPORTED


class MigrationRequiredError(EngineError):
    """Raised when a state file's schema_version is older than SUPPORTED_SCHEMA.

    The engine refuses to read the file in place; the user must run
    ``review-pdf migrate-state --from N --to M`` to upgrade it.

    Carries ``exit_code = EXIT_MIGRATION_REQUIRED`` (25) so the top-level
    ``cli.main`` catch — and the ``_guard_source_pdf``-style wrappers in
    ``apply``/``commit`` — map it to a single spec-§8 code (rides X10).
    """

    exit_code = EXIT_MIGRATION_REQUIRED


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
    """One entry in ``annotations.json.annotations[]`` (spec §7.1, immutable).

    schema-v2 round-trip fields (rev-l2, spec D7 §7) — all optional, all
    bridged one-way into the unified ``CommentV2.native`` block at the
    engine↔desktop seam:

    - ``subtype``: PDF annotation subtype (``Highlight``/``StrikeOut``/
      ``Underline``/``Squiggly``/``Text``/…). Before v2, extraction could not
      even distinguish a Highlight from a StrikeOut (Pass-2 reusability note).
    - ``native_id``: the native PDF annotation id (the ``/NM`` name), used by
      the Acrobat round-trip to edit-in-place instead of re-minting. ``None``
      when the source annotation carries no ``/NM``.
    - ``in_reply_to``: the ``native_id`` of this annotation's reply parent, in
      the same ``/NM`` namespace as ``native_id``. Optional and populated only
      when the source PDF exposes a resolvable reply reference (spec §8 spike
      S-1 read half); ``None`` otherwise.

    ``created`` is ``str | None``: pdfannots annotations may carry no creation
    timestamp (``_format_created`` returns ``None`` there).
    """

    id: str
    page: int
    bbox: tuple[float, float, float, float]
    highlighted_text: str
    author: str
    comment: str
    created: str | None
    trigger_match: bool
    subtype: str | None = None
    native_id: str | None = None
    in_reply_to: str | None = None

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
            created=d.get("created"),
            trigger_match=bool(d["trigger_match"]),
            subtype=d.get("subtype"),
            native_id=d.get("native_id"),
            in_reply_to=d.get("in_reply_to"),
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
            "subtype": self.subtype,
            "native_id": self.native_id,
            "in_reply_to": self.in_reply_to,
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
    """One entry in ``mapping.json.mappings`` (spec §7.2).

    schema-v2 (rev-l2): the source-location field is ``file`` (was
    ``latex_file`` in v1). The rename de-LaTeXes the engine for the
    multi-format direction — the mapping/apply machinery treats the target
    purely as text lines, nothing about it is LaTeX-specific — and aligns the
    field with :class:`MappingCandidate`, which already named it ``file``.
    """

    file: str | None
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
        # `or []` tolerates a `candidates: null` on disk — override_mapping
        # historically wrote None there (closed drift (b), REVIEW.md).
        return cls(
            file=d.get("file"),
            line_range=line_range,
            confidence=float(d["confidence"]),
            method=d["method"],
            needs_review=bool(d["needs_review"]),
            candidates=[
                MappingCandidate.from_dict(c) for c in (d.get("candidates") or [])
            ],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "file": self.file,
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
    # Free-form reason recorded by `set-status --reason` (closed drift (a),
    # REVIEW.md: apply.set_annotation_status writes this key, so it is a
    # declared field rather than a key to_dict silently drops).
    last_status_reason: str | None = None

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
            last_status_reason=d.get("last_status_reason"),
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
            "last_status_reason": self.last_status_reason,
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


# Canonical status enumeration — the single source of truth (rev-l13).
# Every other module that needs the status set imports from here; do NOT
# re-list these elsewhere. STATUSES preserves the spec §7.3 canonical order
# (it mirrors the `Status` Literal above; tests/test_state.py pins the two in
# sync). TERMINAL/NON_TERMINAL/ALL are unordered membership sets.
STATUSES: tuple[str, ...] = (
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
TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"accepted", "rejected", "redrafted", "deferred", "surfaced_resolved"}
)
NON_TERMINAL_STATUSES: frozenset[str] = frozenset(
    {"pending", "applied", "surfaced_pending", "needs_review"}
)
ALL_STATUSES: frozenset[str] = TERMINAL_STATUSES | NON_TERMINAL_STATUSES


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
    if status not in ALL_STATUSES:
        raise ValueError(
            f"unknown status: {status!r} (expected one of {sorted(ALL_STATUSES)})"
        )
    return status in TERMINAL_STATUSES


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


# Process-lifetime cache of source-PDF digests, keyed by identity coordinates
# (resolved path, mtime_ns, size). The source-PDF guard runs at the top of every
# mutator (apply / revert / set-status / append-chat / record-proposal /
# override-mapping / preview / commit-phase); a batch of N edits would otherwise
# re-hash the full PDF N times. Caching per (path, mtime, size) collapses that to
# a single hash as long as the file is untouched. A same-size, same-mtime swap
# (nanosecond-resolution mtime makes this practically unreachable) is the only
# way to defeat the key — an acceptable trade per L12's explicit cache contract.
_MD5_CACHE: dict[tuple[str, int, int], str] = {}


def _file_md5(path: Path) -> str:
    key: tuple[str, int, int] | None
    try:
        st = path.stat()
        key = (str(path), st.st_mtime_ns, st.st_size)
    except OSError:
        key = None
    if key is not None:
        cached = _MD5_CACHE.get(key)
        if cached is not None:
            return cached
    h = hashlib.md5()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    digest = h.hexdigest()
    if key is not None:
        _MD5_CACHE[key] = digest
    return digest


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
