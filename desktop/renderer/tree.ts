// §3 left-drawer file tree.
//
// Renders a folder-rooted tree into the left drawer. Folders are lazy-loaded
// on expand so opening a large repo (or accidentally pointing at $HOME) stays
// snappy — we only read the directories the user has actually opened.
//
// State the tree owns:
//   - current root (or null = empty state)
//   - per-folder loaded entries (cached so collapse/re-expand doesn't re-read)
//   - the set of expanded folder paths
//   - the "show hidden" toggle
//
// State the tree calls back about (host wires it up):
//   - file clicks → host opens the file in the middle pane
//   - any change worth persisting (root, expanded set, show-hidden) → host
//     debounces and writes app state
//
// The tree never persists anything itself — that's the host's job. Same
// separation as PdfViewer / loadPdf.

import type { DirEntry } from '@shared/types';

export interface FileTreeOptions {
  /** Element the tree paints into. The tree replaces its children on every
   *  rebuild, so don't put anything else in here. */
  body: HTMLElement;
  /** Header title element (`#treeTitle`). The tree updates `textContent` and
   *  the `title` attribute when the root changes. */
  title: HTMLElement;
  /** Empty-state element (`#treeEmpty`). Shown when no root is set; hidden
   *  whenever a tree is rendered. */
  empty: HTMLElement;
  /** Show-hidden toggle button. The tree manages its `aria-pressed` + class. */
  toggleHiddenBtn: HTMLButtonElement;
  /** User clicked a file leaf. PDF files are the only kind that round-trips
   *  to an opener for v1; other kinds are visually dimmed and never reach
   *  this callback. */
  onOpenFile: (path: string) => void;
  /** Any state change the host should persist (root, expanded set,
   *  show-hidden). The host can debounce — calls are non-blocking. */
  onStateChange: () => void;
}

interface CachedDir {
  entries: DirEntry[];
  /** True if the read failed; the row shows an inline error in that case
   *  and stays expandable so the user can collapse + retry. */
  error: string | null;
}

export class FileTree {
  private opts: FileTreeOptions;
  private root: string | null = null;
  private showHidden = false;
  private expanded = new Set<string>();
  private cache = new Map<string, CachedDir>();
  /** Per-folder in-flight load promise so a double-click can't issue two
   *  reads of the same dir. */
  private loading = new Map<string, Promise<void>>();
  /** Current case-insensitive substring filter applied after render.
   *  Empty string = no filter. */
  private filterQuery = '';

  constructor(opts: FileTreeOptions) {
    this.opts = opts;
    opts.toggleHiddenBtn.addEventListener('click', () => {
      this.setShowHidden(!this.showHidden);
      this.opts.onStateChange();
    });
  }

  /** Replace the current root. Pass null to clear back to the empty state.
   *  Wipes the dir cache — paths under the old root would be confusing in a
   *  new tree. The host is responsible for persisting; this method just
   *  updates the in-memory view + DOM. */
  async setRoot(root: string | null, opts: { silent?: boolean } = {}): Promise<void> {
    this.root = root;
    this.cache.clear();
    if (root) {
      for (const p of this.expanded) {
        if (!p.startsWith(root)) this.expanded.delete(p);
      }
    } else {
      this.expanded.clear();
    }
    if (!root) {
      this.opts.title.textContent = 'File tree';
      this.opts.title.title = 'No folder open';
      this.opts.empty.hidden = false;
      this.opts.body.querySelectorAll('.tree-root').forEach((el) => el.remove());
      if (!opts.silent) this.opts.onStateChange();
      return;
    }
    const label = basename(root);
    this.opts.title.textContent = label || root;
    this.opts.title.title = root;
    this.opts.empty.hidden = true;
    await this.ensureLoaded(root);
    // Mark the root itself as expanded so its children render.
    this.expanded.add(root);
    this.render();
    // Re-hydrate any persisted expanded folders that are still present in
    // the just-loaded root listing. We don't recursively pre-load — the
    // tree handles that as the user clicks down.
    if (!opts.silent) this.opts.onStateChange();
  }

