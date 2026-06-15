"""Single source of truth for the engine's process exit codes (spec §8).

Before this module existed the spec-§8 contract was spelled out in *four*
notations that could drift independently:

  (a) named ``EXIT_*`` constants in ``cli.py`` (pinned by
      ``tests/test_cli.py::test_exit_code_constants_match_spec``),
  (b) hardcoded ``exit_code`` class attributes on the ``ApplyError`` /
      ``CommitError`` hierarchies (``apply.py`` / ``commit.py``),
  (c) bare magic-number ``return`` statements (``extract.py`` / ``server.py``),
  (d) ``EXIT_ENCRYPTED = 21`` in ``pdf_health.py`` — the same number ``cli.py``
      assigns to ``EXIT_SOURCE_PDF_CHANGED``.

Now there is one definition. ``cli``, ``apply``, ``commit``, ``extract``,
``server`` and ``pdf_health`` all import the constants from here, and the
error hierarchies carry these constants as their ``exit_code`` so every CLI
handler collapses to ``return exc.exit_code``. The desktop app mirrors the
same numbers in ``desktop/shared/exit-codes.ts``; a vitest contract test reads
*this* file and fails if the TS twin drifts.

The contract is consumed by the skill and by the Electron app. **Do NOT
renumber** — both the Python pinning test and the TS contract test assert
every value verbatim.

The ``21`` overload (deliberate, not a bug)
------------------------------------------
``pdf-health`` reuses code ``21`` for the *encrypted-PDF* case
(:data:`EXIT_ENCRYPTED`), the same number the mutator family
(``apply`` / ``revert`` / ``preview`` / ``commit-phase`` / ...) uses for
*source-PDF-changed* (:data:`EXIT_SOURCE_PDF_CHANGED`). Spec §8 documents both
meanings (the ``pdf-health`` row: "21 pdf encrypted"; the mutator rows: "21
source PDF changed"). This is a per-subcommand namespace reuse, not a
collision: ``pdf-health`` never runs the source-PDF guard and the mutators
never walk an encrypted PDF, so no single invocation can mean both. The alias
below makes the shared number explicit rather than coincidental.
"""

from __future__ import annotations

# Generic / fallback. Not in any spec §8 per-command row; it is the base-class
# default and the code ``commit-phase`` returns for an illegal phase argument
# (``IllegalPhaseError``).
EXIT_GENERIC = 1

EXIT_OK = 0
EXIT_MISSING_PDF = 2  # extract: --pdf path absent or unreadable
EXIT_EXISTING_STATE = 3  # extract: .review-state/ exists, no --force
EXIT_PDFANNOTS_FAILED = 4  # extract: pdfannots parse error
EXIT_PORT_UNAVAILABLE = 5  # serve: requested port in use
EXIT_STATE_MISSING = 6  # any: state.json absent when required
EXIT_ANNOTATION_NOT_FOUND = 7  # any per-annotation: id absent
EXIT_MAPPING_UNRESOLVED = 8  # apply/preview: mapping has no latex_file/line_range
EXIT_FILE_MUTATION_FAILED = 9  # apply: .tex write failed
EXIT_NO_PRIOR_APPLY = 10  # revert: no before_text captured
EXIT_BUILD_FAILED = 11  # build/preview: pdflatex non-zero
EXIT_MAIN_FILE_NOT_FOUND = 12  # build: --main-file absent
EXIT_INVALID_LINE_RANGE = 13  # override-mapping: bad START:END
EXIT_UNSUPPORTED_MIGRATION = 14  # migrate-state: no path from N to M
EXIT_DIRTY_GIT_STATE = 15  # commit-phase: git status --porcelain non-empty
EXIT_OVERLAPPING_LINE_RANGE = 16  # apply: conflict with another annotation
EXIT_RESTORE_FAILED = 17  # preview: in-place restore failed (engine emits recovery)
EXIT_ILLEGAL_STATUS_TRANSITION = 18  # set-status: rejected by validate_status_transition
EXIT_COMMIT_FAILED = 19  # commit-phase: hook or staging error
EXIT_WAIT_TIMEOUT = 20  # wait-event: --timeout elapsed before any event
EXIT_SOURCE_PDF_CHANGED = 21  # any mutator: PDF md5 differs from annotations.json.source_pdf_md5
EXIT_LEGACY_STATE = 22  # any mutator: annotations.json predates source_pdf_md5 guard
EXIT_REVIEWER_RIG_REFUSED = 23  # apply/build/revert refused under $GT_RIG=reviewer/* per spec §10.5.2

# pdf-health reuses 21 for the encrypted-PDF case. See the module docstring for
# why this is a deliberate per-subcommand namespace reuse and not a collision.
EXIT_ENCRYPTED = EXIT_SOURCE_PDF_CHANGED  # == 21


class EngineError(Exception):
    """Base for engine errors that map to a process exit code.

    Subclasses set :attr:`exit_code` to one of the ``EXIT_*`` constants above
    so CLI handlers can collapse error handling to ``return exc.exit_code``
    instead of mapping each exception class by hand. ``apply.ApplyError``,
    ``commit.CommitError`` and the ``preview`` error family all derive from
    this single hierarchy.
    """

    exit_code: int = EXIT_GENERIC
