# Review PDF — Tester Build

Unsigned macOS build, Apple Silicon (arm64) only.

## Install

1. Open `Review PDF-0.0.1-arm64.dmg`.
2. Drag **Review PDF.app** to `/Applications`.
3. First launch: **right-click the app → Open**. Pick "Open" in the dialog. macOS Gatekeeper will warn that the developer is unidentified — this is expected (the build is unsigned).
   - If even right-click-Open fails with "damaged or incomplete," run this once in Terminal:
     ```
     xattr -d com.apple.quarantine /Applications/Review\ PDF.app
     ```
     Then launch normally.

## Prerequisites

You already have these — listing for completeness:

- **`claude` CLI** installed and authed (`claude login` done on this Mac).
  The agent pane uses the SDK, which falls back to the CLI's stored credentials.
  Without this, the lower-right Claude pane will not respond.

## What to test

- PDF review: open any PDF, highlight text, leave comments (L1/L2/L3 buttons in the right drawer).
- Bundle export.
- Agent pane (lower-right): chat with Claude about the open document.

## What doesn't work yet

- Search filter in the left file tree only matches files in already-expanded folders, and even on expanded folders the highlight doesn't reduce the list (filed: rev-cy0, rev-4nc).
- Reopening a recently-edited PDF mid-session may not reload its sidecar comments (filed: rev-9sj).
- Phone / t3 chip in agent-pane: that's a display-mode toggle (clean view vs. tool-work view). It does NOT switch sessions. Label is inverted — shows current state, should show destination (filed: rev-e9l).
- Cost number in agent-pane footer is always on for now (toggle pending, rev-drs).
- Only `.pdf` files are reviewable. `.md`/`.html`/`.docx` are dimmed in the file tree (epics filed: rev-mf3, rev-2h6, rev-6k6).

## Reporting issues

Anything weird you hit, just describe what you saw + what you expected. We'll triage on this end.