  /** Apply state restored from disk in one shot, then render. Avoids the
   *  re-render churn the host would otherwise cause by setting fields one
   *  at a time. Restores expansion lazily — only paths that resolve as
   *  folders in already-loaded listings get pre-expanded; the rest stay
   *  dormant until the user clicks down to them. */
  async restoreState(args: {
    root: string | null;
    expanded: string[];
    showHidden: boolean;
  }): Promise<void> {
    this.expanded = new Set(args.expanded);
    this.showHidden = args.showHidden;
    this.reflectHiddenButton();
    if (args.root) {
      await this.setRoot(args.root, { silent: true });
      // Pre-load any persisted expanded dirs whose parents are already
      // loaded so the tree opens to roughly the state the user left it in.
      // Doing this iteratively so deeply nested expansion paths fan out
      // correctly even when no two siblings overlap.
      let changed = true;
      while (changed) {
        changed = false;
        for (const path of args.expanded) {
          if (!this.expanded.has(path)) continue;
          if (this.cache.has(path)) continue;
          if (!this.dirAppearsInLoadedListing(path)) continue;
          await this.ensureLoaded(path);
          changed = true;
        }
      }
      this.render();
    } else {
      await this.setRoot(null, { silent: true });
    }
  }

  /** Snapshot of the persistable bits — host writes this into app state. */
  snapshot(): { root: string | null; expanded: string[]; showHidden: boolean } {
    return {
      root: this.root,
      expanded: [...this.expanded].sort(),
      showHidden: this.showHidden,
    };
  }

  /** Clear the dir cache and re-render. Files added or removed on disk
   *  become visible after a refresh. */
  async refresh(): Promise<void> {
    if (!this.root) return;
    this.cache.clear();
    await this.ensureLoaded(this.root);
    for (const path of this.expanded) {
      if (this.dirAppearsInLoadedListing(path)) {
        await this.ensureLoaded(path);
      }
    }
    this.render();
  }

  /** Visually mark a file as the current document. Re-applied on every
   *  render so the highlight survives expand/collapse. */
  setActiveFile(path: string | null): void {
    this.activePath = path;
    this.refreshActiveRow();
  }

  private activePath: string | null = null;
  private modifiedPaths = new Set<string>();

  setModifiedFile(path: string, modified: boolean): void {
    if (modified) this.modifiedPaths.add(path);
    else this.modifiedPaths.delete(path);
    this.refreshModifiedRow(path);
  }

  private refreshModifiedRow(path: string): void {
    const row = this.opts.body.querySelector<HTMLElement>(
      `.tree-row[data-path="${CSS.escape(path)}"]`
    );
    if (row) row.classList.toggle('is-source-modified', this.modifiedPaths.has(path));
  }

  private setShowHidden(value: boolean): void {
    if (value === this.showHidden) return;
    this.showHidden = value;
    this.reflectHiddenButton();
    this.render();
  }

  private reflectHiddenButton(): void {
    const btn = this.opts.toggleHiddenBtn;
    btn.setAttribute('aria-pressed', String(this.showHidden));
    btn.classList.toggle('is-active', this.showHidden);
  }

  private async ensureLoaded(path: string): Promise<void> {
    if (this.cache.has(path)) return;
    const inflight = this.loading.get(path);
    if (inflight) return inflight;
    const p = (async () => {
      const res = await window.electronAPI.listDir(path);
      if (res.ok) {
        this.cache.set(path, { entries: res.entries, error: null });
      } else {
        this.cache.set(path, { entries: [], error: `${res.reason}: ${res.error}` });
      }
      this.loading.delete(path);
    })();
    this.loading.set(path, p);
    return p;
  }

  /** True if `path` is a folder entry in some already-loaded directory.
   *  Used during restoreState to know whether a persisted expansion is
   *  reachable from the currently-loaded portion of the tree. */
  private dirAppearsInLoadedListing(path: string): boolean {
    for (const [, dir] of this.cache) {
      for (const e of dir.entries) {
        if (e.isDir && e.path === path) return true;
      }
    }
    return false;
  }

