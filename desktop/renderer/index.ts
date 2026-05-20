import type { EngineResult, PdfHealthResult } from '@shared/types';

// Renderer entry. Wires up three startup probes that exercise the IPC bridge:
//
//   1. ping() — confirms contextBridge IPC.
//   2. engineVersion() — confirms the §13.1 PATH-discovery + spawn path.
//   3. pdfHealth() — confirms JSON round-trip through the engine for §5.2.
//
// Real renderer logic (file tree, PDF viewer, comment cards, Claude pane)
// lands as follow-up milestones. The third probe will be replaced by a
// real call against whatever PDF the user opens, once project-open lands.

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
