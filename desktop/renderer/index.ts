import type { EngineResult } from '@shared/types';

// Renderer entry. Empty-shell + engine-probe milestone:
//   1. ping main to verify the contextBridge IPC.
//   2. call engineVersion() to verify the Python engine is reachable per spec §13.1.
//
// Real renderer logic (file tree, PDF viewer, comment cards, Claude pane)
// lands as follow-up milestones.

async function init() {
  const diag = document.getElementById('diag');
  if (!diag) return;

  // Two diagnostic lines, stacked.
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

  // 2. Engine reachability probe
  try {
    const result = await window.electronAPI.engineVersion();
    engineLine.textContent = formatEngineResult(result);
  } catch (err) {
    engineLine.textContent = `engine ✗  IPC error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatEngineResult(r: EngineResult): string {
  if (r.ok) {
    // stdout is typically "review-pdf 0.1.0\n"
    const version = r.stdout.trim();
    return `engine ✓  ${version}  (${shortenPath(r.resolvedPath)})`;
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
  // Collapse $HOME for readability in the corner diagnostic.
  // We can't read process.env here; just look for /Users/<name>/ style prefixes.
  return p.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~');
}

void init();
