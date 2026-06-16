"""State-file migration (spec §8 ``migrate-state``).

The first real migration is ``(1, 2)`` (rev-l2, spec D7 §7): it adds the
``annotations.json`` round-trip fields and renames ``mapping.json``'s
``latex_file`` key to ``file``. Migrations register in
:data:`_MIGRATION_REGISTRY` keyed by ``(from_version, to_version)`` tuples;
the registered callable must:

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

Design decision — no ``assert_source_pdf_unchanged`` guard here:
    Other mutators (apply / revert / preview / set-status / etc.) refuse to
    run if the source PDF's MD5 no longer matches the recorded
    ``annotations.json.source_pdf_md5`` (exit code 21) or if
    ``annotations.json`` predates that field (exit code 22).
    ``migrate-state`` deliberately does NOT call that guard: migration
    operates on the on-disk state files only, and the source PDF may have
    legitimately moved, been renamed, or been deleted between the original
    ``extract`` and the migration run. Blocking migration on a missing or
    changed PDF would strand the user on an old schema with no recourse.
    Future implementers (both module callables registered in
    :data:`_MIGRATION_REGISTRY` and the CLI handler) must not add
    ``assert_source_pdf_unchanged`` here by reflex.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Callable

from review_pdf_to_latex import state as _state


class UnsupportedMigrationError(Exception):
    """Raised when no migration path is defined for ``(from, to)``.

    CLI handler maps this to exit code 14 (``EXIT_UNSUPPORTED_MIGRATION``).
    """


def _read_raw(path: Path) -> dict[str, Any] | None:
    """Read a state file's raw JSON, bypassing the schema-version guard.

    Migrations must read files whose ``schema_version`` is older than
    ``SUPPORTED_SCHEMA``; :func:`state.read_json` deliberately refuses those
    (``MigrationRequiredError``). So a migration reads the bytes directly.
    Returns ``None`` if the file is absent — a project may legitimately lack
    one of the three state files (e.g. an extract that produced no mappings),
    and migration just skips what is not there.
    """
    if not path.exists():
        return None
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def _migrate_v1_to_v2(state_dir: _state.StateDir) -> None:
    """Migrate ``.review-state/`` from schema_version 1 to 2 (rev-l2, spec D7).

    Changes, by file:

    - ``annotations.json``: each annotation gains ``subtype``/``native_id``/
      ``in_reply_to`` (set to ``None`` — the round-trip data was never captured
      pre-v2 and the source PDF may be gone, so it cannot be recovered here).
    - ``mapping.json``: each mapping's ``latex_file`` key is renamed to
      ``file``.
    - ``state.json``: no field changes; only the version bump (the new
      ``last_status_reason`` field is optional and absent-is-valid).

    Per the module contract, each file's ``schema_version`` is bumped to 2 as
    the **final** mutation on that file, so a crash mid-migration leaves any
    not-yet-rewritten file still at v1 (tripping the needs-migration check on
    the next read). The migration is **idempotent**: a file already at v2 is
    left untouched, so re-running after a partial crash completes cleanly.
    """
    ann = _read_raw(state_dir.annotations_path)
    if ann is not None and ann.get("schema_version") == 1:
        for entry in ann.get("annotations", []):
            entry.setdefault("subtype", None)
            entry.setdefault("native_id", None)
            entry.setdefault("in_reply_to", None)
        ann["schema_version"] = 2
        _state.atomic_write_json(state_dir.annotations_path, ann)

    mapping = _read_raw(state_dir.mapping_path)
    if mapping is not None and mapping.get("schema_version") == 1:
        for entry in mapping.get("mappings", {}).values():
            if "latex_file" in entry:
                entry["file"] = entry.pop("latex_file")
        mapping["schema_version"] = 2
        _state.atomic_write_json(state_dir.mapping_path, mapping)

    state = _read_raw(state_dir.state_path)
    if state is not None and state.get("schema_version") == 1:
        state["schema_version"] = 2
        _state.atomic_write_json(state_dir.state_path, state)


# Future migrations register here. The key is ``(from_version, to_version)``;
# the value is a callable ``(StateDir) -> None`` that performs the migration
# atomically.
_MIGRATION_REGISTRY: dict[tuple[int, int], Callable[[_state.StateDir], None]] = {
    (1, 2): _migrate_v1_to_v2,
}


def migrate(state_dir: _state.StateDir, from_version: int, to_version: int) -> None:
    """Migrate state files from ``from_version`` to ``to_version``.

    Looks up ``(from_version, to_version)`` in :data:`_MIGRATION_REGISTRY` and
    runs the registered callable. ``(1, 2)`` is defined (rev-l2); any other
    pair raises :class:`UnsupportedMigrationError`.

    Note: this function does **not** call
    :func:`review_pdf_to_latex.state.assert_source_pdf_unchanged`. Migration
    runs against state files; the source PDF may legitimately be gone. See
    the module docstring for rationale.

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
