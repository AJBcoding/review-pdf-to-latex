#!/usr/bin/env bash
# Regenerate the committed e2e fixtures.
#
# Run this after changing make_e2e_fixtures.py or the LaTeX source under
# e2e-sample-project/. Commit the regenerated PDFs and hash file.

set -euo pipefail

cd "$(dirname "$0")"

if ! command -v pdflatex >/dev/null 2>&1; then
    echo "pdflatex not found on PATH. Install TeX Live first." >&2
    exit 1
fi

python make_e2e_fixtures.py
echo ""
echo "Regenerated fixtures. Diff and commit:"
echo "  git diff -- tests/fixtures/"
