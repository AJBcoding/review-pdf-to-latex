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
