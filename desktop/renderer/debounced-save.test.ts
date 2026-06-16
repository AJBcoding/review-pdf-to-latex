import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DebouncedSave,
  drainAllDebouncedSaves,
  pendingDebouncedSaveCount,
} from './debounced-save';

// Every saver auto-registers into a module-global drain registry, so tests
// must dispose what they create to keep the registry clean between cases
// (drainAllDebouncedSaves / pendingDebouncedSaveCount see all live instances).
const created: DebouncedSave[] = [];
function makeSave(delayMs: number, flush: () => Promise<void> | void): DebouncedSave {
  const s = new DebouncedSave(delayMs, flush);
  created.push(s);
  return s;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  for (const s of created) s.dispose();
  created.length = 0;
});

describe('DebouncedSave', () => {
  it('coalesces rapid schedule() calls into a single flush', () => {
    const flush = vi.fn();
    const save = makeSave(100, flush);

    save.schedule();
    vi.advanceTimersByTime(40);
    save.schedule(); // resets the 100ms window
    vi.advanceTimersByTime(40); // only 40ms since the reset
    expect(flush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(60); // now 100ms past the last schedule
    expect(flush).toHaveBeenCalledTimes(1);
    expect(save.pending).toBe(false);
  });

  it('reports pending between schedule and fire', () => {
    const save = makeSave(100, vi.fn());
    expect(save.pending).toBe(false);
    save.schedule();
    expect(save.pending).toBe(true);
    vi.advanceTimersByTime(100);
    expect(save.pending).toBe(false);
  });

  it('flush() runs the pending write immediately and clears the timer', async () => {
    const flush = vi.fn();
    const save = makeSave(100, flush);

    save.schedule();
    await save.flush();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(save.pending).toBe(false);

    // The original timer must not also fire after a manual flush.
    vi.advanceTimersByTime(200);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('flush() is a no-op when nothing is pending', async () => {
    const flush = vi.fn();
    const save = makeSave(100, flush);
    await save.flush();
    expect(flush).not.toHaveBeenCalled();
  });

  it('cancel() drops a pending write without running it', () => {
    const flush = vi.fn();
    const save = makeSave(100, flush);
    save.schedule();
    save.cancel();
    expect(save.pending).toBe(false);
    vi.advanceTimersByTime(200);
    expect(flush).not.toHaveBeenCalled();
  });
});

describe('drain registry', () => {
  it('drainAllDebouncedSaves flushes every pending saver and awaits async writes', async () => {
    const order: string[] = [];
    const a = makeSave(100, async () => {
      await Promise.resolve();
      order.push('a');
    });
    const b = makeSave(250, () => {
      order.push('b');
    });
    // A registered-but-never-scheduled saver: it must NOT flush on drain.
    makeSave(100, () => {
      order.push('idle');
    });

    a.schedule();
    b.schedule();

    expect(pendingDebouncedSaveCount()).toBe(2);
    await drainAllDebouncedSaves();

    expect(order.sort()).toEqual(['a', 'b']); // both pending savers ran
    expect(order).not.toContain('idle');
    expect(pendingDebouncedSaveCount()).toBe(0);
    expect(a.pending).toBe(false);
    expect(b.pending).toBe(false);
  });

  it('dispose() removes a saver from the registry', () => {
    const save = makeSave(100, vi.fn());
    save.schedule();
    expect(pendingDebouncedSaveCount()).toBe(1);
    save.dispose();
    expect(pendingDebouncedSaveCount()).toBe(0);
  });
});