  private async toggleExpand(path: string): Promise<void> {
    if (this.expanded.has(path)) {
      this.expanded.delete(path);
      this.render();
      this.opts.onStateChange();
      return;
    }
    await this.ensureLoaded(path);
    this.expanded.add(path);
    this.render();
    this.opts.onStateChange();
  }

  private render(): void {
    if (!this.root) {
      this.opts.body.querySelectorAll('.tree-root').forEach((el) => el.remove());
      this.opts.empty.hidden = false;
      return;
    }
    this.opts.empty.hidden = true;
    // Remove the previous tree (keep the empty-state node intact, hidden).
    this.opts.body.querySelectorAll('.tree-root').forEach((el) => el.remove());
    const ul = document.createElement('ul');
    ul.className = 'tree-root';
    ul.setAttribute('role', 'tree');
    this.renderDirChildren(this.root, ul, 0);
    this.opts.body.append(ul);
    this.refreshActiveRow();
    if (this.filterQuery) this.applyFilterToDom();
  }

  /** Case-insensitive substring filter. When active, recursively loads all
   *  folders so matches inside collapsed dirs are surfaced. */
  setFilter(query: string): void {
    this.filterQuery = query.trim();
    if (this.filterQuery && this.root) {
      void this.loadAllForFilter().then(() => {
        this.render();
      });
    } else {
      this.applyFilterToDom();
    }
  }

  private async loadAllForFilter(): Promise<void> {
    if (!this.root) return;
    const stack = [this.root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      await this.ensureLoaded(dir);
      const cached = this.cache.get(dir);
      if (!cached) continue;
      for (const entry of cached.entries) {
        if (entry.isDir && !entry.isHidden) {
          stack.push(entry.path);
        }
      }
    }
  }

  /** Measure the rendered tree's natural width and return a clamped pixel
   *  value the host can apply to --col-left. Reads scrollWidth of each
   *  row's label + chrome (chevron+icon+padding). Returns a value in
   *  [minPx, maxPx]. */
  measureFitWidth(minPx = 180, maxPx = 480, chrome = 28): number {
    const rows = this.opts.body.querySelectorAll<HTMLElement>('.tree-row:not([hidden])');
    let max = minPx;
    rows.forEach((row) => {
      const padLeft = parseFloat(row.style.paddingLeft || '0') || 0;
      const label = row.querySelector<HTMLElement>('.tree-label');
      const labelW = label ? label.scrollWidth : row.scrollWidth;
      const total = padLeft + chrome + labelW + 12; // +12 for right padding/scrollbar
      if (total > max) max = total;
    });
    return Math.max(minPx, Math.min(maxPx, Math.round(max)));
  }

  /** Walk all rendered rows; show/hide based on filterQuery. A directory
   *  row stays visible if it contains a matching descendant (even nested);
   *  this preserves context so the user can see where a hit lives. */
  private applyFilterToDom(): void {
    const rows = Array.from(this.opts.body.querySelectorAll<HTMLElement>('.tree-row'));
    rows.forEach((r) => { r.hidden = false; r.classList.remove('is-search-hit'); });
    if (!this.filterQuery) return;

    const q = this.filterQuery.toLowerCase();
    // Pass 1: mark direct hits (leaves AND dirs whose own name matches).
    const directHit = new Set<HTMLElement>();
    rows.forEach((r) => {
      const label = r.querySelector<HTMLElement>('.tree-label');
      const name = (label?.textContent ?? '').toLowerCase();
      if (name.includes(q)) {
        directHit.add(r);
        r.classList.add('is-search-hit');
      }
    });

    // Pass 2: for each direct-hit row, walk back through previous siblings
    // to find every ancestor directory and mark it visible. Tree is rendered
    // as a flat <ul> where descendant depth = paddingLeft (depth*14 + 6),
    // so an ancestor is any earlier row with strictly smaller paddingLeft.
    const visible = new Set<HTMLElement>(directHit);
    for (const hit of directHit) {
      const hitDepth = parseFloat(hit.style.paddingLeft || '0') || 0;
      let prev = hit.previousElementSibling as HTMLElement | null;
      let needDepth = hitDepth;
      while (prev) {
        const d = parseFloat(prev.style.paddingLeft || '0') || 0;
        if (d < needDepth) {
          visible.add(prev);
          needDepth = d;
          if (d <= 6) break; // reached root level
        }
        prev = prev.previousElementSibling as HTMLElement | null;
      }
    }

    rows.forEach((r) => { if (!visible.has(r)) r.hidden = true; });
  }

