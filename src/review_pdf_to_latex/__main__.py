"""Entry point for ``python -m review_pdf_to_latex``.

Lets the CLI be invoked without relying on the installed console script.
The console script (`review-pdf`) is configured in pyproject.toml and points
to the same ``main`` callable.
"""

from __future__ import annotations

import sys

from review_pdf_to_latex.cli import main

if __name__ == "__main__":
    rc = main()
    sys.exit(int(rc) if rc is not None else 0)
