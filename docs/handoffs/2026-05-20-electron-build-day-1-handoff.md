---
type: handoff
status: empty-shell + engine-bridge + PDF viewer landed; ready for milestone #2 (project-open)
created: 2026-05-20
audience: review-pdf-to-latex author (AJB) + the agent picking this up next
session_role: first build session after pre-build picks
predecessors:
  - docs/handoffs/2026-05-19-electron-spec-brainstorming-handoff.md  (pre-build picks complete)
related-spec:
  - docs/specs/2026-05-19-electron-app-ux-spec.md  (§5.2, §13.* amended this session)
  - docs/specs/2026-05-16-review-pdf-to-latex-design.md  (§10 rewritten, §8 added pdf-health)
related-research:
  - docs/research/2026-05-20-pdf-text-layer-spike/  (PDF.js validation that motivated half this session)
---

# Build day 1 handoff — empty shell through PDF viewer

This session took the spec from "all pre-build picks resolved on paper" to a running Electron app that opens a PDF, renders it with PDF.js, captures glyph-accurate text selections producing the §5.2 payload, and has every piece of engine plumbing wired for the milestones that follow.

## What got done (seven commits)

In chronological order:

1. **`95aefac` — docs(spec): rewrite §10 of 2026-05-16 design spec post-Electron pivot.** §13.5 resolved. The old design-spec §10 specified the retired Jinja/HTTP-viewer sidecar; rewrote it in place to point at the Electron app spec while preserving the action-semantics table that §7, §8, §9, §11, §12, §18, §19 cross-reference. Header marked partially superseded.

2. **`3ebb6de` — docs(spike): PDF text-layer spike + spec amendments.** §13.10, §13.11 resolved. Self-contained PDF.js prototype (`docs/research/2026-05-20-pdf-text-layer-spike/spike.html`) validated end-to-end against the corrupted COTA PDF. Findings:
   - PDF.js handles well-formed PDFs cleanly
   - Degrades gracefully on broken ones (blank render + clear warning, no crash)
   - The corrupted COTA PDF is genuinely broken (Acrobat refuses it, poppler logs 137 errors, PDF.js renders 2 of 10 pages)
   - With text-layer selection as the primary UX, coordinate accuracy stops being a question — the selection IS the text PDF.js extracted
   - §5.2 picked up four explicit additions (pre-flight pdf-health, ligature warning, region-always-captured, no v1 OCR); engine §8 picked up the `pdf-health` CLI subcommand.

3. **`bff77ff` — feat(desktop): scaffold Electron app empty shell.** §13.3 + §13.4 implemented. `desktop/` directory created per spec layout: package.json + electron-vite config + three composite tsconfigs + main/preload/renderer/shared/tests dirs. Electron 42 (latest stable, clears all GHSA advisories), electron-vite 2, Vite 5, TypeScript 5.6 strict. Renderer is vanilla TS per §13.4's deferred-framework call. Security defaults: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The renderer mounts a three-pane placeholder layout per §2.

4. **`e277286` — fix(desktop): build preload as CJS so sandboxed contextBridge actually loads.** The first launch showed the layout but `window.electronAPI` was undefined; the sandboxed renderer couldn't see anything from preload. Cause: electron-vite was emitting `index.mjs` (ESM) for preload because root package.json declares `"type": "module"`; Electron's documented constraint is that sandboxed preloads must be CommonJS. Forced CJS output with `.cjs` extension via Rollup output config; main updated to load `.cjs`. Diagnostic flipped from ✗ to ✓.

5. **`0f404c1` — feat(desktop+engine): spawn engine subprocess via PATH-discovery (spec §13.1).** Engine CLI gained `--version` (read from `__version__`). Electron gained `desktop/main/engine.ts` with `resolveEngine()` (walks the §13.1 chain — env override → PATH → repo-local .venv up to 3 levels up → `~/.venvs/...`) and `runEngine(args)` (5s default timeout, returns a discriminated EngineResult covering ok / not_found / spawn_failed / failed / timeout). Renderer's startup diagnostic gained a second line showing the resolved engine version + path.

6. **`650e06d` — feat(engine+desktop): pdf-health subcommand + Electron IPC wiring (spec §5.2, §8).** Engine side: `src/review_pdf_to_latex/pdf_health.py` (health_check + run_pdf_health + ligature heuristic + cid_density heuristic), `cli.py` adds the subparser, 25 new tests. Validated against the corrupted COTA PDF: all 10 pages correctly marked unreadable (pp.1–2 at 98% CID density, pp.3–10 zero glyphs) with structured per-page error strings. Electron side: typed `PdfHealthReport`, `pdfHealth(path)` in main, IPC handler, preload bridge. Renderer gained a third diagnostic line probing the bundled clean fixture for proof-of-life.

