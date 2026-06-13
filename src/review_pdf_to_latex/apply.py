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

    # Validate status transition before any .tex mutation (spec §10.3).
    # accepted and other terminal statuses are not in the apply action's
    # legal-from set; raising here keeps the file byte-identical on error.
    ann_entry = state["annotations"][annotation_id]
    current_status = ann_entry.get("status", "pending")
    try:
        validate_status_transition(current_status, "applied", "apply")
    except ValueError as exc:
        raise IllegalStatusTransitionError(str(exc)) from exc

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
    if ann_entry.get("before_text") is None:
        ann_entry["before_text"] = "".join(old_lines)
    ann_entry["proposed_text"] = new_text
    ann_entry["applied_text"] = new_text
    ann_entry["applied_at"] = _now_iso()
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
    # Derive how many lines the applied edit currently occupies from
    # applied_text rather than from the stored line_range.  The degenerate
    # range [start, start] that apply_edit records after an empty-text apply
    # (full deletion) claims one line but zero lines are actually present,
    # causing an off-by-one that destroys the next unrelated line on revert.
    applied_lines = _split_text_to_lines(ann_entry.get("applied_text") or "")
    current_count = len(applied_lines)

    # Validate status transition before any .tex mutation (spec §10.3).
    # Raising here keeps the file byte-identical when the transition is illegal.
    action = "reject" if status == "rejected" else "redraft"
    try:
        validate_status_transition(ann_entry.get("status", "pending"), status, action)
    except ValueError as exc:
        raise IllegalStatusTransitionError(str(exc)) from exc

    new_all = all_lines[: start - 1] + before_lines + all_lines[start - 1 + current_count:]

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

    # edited_range_end is the last line of the range that was replaced in the
    # current file.  For normal edits this equals `end` from the mapping.  For
    # the degenerate empty-apply case (current_count == 0) it is start - 1,
    # because the insertion point is before line `start` and every line at
    # start or later needs to be shifted.
    edited_range_end = start - 1 + current_count
    _recompute_subsequent_mappings(
        mapping, latex_file, edited_range_end=edited_range_end,
        line_shift=line_shift, skip_annotation_id=annotation_id,
    )

    # Update state entry.
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


def bulk_surface_pending(state_dir: Path) -> list[str]:
    """Promote every ``status=pending`` annotation with ``trigger_match=true``
    to ``surfaced_pending``.

    Skill-side workflow shortcut for ``--order surface-first`` runs (spec
    §9.5): when the surface-intent annotations dominate the residual set,
    walking them in Phase 2b *before* the Phase 1 mechanical batch avoids
    drafting mechanical edits that a SURFACE conversation may later
    invalidate (rev-bwi).

    Only annotations whose entry in ``annotations.json`` has
    ``trigger_match: true`` AND whose current state.json status is exactly
    ``pending`` are promoted. Annotations already in ``surfaced_pending``,
    ``surfaced_resolved``, ``applied``, or any terminal status are left
    untouched. Validation goes through ``validate_status_transition`` per
    the (pending, surface) row in §10.3 — an illegal transition raises
    ``IllegalStatusTransitionError`` and aborts the batch before any write
    (state.json is only persisted if every candidate validates).

    Args:
        state_dir: ``.review-state`` directory.

    Returns:
        The ids of annotations that were promoted, in annotations.json
        document order. An empty list if no candidates matched.

    Raises:
        FileMutationError: state.json or annotations.json missing.
        IllegalStatusTransitionError: any candidate fails validation.
        SourcePdfChangedApplyError / LegacyStateApplyError: source PDF guard.
    """
    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)
    state_path = state_dir / "state.json"
    annotations_path = state_dir / "annotations.json"
    if not state_path.exists():
        raise FileMutationError(f"state.json not found at {state_path}")
    if not annotations_path.exists():
        raise FileMutationError(
            f"annotations.json not found at {annotations_path}"
        )

    state = _read_json(state_path)
    annotations_doc = _read_json(annotations_path)
    state_entries: dict[str, Any] = state.get("annotations", {})

    promoted: list[str] = []
    for ann in annotations_doc.get("annotations", []):
        if not ann.get("trigger_match"):
            continue
        ann_id = ann.get("id")
        entry = state_entries.get(ann_id)
        if entry is None:
            continue
        if entry.get("status") != "pending":
            continue
        try:
            validate_status_transition("pending", "surfaced_pending", "surface")
        except ValueError as exc:
            raise IllegalStatusTransitionError(str(exc)) from exc
        entry["status"] = "surfaced_pending"
        promoted.append(ann_id)

    if promoted:
        atomic_write_json(state_path, state)
    return promoted


_CHAT_ROLES: frozenset[str] = frozenset({"user", "claude"})


def set_current_annotation(
    state_dir: Path,
    annotation_id: str,
) -> None:
    """Update state.json.current_annotation_id without any status transition.

    Spec rev-bus: status-neutral navigation. The viewer's Prev/Next buttons
    and the ``set-current`` CLI both land here. We deliberately bypass
    ``validate_status_transition`` — moving the cursor is not an action on
    the targeted annotation; it merely changes which annotation the viewer
    is focused on.

    Raises:
        AnnotationNotFoundError: ``annotation_id`` not present in
            state.annotations.
        SourcePdfChangedApplyError / LegacyStateApplyError: source PDF guard
            (spec §14 risk 9). Mirrors every other writer in this module so
            stale state can't silently advance the cursor.
    """
    state_dir = Path(state_dir)
    _guard_source_pdf(state_dir)
    state_path = state_dir / "state.json"
    if not state_path.exists():
        raise FileMutationError(f"state.json not found at {state_path}")
    state = _read_json(state_path)
    if annotation_id not in state.get("annotations", {}):
        raise AnnotationNotFoundError(annotation_id)
    state["current_annotation_id"] = annotation_id
    atomic_write_json(state_path, state)


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
