// TypeScript twin of the engine's exit-code contract (spec §8).
//
// The authoritative source is the Python module
// `src/review_pdf_to_latex/exit_codes.py`. This file mirrors it so the desktop
// app can refer to engine exit codes by name instead of as bare magic numbers
// (the old `new Set([0, 2, 21])` in engine.ts). `exit-codes.test.ts` reads the
// Python source and fails if the two ever drift — so keep the two in lockstep
// and never renumber.
//
// The `21` overload is intentional: `pdf-health` reuses 21 for ENCRYPTED, the
// same number the mutator family uses for SOURCE_PDF_CHANGED. See the Python
// module docstring for why this is a per-subcommand namespace reuse, not a
// collision.

export const EXIT = {
  OK: 0,
  GENERIC: 1,
  MISSING_PDF: 2,
  EXISTING_STATE: 3,
  PDFANNOTS_FAILED: 4,
  PORT_UNAVAILABLE: 5,
  STATE_MISSING: 6,
  ANNOTATION_NOT_FOUND: 7,
  MAPPING_UNRESOLVED: 8,
  FILE_MUTATION_FAILED: 9,
  NO_PRIOR_APPLY: 10,
  BUILD_FAILED: 11,
  MAIN_FILE_NOT_FOUND: 12,
  INVALID_LINE_RANGE: 13,
  UNSUPPORTED_MIGRATION: 14,
  DIRTY_GIT_STATE: 15,
  OVERLAPPING_LINE_RANGE: 16,
  RESTORE_FAILED: 17,
  ILLEGAL_STATUS_TRANSITION: 18,
  COMMIT_FAILED: 19,
  WAIT_TIMEOUT: 20,
  SOURCE_PDF_CHANGED: 21,
  LEGACY_STATE: 22,
  REVIEWER_RIG_REFUSED: 23,
} as const;

// pdf-health reuses 21 for the encrypted-PDF case (deliberate; see header).
export const EXIT_ENCRYPTED = EXIT.SOURCE_PDF_CHANGED;

/**
 * Exit codes for which `pdf-health` still emits a parseable JSON report on
 * stdout: ok (0), missing/unreadable (2), and encrypted (21). Callers treat
 * all three as a successful health check because the report itself describes
 * the outcome.
 */
export const PDF_HEALTH_REPORTING_EXITS: ReadonlySet<number> = new Set([
  EXIT.OK,
  EXIT.MISSING_PDF,
  EXIT_ENCRYPTED,
]);
