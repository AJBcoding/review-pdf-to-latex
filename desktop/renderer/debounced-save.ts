// L11: shared debounced-save utility + drain registry.
//
// The renderer ran three near-identical debounced writers — the .md source
// save, the drafts sidecar write, and the app-state save. Each hand-rolled the
// same `let timer; if (timer !== null) clearTimeout(timer); timer = setTimeout(
// () => { timer = null; void flush(); }, ms)` shape, and each quit/teardown
// site that needed to drain a pending write re-implemented the same
// `if (timer !== null) { clearTimeout(timer); timer = null; flush() }` block —
// once per saver, copied across the quit handshake, `beforeunload`, the bundle
// write, the md-blur, and the doc-switch teardown.
//
// `DebouncedSave` encapsulates the timer mechanics so the call sites carry
// none of it, and every instance auto-registers into a module-level drain
// registry. `drainAllDebouncedSaves()` flushes every pending writer in one
// call — so the quit path no longer has to know which savers exist (it used to
// drain drafts + md but silently left app-state to be lost on quit).

/** A pending write to run when the debounce window elapses. May be sync or
 *  async; `flush()` awaits the returned promise so quit/teardown callers can
 *  wait for the write to actually hit disk. */
type FlushFn = () => Promise<void> | void;

const registry = new Set<DebouncedSave>();

/** A single debounced writer: schedule coalesces rapid calls into one deferred
 *  flush; `flush()` runs the pending write immediately (used at teardown). The
 *  pre-schedule UI side effects each saver had (modified-dot, "saving"
 *  indicator) stay at the call site — this owns only the timer + the write. */
export class DebouncedSave {
  private timer: number | null = null;

  constructor(
    private readonly delayMs: number,
    private readonly flushFn: FlushFn,
  ) {
    registry.add(this);
  }

  /** True when a write is queued but not yet flushed. */
  get pending(): boolean {
    return this.timer !== null;
  }

  /** (Re)arm the debounce. A prior pending timer is cancelled so only the last
   *  call within the window writes. */
  schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushFn();
    }, this.delayMs) as unknown as number;
  }

  /** Cancel any pending write without running it. */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Run the pending write now (cancelling the timer first), awaiting it. A
   *  no-op resolving immediately when nothing is pending — so call sites can
   *  unconditionally `await save.flush()` at teardown without a guard. */
  async flush(): Promise<void> {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    await this.flushFn();
  }

  /** Drop this saver from the drain registry (and cancel any pending write).
   *  For savers that outlive a single document; the renderer's three live for
   *  the whole session, so this is mainly for tests. */
  dispose(): void {
    this.cancel();
    registry.delete(this);
  }
}

/** Flush every registered saver that has a write pending, concurrently, and
 *  wait for them all. The single drain point for quit / window-close /
 *  `beforeunload`: callers no longer enumerate individual savers, so a newly
 *  added debounced writer is drained at quit automatically. */
export async function drainAllDebouncedSaves(): Promise<void> {
  const flushes: Promise<void>[] = [];
  for (const save of registry) {
    if (save.pending) flushes.push(save.flush());
  }
  await Promise.all(flushes);
}

/** Number of savers with a pending write. Exposed for tests / diagnostics. */
export function pendingDebouncedSaveCount(): number {
  let n = 0;
  for (const save of registry) {
    if (save.pending) n += 1;
  }
  return n;
}
