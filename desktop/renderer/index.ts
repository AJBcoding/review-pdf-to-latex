import type {
  EngineResult,
  PdfHealthResult,
  ReadPdfBytesResult,
} from '@shared/types';
import { PdfViewer, type SelectionPayload } from './pdf-viewer';

/** Cross-platform path basename — avoids dragging in a node path polyfill
 * just for the title-bar label. Handles both POSIX and Windows separators. */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

// Renderer entry. Milestone #2 (project-open flow):
//
//   1. Two startup diagnostics — IPC bridge + engine reachability — surface
//      in the top-right strip so AJB can confirm the engine is wired up
//      without having to open a PDF.
//   2. Empty state in the document pane until the user picks a file.
//   3. Open… button → native picker → pdfHealth() + readPdfBytes() run in
//      parallel → render the page + surface the §5.2 banner if the report
//      flags problems.
//
// The §5.2 banner copy mirrors the spec's load-time pre-flight requirement:
// distinct messages for encrypted / all-unreadable / partial / ligature-loss /
// open-error, and no banner at all when the PDF is clean.

interface ViewerHandles {
  viewer: PdfViewer;
  mount: HTMLElement;
  echo: HTMLElement;
  title: HTMLElement;
  banner: HTMLElement;
  prevBtn: HTMLButtonElement;
  nextBtn: HTMLButtonElement;
  fitPageBtn: HTMLButtonElement;
  fitWidthBtn: HTMLButtonElement;
  darkBtn: HTMLButtonElement;
}

async function init() {
  await mountStartupDiagnostics();
  bootProjectOpenFlow();
}

