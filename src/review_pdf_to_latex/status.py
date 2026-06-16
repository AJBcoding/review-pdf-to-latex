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

    # Zero-fill in the canonical spec §7.3 order (state.STATUSES) so the
    # report's `counts` dict is deterministic for machine consumers.
    counts: dict[str, int] = {s: 0 for s in _state.STATUSES}
    annotations = payload.get("annotations", {})
    for entry in annotations.values():
        s = entry.get("status")
        if s in counts:
            counts[s] += 1
        # Unknown statuses are silently ignored here; the read_json
        # schema check upstream is responsible for rejecting them.

    terminal = sum(counts[s] for s in _state.TERMINAL_STATUSES)
    non_terminal = sum(counts[s] for s in _state.NON_TERMINAL_STATUSES)
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