  private renderDirChildren(dirPath: string, ul: HTMLElement, depth: number): void {
    const dir = this.cache.get(dirPath);
    if (!dir) return; // not loaded yet — caller hasn't expanded
    if (dir.error) {
      const li = document.createElement('li');
      li.className = 'tree-row tree-row-error';
      li.style.paddingLeft = `${(depth + 1) * 14 + 6}px`;
      li.textContent = `⚠ ${dir.error}`;
      ul.append(li);
      return;
    }
    const visible = this.showHidden
      ? dir.entries
      : dir.entries.filter((e) => !e.isHidden);
    for (const entry of visible) {
      ul.append(this.renderEntry(entry, depth));
      if (entry.isDir && (this.expanded.has(entry.path) || this.filterQuery)) {
        this.renderDirChildren(entry.path, ul, depth + 1);
      }
    }
  }

  private renderEntry(entry: DirEntry, depth: number): HTMLElement {
    const li = document.createElement('li');
    li.className = 'tree-row';
    li.dataset.path = entry.path;
    li.dataset.kind = entry.kind;
    if (entry.isDir) li.dataset.dir = 'true';
    if (entry.isHidden) li.classList.add('is-hidden-entry');
    if (!entry.isDir && entry.kind !== 'pdf' && entry.kind !== 'md' && entry.kind !== 'html' && entry.kind !== 'docx') li.classList.add('is-dimmed');
    // The chevron + icon + label sit in a single row; padding-left scales
    // with depth so nested folders read as a tree without an explicit
    // guide-line treatment (cheap; matches Obsidian/VS Code defaults).
    li.style.paddingLeft = `${depth * 14 + 6}px`;
    li.tabIndex = 0;
    li.setAttribute('role', 'treeitem');

    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    if (entry.isDir) {
      chevron.textContent = this.expanded.has(entry.path) ? '▾' : '▸';
    } else {
      // Leaves render a blank chevron slot so file names align under their
      // sibling folders. Without this, the icon column slides left.
      chevron.textContent = '';
      chevron.classList.add('tree-chevron-blank');
    }

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = entry.isDir ? '📁' : iconFor(entry.kind);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = entry.name;
    label.title = entry.name;

    li.append(chevron, icon, label);

    if (entry.isDir) {
      li.addEventListener('click', () => { void this.toggleExpand(entry.path); });
    } else if (entry.kind === 'pdf' || entry.kind === 'md' || entry.kind === 'html' || entry.kind === 'docx') {
      li.addEventListener('click', () => { this.opts.onOpenFile(entry.path); });
    }
    // Enter on a focused row matches click behavior — keyboard parity.
    li.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      if (entry.isDir) void this.toggleExpand(entry.path);
      else if (entry.kind === 'pdf' || entry.kind === 'md' || entry.kind === 'html' || entry.kind === 'docx') this.opts.onOpenFile(entry.path);
    });
    return li;
  }

  private refreshActiveRow(): void {
    this.opts.body.querySelectorAll<HTMLElement>('.tree-row.is-active').forEach((el) => {
      el.classList.remove('is-active');
    });
    if (!this.activePath) return;
    const row = this.opts.body.querySelector<HTMLElement>(
      `.tree-row[data-path="${CSS.escape(this.activePath)}"]`
    );
    if (row) row.classList.add('is-active');
  }
}

function iconFor(kind: DirEntry['kind']): string {
  switch (kind) {
    case 'pdf': return '📄';
    case 'md':  return '📝';
    case 'html': return '🌐';
    case 'docx':return '📃';
    default:    return '·';
  }
}

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}
