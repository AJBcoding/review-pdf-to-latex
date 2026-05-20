# desktop/

Electron app for review-pdf-to-latex. Renders the UX specified in
[`../docs/specs/2026-05-19-electron-app-ux-spec.md`](../docs/specs/2026-05-19-electron-app-ux-spec.md);
talks to the Python engine over a subprocess boundary per the design spec
[`../docs/specs/2026-05-16-review-pdf-to-latex-design.md`](../docs/specs/2026-05-16-review-pdf-to-latex-design.md).

## Status

**Empty shell.** App launches, renders the three-pane layout per spec §2 as
placeholder divs, verifies the main↔renderer IPC bridge with a ping. No PDF
rendering, no engine spawn, no real interactions yet.

Next milestones, roughly in order:

1. Engine spawn via `child_process.spawn('review-pdf', […])` per spec §13.1
   (PATH-discovery). Plumb `review-pdf pdf-health` into the load-time banner
   (per spec §5.2 + design spec §8).
2. PDF rendering + text-layer selection in the middle pane (port the spike
   prototype from `../docs/research/2026-05-20-pdf-text-layer-spike/spike.html`).
3. Bottom input pane and comment-card stream (spec §3, §6).
4. Right-drawer Claude pane via `node-pty` + `xterm.js` (spec §9.2 +
   design spec §13.4).
5. Save / Save-As versioning (spec §5.3).

## Stack

- **Electron 33** (latest stable; widest Chromium for PDF.js compatibility per
  spec §13.4)
- **electron-vite + Vite 5** — three Vite builds (main / preload / renderer)
  driven from one config
- **TypeScript 5.6** — strict mode on
- **Vanilla TS renderer** for now. §13.4 explicitly defers the
  React-vs-Svelte-vs-vanilla decision to "during prototype." The renderer
  layer is contained enough that swapping later is a renderer-only rewrite.

Not yet installed (intentionally — added when their first use case lands):

- `pdfjs-dist` (PDF rendering + text layer)
- `node-pty` (Claude-pane pty)
- `xterm` / `xterm-addon-*` (terminal UI)

## Layout

```
desktop/
├── package.json
├── electron.vite.config.ts
├── tsconfig.json           # root, references the two below
├── tsconfig.node.json      # main + preload + electron-vite config
├── tsconfig.web.json       # renderer
├── main/                   # Electron main process
│   └── index.ts
├── preload/                # preload (IPC contextBridge)
│   └── index.ts
├── renderer/               # renderer (vanilla TS)
│   ├── index.html
│   ├── index.ts
│   └── styles.css
├── shared/                 # types shared main ↔ preload ↔ renderer
│   └── types.ts
├── tests/                  # app-side tests (empty for now)
└── out/                    # gitignored build output
```

## Development

```bash
cd desktop
npm install
npm run dev          # electron-vite dev — launches the app with HMR on the renderer
npm run typecheck    # type-check all three projects without emitting
npm run build        # production build → desktop/out/
```

## IPC convention

The renderer talks to main **only** through `window.electronAPI` — a typed
surface defined in `shared/types.ts` and bound via the preload's
`contextBridge.exposeInMainWorld`. `contextIsolation: true` and `sandbox: true`
are non-negotiable; the preload is the security boundary.

To add a new IPC channel:

1. Add the method signature to `ElectronAPI` in `shared/types.ts`.
2. Implement the renderer-facing call in `preload/index.ts` (via `ipcRenderer.invoke`).
3. Register the handler in `main/index.ts` (via `ipcMain.handle`).
4. Use `window.electronAPI.yourMethod(…)` from renderer code.

Keep this surface small. Anything not in `ElectronAPI` cannot be reached from
the renderer — that's the design.

## Why monorepo

See [spec §13.3](../docs/specs/2026-05-19-electron-app-ux-spec.md). Short
version: solo dev, engine and app co-evolve daily, one commit per logical
change. Split conditions are recorded; none apply for v1.
