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
