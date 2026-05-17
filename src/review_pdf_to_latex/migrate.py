"""State-file migration stub (spec §8 ``migrate-state``).

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
