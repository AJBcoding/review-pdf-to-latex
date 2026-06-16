"""Tests for migrate-state (spec §8) — the (1, 2) migration (rev-l2)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from review_pdf_to_latex import migrate
from review_pdf_to_latex import state as state_mod


def _write_v1_state(state_dir: Path) -> None:
    """Write a minimal v1 .review-state/ (annotations + mapping + state)."""
    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "annotations.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source_pdf": "/tmp/x.pdf",
                "source_pdf_md5": "d41d8cd98f00b204e9800998ecf8427e",
                "extracted_at": "2026-05-16T00:00:00Z",
                "extractor": "pdfannots-0.4.1",
                "annotations": [
                    {
                        "id": "ann-001",
                        "page": 1,
                        "bbox": [1.0, 2.0, 3.0, 4.0],
                        "highlighted_text": "x",
                        "author": "anon",
                        "comment": "c",
                        "created": "2026-05-16T00:00:00Z",
                        "trigger_match": False,
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (state_dir / "mapping.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "mappings": {
                    "ann-001": {
                        "latex_file": "main.tex",
                        "line_range": [1, 2],
                        "confidence": 0.9,
                        "method": "fuzzy_text",
                        "needs_review": False,
                        "candidates": [],
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    (state_dir / "state.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "phase": "0-setup",
                "order": "mechanical-first",
                "current_annotation_id": None,
                "annotations": {"ann-001": {"status": "pending"}},
                "builds": [],
            }
        ),
        encoding="utf-8",
    )


def test_registry_has_v1_to_v2(tmp_project):
    """The (1, 2) migration is registered (rev-l2)."""
    assert (1, 2) in migrate._MIGRATION_REGISTRY


def test_migrate_unsupported_pair_raises(tmp_project):
    """A pair with no registered migration still raises UnsupportedMigrationError."""
    sd = state_mod.StateDir(tmp_project)
    with pytest.raises(migrate.UnsupportedMigrationError) as exc_info:
        migrate.migrate(sd, from_version=2, to_version=3)
    msg = str(exc_info.value)
    assert "2" in msg and "3" in msg


def test_migrate_same_version_unsupported(tmp_project):
    """A no-op (1, 1) request is rejected — no-op is the caller's responsibility."""
    sd = state_mod.StateDir(tmp_project)
    with pytest.raises(migrate.UnsupportedMigrationError):
        migrate.migrate(sd, from_version=1, to_version=1)


def test_migrate_v1_to_v2_transforms_all_files(tmp_project):
    """(1, 2) adds annotation round-trip fields, renames latex_file→file, bumps."""
    sd = state_mod.StateDir(tmp_project)
    _write_v1_state(sd.dir)

    migrate.migrate(sd, from_version=1, to_version=2)

    ann = json.loads(sd.annotations_path.read_text(encoding="utf-8"))
    assert ann["schema_version"] == 2
    entry = ann["annotations"][0]
    assert entry["subtype"] is None
    assert entry["native_id"] is None
    assert entry["in_reply_to"] is None

    mapping = json.loads(sd.mapping_path.read_text(encoding="utf-8"))
    assert mapping["schema_version"] == 2
    m = mapping["mappings"]["ann-001"]
    assert "latex_file" not in m
    assert m["file"] == "main.tex"

    state = json.loads(sd.state_path.read_text(encoding="utf-8"))
    assert state["schema_version"] == 2


def test_migrate_v1_to_v2_output_passes_the_read_guard(tmp_project):
    """After migration, the L1-fixed read_json guard accepts the files (no raise)."""
    sd = state_mod.StateDir(tmp_project)
    _write_v1_state(sd.dir)

    # Pre-migration: the guard refuses the v1 files.
    with pytest.raises(state_mod.MigrationRequiredError):
        state_mod.read_json(sd.mapping_path)

    migrate.migrate(sd, from_version=1, to_version=2)

    # Post-migration: every file reads cleanly through the guard.
    for path in (sd.annotations_path, sd.mapping_path, sd.state_path):
        doc = state_mod.read_json(path)
        assert doc["schema_version"] == 2


def test_migrate_v1_to_v2_is_idempotent(tmp_project):
    """Re-running the migration on already-v2 files is a no-op (crash recovery)."""
    sd = state_mod.StateDir(tmp_project)
    _write_v1_state(sd.dir)

    migrate.migrate(sd, from_version=1, to_version=2)
    first = {
        p.name: p.read_text(encoding="utf-8")
        for p in (sd.annotations_path, sd.mapping_path, sd.state_path)
    }

    # Second run must not corrupt or double-transform.
    migrate.migrate(sd, from_version=1, to_version=2)
    second = {
        p.name: p.read_text(encoding="utf-8")
        for p in (sd.annotations_path, sd.mapping_path, sd.state_path)
    }
    assert first == second


def test_migrate_v1_to_v2_skips_absent_files(tmp_project):
    """A project missing one of the three state files migrates the rest cleanly."""
    sd = state_mod.StateDir(tmp_project)
    _write_v1_state(sd.dir)
    sd.mapping_path.unlink()  # drop mapping.json

    migrate.migrate(sd, from_version=1, to_version=2)

    assert not sd.mapping_path.exists()
    assert json.loads(sd.annotations_path.read_text(encoding="utf-8"))["schema_version"] == 2
    assert json.loads(sd.state_path.read_text(encoding="utf-8"))["schema_version"] == 2
