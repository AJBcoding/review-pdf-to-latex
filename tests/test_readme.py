"""README structural tests (Task 15.1)."""

import re
from pathlib import Path

import pytest

README = Path(__file__).resolve().parent.parent / "README.md"


@pytest.fixture
def readme_text() -> str:
    if not README.exists():
        pytest.fail(f"README.md missing at {README}")
    return README.read_text(encoding="utf-8")


def test_readme_h1_present(readme_text: str) -> None:
    assert readme_text.startswith("# review-pdf-to-latex"), "missing H1 title line"


def test_readme_required_h2_sections_in_order(readme_text: str) -> None:
    expected = [
        "## What this is",
        "## When you want this",
        "## Install",
        "## Quickstart",
        "## CLI reference",
        "## Architecture",
        "## Status",
        "## License",
    ]
    positions = []
    for heading in expected:
        idx = readme_text.find("\n" + heading + "\n")
        assert idx != -1, f"missing H2 section: {heading}"
        positions.append((heading, idx))
    # Verify order
    for (a, ai), (b, bi) in zip(positions, positions[1:]):
        assert ai < bi, f"section order wrong: {a!r} appears after {b!r}"


def test_readme_install_block_has_pip_install(readme_text: str) -> None:
    # The Install section must contain a pip install command in a code fence.
    install_idx = readme_text.find("## Install")
    next_h2 = readme_text.find("\n## ", install_idx + 1)
    install_block = readme_text[install_idx:next_h2 if next_h2 != -1 else None]
    assert "pip install -e" in install_block
    assert ".claude/skills/review-pdf-to-latex" in install_block


def test_readme_cli_reference_mentions_all_14_subcommands(readme_text: str) -> None:
    cli_idx = readme_text.find("## CLI reference")
    next_h2 = readme_text.find("\n## ", cli_idx + 1)
    cli_block = readme_text[cli_idx:next_h2 if next_h2 != -1 else None]
    for sub in (
        "extract", "serve", "apply", "revert", "preview", "build", "status",
        "override-mapping", "set-status", "append-chat", "record-proposal",
        "commit-phase", "wait-event", "migrate-state",
    ):
        # Subcommand name as standalone word or in `review-pdf <sub>`:
        pattern = re.compile(r"\b" + re.escape(sub) + r"\b")
        assert pattern.search(cli_block), f"CLI reference missing subcommand: {sub}"
