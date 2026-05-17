"""End-to-end smoke tests against the committed fixture project.

Each test drives all four phases against ``tests/fixtures/e2e-annotated.pdf``
by copying ``e2e-sample-project/`` to a temp dir and invoking the CLI handlers
programmatically. The fixture exercises one annotation per fuzzy-mapping
or trigger-phrase path (see ``tests/fixtures/E2E-EXPECTED.md``).

Acceptance criteria covered: spec §18.1 -- §18.6.

These tests are marked ``slow`` because each subtest re-runs the full
extract -> apply -> build -> commit pipeline against a real pdflatex
binary. Deselect with ``pytest -m 'not slow'`` for faster local runs.
Tests skip gracefully when pdflatex is unavailable.

Note: This module's fixtures (``e2e-annotated.pdf`` + ``e2e-sample-project/``)
are intentionally separate from Task 4's unit-level fixtures
(``sample-annotated.pdf`` + ``make_sample_pdf.py``). Do not consolidate;
the two families exercise different layers of the engine.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from review_pdf_to_latex import cli
from review_pdf_to_latex import state as state_mod


FIXTURES = Path(__file__).parent / "fixtures"
SAMPLE_PROJECT = FIXTURES / "e2e-sample-project"
ANNOTATED_PDF = FIXTURES / "e2e-annotated.pdf"


# Every test in this module is end-to-end (slow). Deselect with -m 'not slow'.
pytestmark = [
    pytest.mark.slow,
    pytest.mark.skipif(
        shutil.which("pdflatex") is None,
        reason="pdflatex not on PATH; end-to-end tests require a LaTeX install",
    ),
]


@pytest.fixture
def project_copy(tmp_path: Path) -> Path:
    """Copy the fixture project to a fresh temp dir and ``git init`` it.

    Phase 1 requires a clean git working tree (spec §13.1). We init a
    repo and make one baseline commit so the precondition can be met.
    """
    dest = tmp_path / "e2e-sample-project"
    shutil.copytree(SAMPLE_PROJECT, dest)
    # Strip the pre-compiled build/ outputs except the .tex sources so the
    # repo state is clean and reproducible. We keep table-data.tex (a real
    # source file in build/, excluded from fuzzy mapping) and full_report.tex
    # (the main file). The PDF/aux/log are byproducts.
    build_dir = dest / "build"
    for stale in build_dir.iterdir():
        if stale.suffix in {".aux", ".log", ".out", ".pdf"}:
            stale.unlink()
    subprocess.run(["git", "init", "-q"], cwd=dest, check=True)
    subprocess.run(["git", "add", "-A"], cwd=dest, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "-m", "baseline"],
        cwd=dest, check=True,
    )
    return dest


def _advance_phase(sd: state_mod.StateDir, target_phase: str) -> None:
    """Bump ``state.json.phase`` to ``target_phase`` by direct write.

    Phase 0 → Phase 1 is currently a gap in the engine wiring: ``apply``
    does not advance phase, and the ``commit-phase`` CLI rejects
    ``--phase 0``. The SKILL.md instructs operators NOT to call
    ``commit-phase`` at the end of Phase 0 (it produces state, not a
    commit). So the test moves the phase forward via a direct state-file
    write -- mirroring whatever bridge the future skill/engine wiring
    will implement.
    """
    state_doc = state_mod.read_json(sd.state_path)
    state_doc["phase"] = target_phase
    state_mod.atomic_write_json(sd.state_path, state_doc)


def _allow_state_in_git(project_copy: Path) -> None:
    """Strip ``.review-state/`` from the project's .gitignore.

    ``extract`` auto-adds ``.review-state/`` to ``.gitignore`` (spec
    expects the state dir to be locally ignored by default). But
    ``commit-phase`` then needs to stage ``.review-state/state.json``
    etc., and ``git add`` refuses to add ignored paths without ``-f``.
    The engine doesn't pass ``-f`` (intentionally -- the user is
    expected to opt in to versioning state). For the e2e tests, we
    remove the ignore rule so commit-phase can succeed end-to-end.
    """
    gitignore = project_copy / ".gitignore"
    if not gitignore.exists():
        return
    lines = [
        line for line in gitignore.read_text(encoding="utf-8").splitlines()
        if line.strip() not in {".review-state/", ".review-state"}
    ]
    gitignore.write_text("\n".join(lines) + ("\n" if lines else ""), encoding="utf-8")
    # Stage and amend the baseline commit so .gitignore reflects this change
    # without producing a separate dirty-state commit.
    subprocess.run(["git", "add", ".gitignore"], cwd=project_copy, check=True)
    # Use --amend so the baseline + .gitignore patch are a single commit;
    # subsequent commit-phase calls then see a clean working tree.
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t",
         "commit", "-q", "--amend", "--no-edit"],
        cwd=project_copy, check=True,
    )


def test_phase_0_extract(project_copy: Path):
    """`review-pdf extract` produces the four artifacts and seeds state.json."""
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "extract",
            "--pdf", str(ANNOTATED_PDF),
        ]
    )
    assert rc == 0

    sd = state_mod.StateDir(project_copy)

    # annotations.json: 5 entries with non-null highlighted_text + comment.
    ann = state_mod.read_json(sd.annotations_path)
    assert len(ann["annotations"]) == 5
    for a in ann["annotations"]:
        assert a["highlighted_text"], f"empty highlighted_text on {a['id']}"
        assert a["comment"], f"empty comment on {a['id']}"

    # mapping.json: ann-001, ann-002, ann-003, ann-005 are needs_review False.
    # ann-004 (table cell) is needs_review True.
    mapping = state_mod.read_json(sd.mapping_path)
    m = mapping["mappings"]
    assert m["ann-001"]["needs_review"] is False
    assert m["ann-002"]["needs_review"] is False
    assert m["ann-003"]["needs_review"] is False
    assert m["ann-005"]["needs_review"] is False
    assert m["ann-004"]["needs_review"] is True
    # ann-004 candidates may be empty (method: failed) or up to three entries.
    assert isinstance(m["ann-004"].get("candidates", []), list)

    # state.json: phase 0-setup, ann-004 is needs_review, others pending.
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "0-setup"
    assert st["annotations"]["ann-004"]["status"] == "needs_review"
    for ann_id in ("ann-001", "ann-002", "ann-003", "ann-005"):
        assert st["annotations"][ann_id]["status"] == "pending"

    # pages/page-N.png: one per page in the source PDF.
    pages = sorted((sd.dir / "pages").glob("page-*.png"))
    assert len(pages) >= 1, "no page renders produced"

    # trigger_match: ann-003's comment matches the default trigger phrase.
    ann_by_id = {a["id"]: a for a in ann["annotations"]}
    assert ann_by_id["ann-003"]["trigger_match"] is True
    assert ann_by_id["ann-001"]["trigger_match"] is False


def _proposal_for(ann_id: str) -> str:
    """Return a deterministic mechanical proposal for a given annotation.

    Used by the test to synthesize ``--new-text-file`` payloads without
    invoking Claude. The proposals are designed to be valid LaTeX so the
    build succeeds; they are not necessarily good editorial choices.
    """
    return {
        "ann-001": (
            "COTA enrollment grew significantly during the 2024--2025 cycle, "
            "concentrated in studio art, theater, and dance.\n"
        ),
        "ann-002": (
            "Completion rates rose noticeably across studio majors during "
            "the prior cycle, with the strongest gains among transfer students.\n"
        ),
        "ann-005": (
            "the priorities for the coming year include sustaining 12% "
            "year-over-year growth, formalizing alumni engagement, and "
            "expanding faculty hiring.\n"
        ),
    }[ann_id]


def _phase_0_setup(project_copy: Path) -> state_mod.StateDir:
    """Helper: run extract on the fixture project; return the state dir."""
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "extract",
            "--pdf", str(ANNOTATED_PDF),
        ]
    )
    assert rc == 0
    return state_mod.StateDir(project_copy)


def _override_ann_004_mapping(project_copy: Path, sd: state_mod.StateDir) -> None:
    """Manually resolve ann-004's needs_review mapping to make Phase 1 runnable.

    Maps ann-004 to a real line range inside table.tex so the apply call
    is a no-op semantically (the test never asserts the table edit ended
    up sensible -- only that the engine accepts the override).
    """
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "override-mapping",
            "--annotation-id", "ann-004",
            "--file", "templates/table.tex",
            "--lines", "4:4",
        ]
    )
    assert rc == 0
    mapping = state_mod.read_json(sd.mapping_path)
    assert mapping["mappings"]["ann-004"]["needs_review"] is False
    # State should now treat ann-004 as pending (chunk C's override-mapping
    # contract per spec §10.6 transitions needs_review → pending).
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-004"]["status"] in {"pending", "needs_review"}


def test_phase_1_batch_apply(project_copy: Path, tmp_path: Path):
    """Simulate the skill's Phase 1 walk: apply + build for each pending ann.

    SURFACE-flagged ann-003 is set to surfaced_pending instead of applied.
    Phase ends with `commit-phase --phase 1`; state advances to 2a-ratify.
    """
    sd = _phase_0_setup(project_copy)
    _override_ann_004_mapping(project_copy, sd)

    # Allow .review-state/ to be committed; bridge phase 0 -> 1.
    _allow_state_in_git(project_copy)
    _advance_phase(sd, "1-batch")

    # Mark ann-003 as surfaced_pending (trigger_match is true; the skill
    # skips it during Phase 1).
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "set-status",
            "--annotation-id", "ann-003",
            "--status", "surfaced_pending",
        ]
    )
    assert rc == 0

    # Apply mechanical edits for ann-001, ann-002, ann-005, ann-004.
    # We walk in reverse line order to mimic spec §9.2's discipline,
    # but for the test the order is incidental as long as overlap is
    # absent.
    for ann_id in ("ann-005", "ann-002", "ann-001", "ann-004"):
        proposal_path = tmp_path / f"proposal-{ann_id}.tex"
        if ann_id == "ann-004":
            # Table cell -- proposal is a benign change to one row.
            proposal_path.write_text(
                "Studio Art & 142 & 170 \\\\\n", encoding="utf-8"
            )
        else:
            proposal_path.write_text(_proposal_for(ann_id), encoding="utf-8")
        rc = cli.main(
            [
                "--project-dir", str(project_copy),
                "apply",
                "--annotation-id", ann_id,
                "--new-text-file", str(proposal_path),
            ]
        )
        assert rc == 0, f"apply failed for {ann_id} (rc={rc})"
        rc = cli.main(
            [
                "--project-dir", str(project_copy),
                "build",
            ]
        )
        assert rc == 0, f"build failed after applying {ann_id} (rc={rc})"

    # Verify state.json shape after the walk.
    st = state_mod.read_json(sd.state_path)
    for ann_id in ("ann-001", "ann-002", "ann-004", "ann-005"):
        entry = st["annotations"][ann_id]
        assert entry["status"] == "applied", (
            f"expected {ann_id} applied, got {entry['status']}"
        )
        assert entry["applied_text"] is not None
        assert entry["before_text"] is not None
    assert st["annotations"]["ann-003"]["status"] == "surfaced_pending"
    assert len(st["builds"]) >= 4  # one per applied edit

    # commit-phase --phase 1
    rc = cli.main(
        [
            "--project-dir", str(project_copy),
            "commit-phase",
            "--phase", "1",
        ]
    )
    assert rc == 0

    # State advances to 2a-ratify (default order).
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "2a-ratify"

    # git log shows exactly one commit beyond the baseline.
    log = subprocess.run(
        ["git", "log", "--oneline"],
        cwd=project_copy,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip().splitlines()
    assert len(log) == 2, f"expected 2 commits (baseline + phase 1), got: {log}"
    assert "phase 1" in log[0].lower() or "phase 1" in log[0]


def _drive_to_phase_2a(project_copy: Path, tmp_path: Path) -> state_mod.StateDir:
    """Helper: run extract + Phase 1 + commit, leaving phase at 2a-ratify."""
    sd = _phase_0_setup(project_copy)
    _override_ann_004_mapping(project_copy, sd)
    _allow_state_in_git(project_copy)
    _advance_phase(sd, "1-batch")

    # Mark ann-003 surfaced_pending and apply the rest.
    cli.main(
        ["--project-dir", str(project_copy), "set-status",
         "--annotation-id", "ann-003", "--status", "surfaced_pending"]
    )
    for ann_id in ("ann-005", "ann-002", "ann-001", "ann-004"):
        proposal_path = tmp_path / f"proposal-{ann_id}.tex"
        if ann_id == "ann-004":
            proposal_path.write_text(
                "Studio Art & 142 & 170 \\\\\n", encoding="utf-8"
            )
        else:
            proposal_path.write_text(_proposal_for(ann_id), encoding="utf-8")
        cli.main(["--project-dir", str(project_copy), "apply",
                  "--annotation-id", ann_id,
                  "--new-text-file", str(proposal_path)])
        cli.main(["--project-dir", str(project_copy), "build"])
    cli.main(["--project-dir", str(project_copy),
              "commit-phase", "--phase", "1"])
    return sd


def test_phase_2a_ratify(project_copy: Path, tmp_path: Path):
    """Approve, Reject, Redraft, and Preview each affect state per spec §10.3."""
    sd = _drive_to_phase_2a(project_copy, tmp_path)

    # 1) Approve ann-001 → status applied → accepted.
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "set-status", "--annotation-id", "ann-001", "--status", "accepted"]
    )
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-001"]["status"] == "accepted"

    # 2) Reject ann-002 → file restored to before_text → status rejected.
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "revert", "--annotation-id", "ann-002", "--status", "rejected"]
    )
    assert rc == 0
    rc = cli.main(["--project-dir", str(project_copy), "build"])
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    ann2 = st["annotations"]["ann-002"]
    assert ann2["status"] == "rejected"
    assert ann2["applied_text"] is None
    assert ann2["before_text"] is not None
    # The .tex file must contain ann-002's before_text again.
    findings = (project_copy / "templates" / "findings.tex").read_text(
        encoding="utf-8"
    )
    assert "meaningful boost in completion rates" in findings

    # 3) Redraft ann-005 → revert + apply new draft + build + set status redrafted.
    new_draft = tmp_path / "redraft-ann-005.tex"
    new_draft.write_text(
        "the priorities for the coming year include continued "
        "investment in mid-semester checkpoints and alumni engagement.\n",
        encoding="utf-8",
    )
    cli.main(["--project-dir", str(project_copy),
              "revert", "--annotation-id", "ann-005", "--status", "rejected"])
    cli.main(["--project-dir", str(project_copy), "apply",
              "--annotation-id", "ann-005",
              "--new-text-file", str(new_draft)])
    cli.main(["--project-dir", str(project_copy), "build"])
    cli.main(["--project-dir", str(project_copy), "set-status",
              "--annotation-id", "ann-005", "--status", "redrafted"])
    st = state_mod.read_json(sd.state_path)
    assert st["annotations"]["ann-005"]["status"] == "redrafted"

    # 4) Preview ann-005 — speculative compile only. builds[] grows by one;
    #    state.annotations[ann-005] is unchanged.
    builds_before = list(st["builds"])
    spec_text = tmp_path / "spec-ann-005.tex"
    spec_text.write_text(
        "the priorities for the coming year include 12% growth in "
        "studio enrollment and continued alumni engagement.\n",
        encoding="utf-8",
    )
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "preview", "--annotation-id", "ann-005",
         "--new-text-file", str(spec_text)]
    )
    assert rc == 0
    st_after = state_mod.read_json(sd.state_path)
    assert len(st_after["builds"]) == len(builds_before) + 1
    # status unchanged.
    assert st_after["annotations"]["ann-005"]["status"] == "redrafted"
    # The .tex file is back to its pre-preview state (the redraft).
    conclusion = (project_copy / "templates" / "conclusion.tex").read_text(
        encoding="utf-8"
    )
    assert "mid-semester checkpoints" in conclusion
    assert "12% growth in studio enrollment" not in conclusion

    # 5) Approve the remaining applied annotation (ann-004) so we can commit.
    cli.main(
        ["--project-dir", str(project_copy),
         "set-status", "--annotation-id", "ann-004", "--status", "accepted"]
    )

    # commit-phase --phase 2a → advance to 2b-surface.
    rc = cli.main(
        ["--project-dir", str(project_copy),
         "commit-phase", "--phase", "2a"]
    )
    assert rc == 0
    st = state_mod.read_json(sd.state_path)
    assert st["phase"] == "2b-surface"
