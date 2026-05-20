import type { EngineResult, PdfHealthResult, ReadPdfBytesResult } from '@shared/types';
import { PdfViewer, type SelectionPayload } from './pdf-viewer';

// Renderer entry. Four startup probes exercise the IPC bridge end-to-end:
//
//   1. ping()            — contextBridge IPC.
//   2. engineVersion()   — §13.1 PATH-discovery + spawn.
//   3. pdfHealth()       — JSON round-trip through the engine for §5.2.
//   4. PdfViewer + readPdfBytes() — port of the 2026-05-20 spike into the
//      document-viewer pane. Native text selection over PDF.js's TextLayer
//      yields the §5.2 payload, echoed into the bottom-input placeholder.
//
// Future milestones replace each of these probes with real UX:
//   #2 swaps the hardcoded probe path for a file picker + health banner
//   #3 swaps the bottom-input echo for the typed comment/redraft/surface UI
//   #4 routes selections into the comment stream in the right drawer

// Until the file picker lands, point at a known fixture so the empty shell
// has a visible PDF to demonstrate the rendering path. Resolved relative to
// main's cwd (desktop/ during dev) → repo-root tests/fixtures/.
const PROBE_PDF = '../tests/fixtures/sample-annotated.pdf';

async function init() {
  const diag = document.getElementById('diag');
  if (!diag) return;

  const ipcLine = document.createElement('div');
  const engineLine = document.createElement('div');
  const pdfHealthLine = document.createElement('div');
  diag.append(ipcLine, engineLine, pdfHealthLine);

  // 1. IPC bridge smoke-test
  try {
    const reply = await window.electronAPI.ping('hello from renderer');
    ipcLine.textContent = `electronAPI ✓  ${reply}`;
  } catch (err) {
    ipcLine.textContent = `electronAPI ✗  ${err instanceof Error ? err.message : String(err)}`;
  }

  // 2. Engine reachability probe
  try {
    const result = await window.electronAPI.engineVersion();
    engineLine.textContent = formatEngineResult(result);
  } catch (err) {
    engineLine.textContent = `engine ✗  IPC error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 3. PDF health round-trip
  try {
    const result = await window.electronAPI.pdfHealth(PROBE_PDF);
    pdfHealthLine.textContent = formatPdfHealthResult(result);
  } catch (err) {
    pdfHealthLine.textContent = `pdf-health ✗  IPC error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // 4. Mount the PDF viewer
  await mountPdfViewer();
}

async function mountPdfViewer() {
  const mount = document.getElementById('pdfMount');
  const echo = document.getElementById('selectionEcho');
  const prevBtn = document.getElementById('pdfPrev') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('pdfNext') as HTMLButtonElement | null;
  const darkBtn = document.getElementById('pdfDarkToggle') as HTMLButtonElement | null;
  const fitPageBtn = document.getElementById('pdfFitPage') as HTMLButtonElement | null;
  const fitWidthBtn = document.getElementById('pdfFitWidth') as HTMLButtonElement | null;
  const pageLabel = document.getElementById('pdfPageLabel');
  if (!mount || !echo || !prevBtn || !nextBtn || !darkBtn || !fitPageBtn || !fitWidthBtn || !pageLabel) return;

  const viewer = new PdfViewer({
    container: mount,
    onSelection: (payload) => updateSelectionEcho(echo, payload),
    onPageInfo: ({ page, totalPages }) => {
      pageLabel.textContent = `${page} / ${totalPages}`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= totalPages;
    },
  });

  prevBtn.addEventListener('click', () => { void viewer.prevPage(); });
  nextBtn.addEventListener('click', () => { void viewer.nextPage(); });
  fitPageBtn.addEventListener('click', () => { void viewer.fitPage(); });
  fitWidthBtn.addEventListener('click', () => { void viewer.fitWidth(); });
  darkBtn.addEventListener('click', () => {
    viewer.setDarkMode(!viewer.isDarkMode());
    darkBtn.setAttribute('aria-pressed', String(viewer.isDarkMode()));
  });

  const bytesResult = await window.electronAPI.readPdfBytes(PROBE_PDF);
  if (!bytesResult.ok) {
    mount.replaceChildren(formatReadError(bytesResult));
    return;
  }

  try {
    await viewer.loadBytes(bytesResult.bytes);
  } catch (err) {
    const errEl = document.createElement('div');
    errEl.className = 'placeholder';
    errEl.textContent = `pdf load failed: ${err instanceof Error ? err.message : String(err)}`;
    mount.replaceChildren(errEl);
  }
}

function updateSelectionEcho(echo: HTMLElement, payload: SelectionPayload) {
  echo.classList.remove('placeholder');
  echo.textContent = JSON.stringify(
    {
      page: payload.page,
      region: roundedRegion(payload.region),
      highlighted_text: payload.highlighted_text,
    },
    null,
    2,
  );
}

function roundedRegion(r: SelectionPayload['region']) {
  return {
    x: Math.round(r.x * 10) / 10,
    y: Math.round(r.y * 10) / 10,
    w: Math.round(r.w * 10) / 10,
    h: Math.round(r.h * 10) / 10,
  };
}

function formatReadError(r: ReadPdfBytesResult): HTMLElement {
  const el = document.createElement('div');
  el.className = 'placeholder';
  if (!r.ok) {
    el.textContent = `pdf read failed (${r.reason}): ${r.resolvedPath}${r.error ? ` — ${r.error}` : ''}`;
  } else {
    el.textContent = 'pdf read returned no bytes';
  }
  return el;
}

function formatEngineResult(r: EngineResult): string {
  if (r.ok) {
    return `engine ✓  ${r.stdout.trim()}  (${shortenPath(r.resolvedPath)})`;
  }
  switch (r.reason) {
    case 'not_found': {
      const stepsTried = r.triedPaths.map((a) => `${a.step}:${shortenPath(a.path)}`).join(' → ');
      return `engine ✗  not found.  Tried: ${stepsTried}`;
    }
    case 'spawn_failed':
      return `engine ✗  spawn failed: ${r.error}  (${shortenPath(r.resolvedPath)})`;
    case 'failed':
      return `engine ✗  exit ${r.exitCode}: ${r.stderr.trim() || '(no stderr)'}  (${shortenPath(r.resolvedPath)})`;
    case 'timeout':
      return `engine ✗  timed out after ${r.timeoutMs}ms  (${shortenPath(r.resolvedPath)})`;
  }
}

function formatPdfHealthResult(r: PdfHealthResult): string {
  if (!r.ok) {
    return `pdf-health ✗  engine call failed (${r.engine.ok ? '' : r.engine.reason})`;
  }
  const { report } = r;
  if (report.error) {
    return `pdf-health ⚠  ${report.error}  (exit ${r.exitCode})`;
  }
  if (report.encrypted) {
    return `pdf-health ⚠  encrypted PDF`;
  }
  const total = report.total_pages ?? 0;
  const readable = report.readable_pages.length;
  const unreadable = report.unreadable_pages.length;
  const lig = report.ligature_loss_detected ? ', ⚠ ligature-loss' : '';
  return `pdf-health ✓  ${readable}/${total} pages readable, ${unreadable} unreadable${lig}`;
}

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

void init();
