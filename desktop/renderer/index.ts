// Renderer entry. Empty-shell milestone: verify the IPC bridge works by pinging main
// and surfacing the response in the corner diagnostic. Real renderer logic lands as
// the §2-§9 panes are wired up in follow-up milestones.

async function init() {
  const diag = document.getElementById('diag');
  if (!diag) return;

  try {
    const reply = await window.electronAPI.ping('hello from renderer');
    diag.textContent = `electronAPI ✓  ${reply}`;
  } catch (err) {
    diag.textContent = `electronAPI ✗  ${err instanceof Error ? err.message : String(err)}`;
  }
}

void init();