async function mountStartupDiagnostics(): Promise<void> {
  const diag = document.getElementById('diag');
  if (!diag) return;

  const ipcLine = document.createElement('div');
  const engineLine = document.createElement('div');
  diag.append(ipcLine, engineLine);

  // 1. IPC bridge smoke-test
  try {
    const reply = await window.electronAPI.ping('hello from renderer');
    ipcLine.textContent = `electronAPI ✓  ${reply}`;
  } catch (err) {
    ipcLine.textContent = `electronAPI ✗  ${err instanceof Error ? err.message : String(err)}`;
  }

  // 2. Engine reachability probe (no longer blocks PDF-open; pdf-health is
  //    exercised per-document now, not at startup).
  try {
    const result = await window.electronAPI.engineVersion();
    engineLine.textContent = formatEngineResult(result);
  } catch (err) {
    engineLine.textContent = `engine ✗  IPC error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function bootProjectOpenFlow(): void {
  const mount = document.getElementById('pdfMount');
  const echo = document.getElementById('selectionEcho');
  const title = document.getElementById('pdfTitle');
  const banner = document.getElementById('pdfBanner');
  const openBtn = document.getElementById('pdfOpen') as HTMLButtonElement | null;
  const prevBtn = document.getElementById('pdfPrev') as HTMLButtonElement | null;
  const nextBtn = document.getElementById('pdfNext') as HTMLButtonElement | null;
  const darkBtn = document.getElementById('pdfDarkToggle') as HTMLButtonElement | null;
  const fitPageBtn = document.getElementById('pdfFitPage') as HTMLButtonElement | null;
  const fitWidthBtn = document.getElementById('pdfFitWidth') as HTMLButtonElement | null;
  const pageLabel = document.getElementById('pdfPageLabel');
  if (
    !mount || !echo || !title || !banner ||
    !openBtn || !prevBtn || !nextBtn || !darkBtn ||
    !fitPageBtn || !fitWidthBtn || !pageLabel
  ) return;

  const viewer = new PdfViewer({
    container: mount,
    onSelection: (payload) => updateSelectionEcho(echo, payload),
    onPageInfo: ({ page, totalPages }) => {
      pageLabel.textContent = `${page} / ${totalPages}`;
      prevBtn.disabled = page <= 1;
      nextBtn.disabled = page >= totalPages;
    },
  });

  // The viewer constructor takes over `mount`'s children — re-attach the
  // empty-state node it just removed so it's visible until a PDF loads.
  renderEmptyState(mount);

  const handles: ViewerHandles = {
    viewer, mount, echo, title, banner,
    prevBtn, nextBtn, fitPageBtn, fitWidthBtn, darkBtn,
  };

  prevBtn.addEventListener('click', () => { void viewer.prevPage(); });
  nextBtn.addEventListener('click', () => { void viewer.nextPage(); });
  fitPageBtn.addEventListener('click', () => { void viewer.fitPage(); });
  fitWidthBtn.addEventListener('click', () => { void viewer.fitWidth(); });
  darkBtn.addEventListener('click', () => {
    viewer.setDarkMode(!viewer.isDarkMode());
    darkBtn.setAttribute('aria-pressed', String(viewer.isDarkMode()));
  });

  openBtn.addEventListener('click', () => { void handleOpenClick(handles, openBtn); });

  // ⌘O / Ctrl+O as a convenience accelerator. Spec doesn't mandate it for
  // this milestone, but it's expected on macOS and one event listener.
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      void handleOpenClick(handles, openBtn);
    }
  });
}

async function handleOpenClick(h: ViewerHandles, openBtn: HTMLButtonElement): Promise<void> {
  openBtn.disabled = true;
  try {
    const picked = await window.electronAPI.openPdfDialog();
    if (!picked.path) return; // user canceled — leave current state untouched
    await loadPdf(h, picked.path);
  } finally {
    openBtn.disabled = false;
  }
}

async function loadPdf(h: ViewerHandles, path: string): Promise<void> {
  h.title.textContent = `Loading ${basename(path)}…`;
  hideBanner(h.banner);

  // Kick off bytes + health in parallel. Both round-trip through main; running
  // them concurrently shaves ~engine-startup-time off the visible load latency.
  const [bytesResult, healthResult] = await Promise.all([
    window.electronAPI.readPdfBytes(path),
    window.electronAPI.pdfHealth(path),
  ]);

  // Render the health banner first so a render failure below still has the
  // diagnostic context visible. The banner is non-blocking either way.
  renderHealthBanner(h.banner, healthResult);

  if (!bytesResult.ok) {
    h.title.textContent = basename(path);
    renderLoadError(h.mount, bytesResult);
    setViewerControlsEnabled(h, false);
    return;
  }

  try {
    await h.viewer.loadBytes(bytesResult.bytes);
    h.title.textContent = basename(path);
    setViewerControlsEnabled(h, true);
  } catch (err) {
    h.title.textContent = basename(path);
    const errEl = document.createElement('div');
    errEl.className = 'pdf-empty';
    errEl.textContent = `pdf load failed: ${err instanceof Error ? err.message : String(err)}`;
    h.mount.replaceChildren(errEl);
    setViewerControlsEnabled(h, false);
  }
}

function setViewerControlsEnabled(h: ViewerHandles, enabled: boolean): void {
  h.fitPageBtn.disabled = !enabled;
  h.fitWidthBtn.disabled = !enabled;
  h.darkBtn.disabled = !enabled;
  // prev/next/pageLabel are managed by onPageInfo — when no doc is loaded
  // they retain their last-known state, which is fine because the empty
  // state replaces the viewer surface entirely.
}

function renderEmptyState(mount: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'pdf-empty';
  wrap.id = 'pdfEmpty';

  const t = document.createElement('div');
  t.className = 'pdf-empty-title';
  t.textContent = 'No PDF loaded';

  const hint = document.createElement('div');
  hint.className = 'pdf-empty-hint';
  hint.append('Click ');
  const strong = document.createElement('strong');
  strong.textContent = 'Open…';
  hint.append(strong, ' above to choose a PDF.');

  wrap.append(t, hint);
  mount.replaceChildren(wrap);
}

function renderLoadError(mount: HTMLElement, r: ReadPdfBytesResult): void {
  const el = document.createElement('div');
  el.className = 'pdf-empty';

  const title = document.createElement('div');
  title.className = 'pdf-empty-title';
  title.textContent = 'Couldn’t open this file';

  const detail = document.createElement('div');
  detail.className = 'pdf-empty-hint';
  if (!r.ok) {
    detail.textContent = `${r.reason}: ${r.resolvedPath}${r.error ? ` — ${r.error}` : ''}`;
  } else {
    detail.textContent = 'no bytes returned';
  }
  el.append(title, detail);
  mount.replaceChildren(el);
}

// ─── §5.2 banner ──────────────────────────────────────────────────────────

function hideBanner(banner: HTMLElement): void {
  banner.hidden = true;
  banner.removeAttribute('data-severity');
  banner.replaceChildren();
}

function renderHealthBanner(banner: HTMLElement, r: PdfHealthResult): void {
  // Engine call itself failed — surface as an error so the user knows the
  // banner isn't silently absent because the PDF is clean.
  if (!r.ok) {
    const reason = r.engine.ok ? 'unknown' : r.engine.reason;
    fillBanner(banner, 'error',
      'Couldn’t check this PDF’s health.',
      `Engine call failed (${reason}). The viewer will still try to render.`);
    return;
  }

  const { report } = r;

  // 1. Document-level open failure
  if (report.error) {
    fillBanner(banner, 'error',
      'This PDF couldn’t be opened by the engine.',
      report.error);
    return;
  }

  // 2. Encrypted
  if (report.encrypted) {
    fillBanner(banner, 'error',
      'This PDF is encrypted.',
      'Text extraction and highlight capture aren’t available. Save an unencrypted copy and re-open.');
    return;
  }

  const total = report.total_pages ?? 0;
  const readable = report.readable_pages.length;
  const unreadable = report.unreadable_pages.length;

  // 3. All pages unreadable
  if (total > 0 && readable === 0) {
    fillBanner(banner, 'error',
      'This PDF appears damaged — no readable text on any page.',
      'Likely cause: the file was re-saved or annotated by a tool that corrupted its content streams. Recommended: rebuild the PDF from source.');
    return;
  }

  // 4. Partial damage
  if (unreadable > 0) {
    fillBanner(banner, 'warn',
      `This PDF appears partially damaged: ${formatPageList(report.unreadable_pages)} contain no readable text.`,
      `You can still review ${formatPageList(report.readable_pages)}. Highlights on damaged pages will capture region-only (no underlying text).`);
    return;
  }

  // 5. Ligature loss (otherwise clean)
  if (report.ligature_loss_detected) {
    fillBanner(banner, 'warn',
      'Captured text on this PDF may be missing ligatures (e.g. “veri ed” for “verified”).',
      'Highlights will still capture text; expect occasional gaps in the extracted strings.');
    return;
  }

  // 6. Clean → banner stays hidden.
  hideBanner(banner);
}

function fillBanner(
  banner: HTMLElement,
  severity: 'warn' | 'error',
  primary: string,
  detail: string,
): void {
  banner.hidden = false;
  banner.setAttribute('data-severity', severity);
  const icon = severity === 'error' ? '⚠ ' : '⚠ ';
  const head = document.createElement('strong');
  head.textContent = `${icon}${primary}`;
  const sub = document.createElement('span');
  sub.className = 'pdf-banner-detail';
  sub.textContent = detail;
  banner.replaceChildren(head, sub);
}

/**
 * Render a 1-indexed page list as a compact human-readable string:
 *   [1,2,3,5,7,8,9] → "pages 1–3, 5, 7–9"
 * Empty → "no pages". Single → "page N".
 */
function formatPageList(pages: number[]): string {
  if (pages.length === 0) return 'no pages';
  const sorted = [...pages].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i];
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
    start = n;
    prev = n;
  }
  ranges.push(start === prev ? `${start}` : `${start}–${prev}`);
  const label = pages.length === 1 ? 'page' : 'pages';
  return `${label} ${ranges.join(', ')}`;
}

// ─── Selection echo + diagnostic formatters (unchanged from milestone #1) ──

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

function shortenPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

void init();
