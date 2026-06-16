// @vitest-environment jsdom
//
// Behavioral test for the debounced filter walk (rev-m4l7).
//
// `FileTree.setFilter` used to fire a full recursive `loadAllForFilter()` +
// `render()` on every keystroke. On a large tree that walk reads every
// subdirectory, so fast typing issued one walk per character. The walk is now
// debounced: rapid input coalesces into a single deferred walk, and clearing
// the filter cancels any pending walk and applies immediately.
//
// These tests drive the public API (`setRoot` / `setFilter`) with fake timers
// and observe the walk through the mocked `listDir` IPC — the walk reads an
// uncached subdirectory, so a `listDir` call for it is the signal that the
// walk actually ran.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirEntry } from '@shared/files';
import type { ListDirResult } from '@shared/files';
import { FileTree } from './tree';

const ROOT = '/repo';
const SUB = '/repo/src';

function dirEntry(path: string, isDir: boolean): DirEntry {
  return {
    name: path.slice(path.lastIndexOf('/') + 1),
    path,
    isDir,
    isHidden: false,
    kind: isDir ? 'other' : 'pdf',
  };
}

// Listing: the root holds one subdir (`/repo/src`) which itself holds a file.
// `setRoot` pre-loads only the root, so `/repo/src` stays uncached until a
// filter walk reaches it — making `listDir(SUB)` the observable for the walk.
function listing(path: string): ListDirResult {
  if (path === ROOT) {
    return { ok: true, path, entries: [dirEntry(SUB, true)] };
  }
  if (path === SUB) {
    return { ok: true, path, entries: [dirEntry('/repo/src/main.pdf', false)] };
  }
  return { ok: true, path, entries: [] };
}

let listDir: ReturnType<typeof vi.fn>;

function makeTree(): FileTree {
  const body = document.createElement('div');
  const title = document.createElement('div');
  const empty = document.createElement('div');
  const toggleHiddenBtn = document.createElement('button');
  return new FileTree({
    body,
    title,
    empty,
    toggleHiddenBtn,
    onOpenFile: vi.fn(),
    onStateChange: vi.fn(),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  listDir = vi.fn((path: string) => Promise.resolve(listing(path)));
  // jsdom provides `window`; the tree reads `window.electronAPI.listDir`.
  (window as unknown as { electronAPI: unknown }).electronAPI = { listDir };
});

afterEach(() => {
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('FileTree filter walk debounce', () => {
  it('does not walk subdirectories synchronously on a keystroke', async () => {
    const tree = makeTree();
    await tree.setRoot(ROOT, { silent: true });
    listDir.mockClear();

    tree.setFilter('m');
    // The walk is deferred — nothing reads /repo/src until the window elapses.
    expect(listDir).not.toHaveBeenCalledWith(SUB);

    await vi.advanceTimersByTimeAsync(150);
    expect(listDir).toHaveBeenCalledWith(SUB);
  });

  it('coalesces rapid keystrokes into a single walk', async () => {
    const tree = makeTree();
    await tree.setRoot(ROOT, { silent: true });
    listDir.mockClear();

    tree.setFilter('m');
    await vi.advanceTimersByTimeAsync(100); // < 150ms window
    tree.setFilter('ma'); // resets the window
    await vi.advanceTimersByTimeAsync(100); // only 100ms since the reset
    expect(listDir).not.toHaveBeenCalledWith(SUB);

    await vi.advanceTimersByTimeAsync(60); // now 160ms past the last keystroke
    const subWalks = listDir.mock.calls.filter(([p]) => p === SUB).length;
    expect(subWalks).toBe(1);
  });

  it('cancels a pending walk when the filter is cleared', async () => {
    const tree = makeTree();
    await tree.setRoot(ROOT, { silent: true });
    listDir.mockClear();

    tree.setFilter('m');
    tree.setFilter(''); // clear before the window elapses
    await vi.advanceTimersByTimeAsync(200);
    expect(listDir).not.toHaveBeenCalledWith(SUB);
  });
});
