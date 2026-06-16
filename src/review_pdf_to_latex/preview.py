"""Speculative-compile primitives.

The Preview button on the viewer (spec §10.3) and the ``review-pdf preview``
CLI subcommand (spec §8) both go through this module. The model is:

1. Snapshot the target ``.tex`` file's bytes into memory.
2. Write the speculative new text in place over the annotation's line range.
3. Run :func:`review_pdf_to_latex.build.build` — which appends a fresh
   entry to ``state.json.builds[]`` and emits an artifact under
   ``.review-state/builds/build-NNN/``.
4. Restore the in-memory snapshot to the file.
5. Return the build ID to the caller.

The contract: ``state.json.annotations[id]`` is NEVER mutated by preview.
``state.json.builds[]`` IS mutated — that is the artifact stream the
viewer consumes (spec §10.1).

If restore fails the engine dumps the snapshot to
``.review-state/preview-recovery-<timestamp>.txt`` and raises
:class:`InPlaceRestoreError`. The CLI handler maps that to exit code 17
(``EXIT_RESTORE_FAILED``; spec §8).
"""

from __future__ import annotations

import contextlib
import time
from pathlib import Path
from typing import Iterator

from .exit_codes import (
    EXIT_ANNOTATION_NOT_FOUND,
    EXIT_MAPPING_UNRESOLVED,
    EXIT_RESTORE_FAILED,
    EngineError,
)


class PreviewError(EngineError):
    """Base class for preview.py error conditions.

    Folded into the shared :class:`exit_codes.EngineError` hierarchy (rev-x10)
    so the ``preview`` CLI handler collapses to ``return exc.exit_code`` like
    every other mutator handler, instead of mapping each class by hand.
    """


class InPlaceRestoreError(PreviewError):
    """Raised when :func:`with_in_place_edit` fails to restore the snapshot.

    Carries the path of the target file, the path of the recovery file
    holding the original bytes, and the underlying OS error. The CLI
    handler prints the message (plus recovery instructions) to stderr and
    exits 17 (spec §8).
    """

    exit_code = EXIT_RESTORE_FAILED


def _find_state_dir(target: Path) -> Path:
    """Locate the ``.review-state/`` directory for ``target``.

    Walks up from ``target.parent`` until it finds a ``.review-state/``
    subdir, or falls back to ``target.parent/.review-state`` if none is
    found. The fallback path is created on demand so the recovery file
    has somewhere to land even in pathological cases (the user can find
    it next to the target file).
    """
    for ancestor in [target.parent, *target.parent.parents]:
        candidate = ancestor / ".review-state"
        if candidate.is_dir():
            return candidate
    fallback = target.parent / ".review-state"
    fallback.mkdir(parents=True, exist_ok=True)
    return fallback


def _replace_lines(text: str, line_range: tuple[int, int], new_text: str) -> str:
    """Replace ``line_range`` (1-indexed, inclusive) in ``text`` with ``new_text``.

    The line range must fall within the file's existing line count; otherwise
    :class:`ValueError` is raised. ``new_text`` is inserted verbatim — the
    caller is responsible for trailing newlines.
    """
    start, end = line_range
    if start < 1 or end < start:
        raise ValueError(
            f"invalid line range {line_range!r}: start must be >= 1 and end >= start"
        )
    lines = text.splitlines(keepends=True)
    if end > len(lines):
        raise ValueError(
            f"line range {line_range!r} exceeds file length ({len(lines)} lines)"
        )
    before = "".join(lines[: start - 1])
    after = "".join(lines[end:])
    return before + new_text + after


@contextlib.contextmanager
def with_in_place_edit(
    latex_file: Path,
    line_range: tuple[int, int],
    new_text: str,
) -> Iterator[None]:
    """Context manager that mutates ``latex_file`` in place, then restores it.

    Parameters
    ----------
    latex_file:
        Absolute or project-relative path to the ``.tex`` file.
    line_range:
        Inclusive 1-indexed ``(start, end)`` line range to replace.
    new_text:
        Replacement text (caller-supplied newlines).

    Yields
    ------
    None
        The ``with`` block runs with the file containing the new text.

    Raises
    ------
    ValueError
        ``line_range`` is invalid (start < 1, end < start, or end > line
        count). The file is not mutated.
    InPlaceRestoreError
        Restoration of the original bytes failed. The original contents
        have been written to ``.review-state/preview-recovery-<ts>.txt``;
        the path is in the exception message.

    Side effects
    ------------
    On success: the file is byte-identical to its pre-call contents.
    On exception inside the ``with`` block: the file is still restored,
    then the exception is re-raised.
    On restore failure: a recovery file appears under ``.review-state/``.
    """
    latex_file = Path(latex_file)
    original_bytes = latex_file.read_bytes()
    original_text = original_bytes.decode("utf-8")
    new_contents = _replace_lines(original_text, line_range, new_text)

    # Apply the speculative mutation.
    latex_file.write_text(new_contents, encoding="utf-8")

    try:
        yield
    finally:
        try:
            latex_file.write_text(original_text, encoding="utf-8")
        except OSError as restore_err:
            state_dir = _find_state_dir(latex_file)
            ts = time.strftime("%Y%m%dT%H%M%S")
            recovery_path = state_dir / f"preview-recovery-{ts}.txt"
            # Best-effort recovery dump. If this also fails, surface both
            # errors in the chained exception.
            try:
                recovery_path.write_text(original_text, encoding="utf-8")
            except OSError as dump_err:
                raise InPlaceRestoreError(
                    f"failed to restore {latex_file} after preview "
                    f"(restore error: {restore_err}); also failed to write "
                    f"recovery file {recovery_path} ({dump_err}); "
                    f"the original contents are LOST — recover from git or backup"
                ) from restore_err
            raise InPlaceRestoreError(
                f"failed to restore {latex_file} after preview "
                f"(error: {restore_err}); the original contents have been "
                f"saved to {recovery_path} — copy them back manually"
            ) from restore_err


