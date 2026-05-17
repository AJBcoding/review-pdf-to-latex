# SuperDoc Fit Analysis

**Date:** 2026-05-16
**Question:** Can the review-pdf-to-latex sidecar viewer be built on top of [SuperDoc](https://github.com/Harbour-Enterprises/SuperDoc)?
**Verdict:** **No.** Wrong fit at the file-format level.

---

## Why we asked

During brainstorming, the user surfaced SuperDoc as a possible foundation:
> "can you take a look at how superdoc works/is setup? is this something we could build on top of?"

SuperDoc had previously appeared in a market survey of OSS document-review tooling as one of the more credible substrates (alongside Plate, BlockNote). It is dual-licensed AGPLv3 + commercial — acceptable for our personal-use scope.

## What SuperDoc actually is

- **File format:** DOCX only (built on OOXML standards, not a contenteditable wrapper).
- **Core engine:** ProseMirror + Yjs + JSZip + Vite.
- **Integration shape:** JavaScript library (React component, Vue, vanilla JS). Framework-agnostic. Can run entirely in the browser with no backend.
- **Features:** Comments, tracked changes, real-time collaboration via Yjs CRDT, headless Node.js mode for automation, an MCP server for AI agents to read/edit DOCX directly.
- **Recent additions (Mar 2026):** "Four ways to read and edit `.docx` files from browser, backend, terminal, or AI agents."

Sources:
- [SuperDoc GitHub](https://github.com/Harbour-Enterprises/SuperDoc)
- [SuperDoc website](https://www.superdoc.dev/)
- [npm package](https://www.npmjs.com/package/@harbour-enterprises/superdoc)
- [Document Engine changelog (2026-03-22)](https://www.superdoc.dev/changelog/2026-03-22-document-engine)

## Why it doesn't fit our problem

Our problem deals with **two file types neither of which is DOCX**:

| Our file | SuperDoc's relationship to it |
|---|---|
| `.pdf` (annotated source, read-only display) | SuperDoc does not view PDFs. |
| `.tex` (LaTeX source, the actual edit target) | SuperDoc would render LaTeX as literal text, or require a lossy LaTeX→DOCX→LaTeX roundtrip. |

The only path to using SuperDoc would be:
1. Convert LaTeX → DOCX (lossy: math, custom commands, included figures, `\input{}` directives all need bespoke handling).
2. Display DOCX in SuperDoc.
3. User edits DOCX in SuperDoc's track-changes mode.
4. Convert DOCX → LaTeX (also lossy; round-trip fidelity is famously poor).
5. Rebuild PDF.

This fights every reason a project chooses LaTeX in the first place: math typesetting, programmatic generation, version control, deterministic output.

## What we use instead

For the parts of the UI SuperDoc *seemed* to provide:

| Need | Decided approach |
|---|---|
| Display PDF page with highlight | Render PDF pages to PNG via `pdftoppm` (already installed); display as `<img>` with a CSS overlay for the highlight bbox. |
| Show LaTeX snippet | Read-only `<pre>` or `<code>` block (Claude does all editing via Edit tool — no in-browser editor needed). |
| Diff preview (proposed vs. current) | Side-by-side `<pre>` blocks, optionally with `diff2html` for syntax-aware diffs. |
| Live rebuilt PDF preview | `pdftoppm` on the rebuilt PDF + display as PNG; auto-scroll to relevant page. |
| Accept/Reject/Edit/Surface buttons | Plain `<button>` elements with click events captured to a state log. |

Total viewer code expectation: ~200 lines HTML + ~100 lines vanilla JS, zero framework dependencies, single-file deployment.

## Disposition

Closed. Don't revisit unless the source-of-truth format changes from LaTeX to DOCX.
