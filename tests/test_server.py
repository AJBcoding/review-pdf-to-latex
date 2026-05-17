"""Tests for review_pdf_to_latex.server."""

from __future__ import annotations

import importlib

import pytest


def test_server_module_importable() -> None:
    """server.py must be importable and expose the public symbols used by cli.py."""
    mod = importlib.import_module("review_pdf_to_latex.server")
    assert hasattr(mod, "ReviewHandler"), "ReviewHandler class must be exposed"
    assert hasattr(mod, "wait_for_events"), "wait_for_events function must be exposed"
    assert hasattr(mod, "build_server"), "build_server factory must be exposed"
    assert hasattr(mod, "EVENTS_FILENAME"), "EVENTS_FILENAME constant must be exposed"
    assert mod.EVENTS_FILENAME == "state-events.jsonl"