from review_pdf_to_latex import state as _state


class AnnotationNotFoundError(PreviewError):
    """Raised when ``preview()`` is asked about an unknown annotation ID.

    CLI handler maps this to exit code 7 (``EXIT_ANNOTATION_NOT_FOUND``).
    """

    exit_code = EXIT_ANNOTATION_NOT_FOUND


class MappingUnresolvedError(PreviewError):
    """Raised when an annotation's mapping has no ``latex_file`` or ``line_range``.

    CLI handler maps this to exit code 8 (``EXIT_MAPPING_UNRESOLVED``).
    """

    exit_code = EXIT_MAPPING_UNRESOLVED


def _invoke_build(state_dir: _state.StateDir, **kwargs):  # type: ignore[no-untyped-def]
    """Indirection seam so tests can stub the LaTeX compile out.

    The real implementation is :func:`review_pdf_to_latex.build.run_build_command`
    (chunk C). We import it lazily so this module does not fail to load
    if the build module is still being scaffolded.

    Returns the build ID assigned to the speculative build. The build
    module appends an entry to ``state.json.builds[]`` as a side effect.
    """
    from review_pdf_to_latex import build as build_mod

    # Read state to discover the build ID that the build module will assign
    # next, then drive run_build_command.
    state = _state.read_json(state_dir.state_path)
    build_id = build_mod.next_build_id(state)
    build_mod.run_build_command(
        state_dir.project_root,
        main_file=kwargs.get("main_file"),
        engine=kwargs.get("engine", "auto"),
        quiet=kwargs.get("quiet", True),
        benchmark=kwargs.get("benchmark", False),
    )
    return build_id


def preview(
    state_dir: _state.StateDir,
    annotation_id: str,
    new_text: str,
) -> str:
    """Run a speculative compile for ``annotation_id`` with ``new_text``.

    Reads ``mapping.json`` to find the annotation's ``latex_file`` and
    ``line_range``. Snapshots the file, writes the new text in place,
    invokes :func:`_invoke_build`, and restores the file. Returns the
    build ID of the speculative build.

    Side effects:
    - ``state.json.builds[]`` gains one entry (via the build module).
    - ``state.json.annotations[annotation_id]`` is UNCHANGED.
    - ``.review-state/builds/build-NNN/`` is created (the viewer reads it).

    Raises
    ------
    AnnotationNotFoundError
        ``annotation_id`` is not present in ``mapping.json``.
    MappingUnresolvedError
        The annotation's mapping has no ``latex_file`` or ``line_range``.
    InPlaceRestoreError
        Restore of the snapshot failed (recovery file path is in message).
    _state.SourcePdfChangedError, _state.LegacyStateError
        Source PDF guard refused the operation (spec §14 risk 9).
    """
    # Spec §14 risk 9: refuse to compile against potentially stale annotation
    # coordinates if the source PDF has changed since extract.
    _state.assert_source_pdf_unchanged(state_dir)
    mapping_doc = _state.read_json(state_dir.mapping_path)
    mappings = mapping_doc.get("mappings", {})
    if annotation_id not in mappings:
        raise AnnotationNotFoundError(
            f"annotation {annotation_id!r} not present in mapping.json"
        )
    m = mappings[annotation_id]
    latex_file_rel = m.get("file")
    line_range = m.get("line_range")
    if latex_file_rel is None or line_range is None:
        raise MappingUnresolvedError(
            f"annotation {annotation_id!r} has unresolved mapping "
            f"(latex_file={latex_file_rel!r}, line_range={line_range!r}); "
            f"run `review-pdf override-mapping` first"
        )

    latex_path = state_dir.project_root / latex_file_rel
    lr = (int(line_range[0]), int(line_range[1]))

    with with_in_place_edit(latex_path, lr, new_text):
        build_id = _invoke_build(state_dir)

    return build_id