7. **`971b0e0` — feat(desktop): PDF viewer in document pane (spec §5.2, §13.6 spike).** Production port of the text-layer spike into the renderer. `pdfjs-dist` as a real npm dep (Vite bundles the worker). `desktop/renderer/pdf-viewer.ts` is the `PdfViewer` class: loadBytes / renderPage / navigation / setZoom / fitPage / fitWidth / setDarkMode, with selection capture surfaced through an `onSelection` callback emitting the §5.2 payload. Imports canonical `pdfjs-dist/web/pdf_viewer.css` (hand-rolled subset produced ~2-char drift between selection rects and canvas glyphs). Nav strip: prev / page-label / next / Fit page / Fit width / dark-mode toggle. `fs:readPdfBytes` IPC added (sandboxed renderer can't open file:// URLs). CSP relaxed to allow `blob:` for the worker. Bottom-input echoes the captured §5.2 payload as JSON. Diagnostic moved to top-right + muted.

## State of the app right now

`cd desktop && npm run dev` launches a window that:

- Renders the three-pane layout per spec §2
- Loads `tests/fixtures/sample-annotated.pdf` (hardcoded probe — replaced by file picker in milestone #2) into the middle pane
- Lets the user drag-select text; the bottom strip echoes the §5.2 payload as JSON in real time
- Has working prev/next, Fit page, Fit width, dark-mode toggle
- Shows three green ✓ diagnostics top-right (IPC, engine, pdf-health)

The full IPC surface exposed to the renderer today:
- `ping(message)` — smoke-test
- `engineVersion()` — `EngineResult`
- `pdfHealth(path)` — `PdfHealthResult` (parsed JSON report)
- `readPdfBytes(path)` — `ReadPdfBytesResult`

## Spec progress on §13 pre-build items

| Item | Status |
|---|---|
| §13.1 Python bundling | Resolved (PATH-discovery); engine.ts implements the chain. Settings-file override + version-check banner deferred. |
| §13.2 First-scope cut | Resolved (ground-up) — we're building it. |
| §13.3 Repo strategy | Resolved (same repo, desktop/); scaffolded. |
| §13.4 Tech stack | Resolved (Electron); shipped. |
| §13.5 Docs cleanup | Resolved this session. |
| §13.6 Dark mode | Spike answered "yes, CSS filter works" — implemented as a toggle. Needs testing on real PDFs. |
| §13.9 Tool palette 4th slot | Open, decided during prototype per spec. |
| §13.10 PDF text reliability | Resolved this session. |
| §13.11 Highlight→text coords | Resolved this session (text-layer selection makes it a non-question). |
| §13.12 Cmd+F search | Deferred to v2. |

No remaining pre-build blockers.

## Open items recorded for AJB

- **Diagnostic placement.** Currently top-right corner, muted/small. AJB flagged it conflicts with the top-pane content; final placement deferred for AJB to decide.
- **Selection payload schema.** `pdf-viewer.ts` returns `{page, region, highlighted_text, screenRects}`. The `screenRects` field is renderer-internal (for drawing host highlights); should be filtered before any persistence. Worth deciding before milestone #4 wires it into comment cards.
- **Dark-mode validation.** CSS `invert(0.92) hue-rotate(180deg)` filter works on the clean sample fixture. Untested on the corrupted COTA PDF, multi-column PDFs, and PDFs with colored figures/charts. Worth a real-PDFs pass before declaring §13.6 fully done in the spec.

## Where to pick up next

**Highest priority: milestone #2 — project-open flow.** Reasons:

1. **Removes the hardcoded probe PDF**, which is the most user-facing gap. Today the app shows the same fixture on every launch; no way for AJB to test against the corrupted COTA, against multi-page docs, against anything real.
2. **Surfaces the pdf-health report** — the engine work is done, the IPC is wired, but the *banner UX* doesn't exist yet. That's the visible deliverable of §5.2's "PDF-health pre-flight at load time."
3. **Unblocks real-PDF testing of everything else** — the dark-mode validation, the selection accuracy on rotated/multi-column pages, the eventual comment-card UI all benefit from being driven against real documents instead of one fixture.
4. **Scope is small** — file picker dialog + drop-target + banner component + wire to existing `pdfHealth()` + `readPdfBytes()` IPCs. No new engine work.

After project-open: bottom input pane (#3), then comment cards (#4), Claude pane (#5), save versioning (#6). Claude pane (#5) is the cleanest parallel candidate if the next session wants to split — it's fully orthogonal to everything else.

## Things the next session can rely on

- Engine `--version` flag works, returns `review-pdf 0.1.0`.
- `review-pdf pdf-health --pdf <path>` always emits parseable JSON to stdout (exit 0/2/21).
- 457+25 tests pass; engine side has solid coverage for what's specified.
- The §5.2 selection payload `{page, region, highlighted_text}` is the right primitive for comment construction.
- Electron security defaults (sandbox, contextIsolation, CSP) are correct; preload contextBridge is the only path from renderer to main; main is the only path to filesystem / engine subprocess.
- Hot reload works for renderer changes via electron-vite dev. Main/preload changes still need a `npm run dev` restart.

## Things to NOT do without thinking first

- Don't disable `sandbox: true` or `contextIsolation: true` casually. They're load-bearing; if something doesn't work, fix it the structured way (new IPC handler) not by widening the security boundary.
- Don't add npm deps casually. PDF.js was earned by the spike + milestone; node-pty + xterm.js will be earned by the Claude pane work. Anything else needs a reason.
- Don't bypass the engine. The renderer never reads files directly, never spawns subprocesses, never writes state. All of that goes through main process IPC handlers — that's what makes the engine independently testable and the renderer headlessly mockable.
- Don't rewrite §10 of the design spec again. It's been re-pointed at the new architecture; further changes risk losing the engine-side action-transition contract that other sections cross-reference.

## Quick start for the next session

```bash
cd /Users/anthonybyrnes/PycharmProjects/review-pdf-to-latex
git pull --rebase
cd desktop
npm install                  # idempotent; ~no-op if up-to-date
npm run dev                  # launches the window
# in a separate terminal:
npm run typecheck            # all three composite projects
npm run build                # production bundle
.venv/bin/python -m pytest   # 457 engine tests + 25 pdf-health tests
```

Spec entry points for the next milestone: 2026-05-19-electron-app-ux-spec.md §5.2 (banner requirements at PDF-load), §5.3 (save-as versioning — relevant once file picker is in place since open and save are paired).
