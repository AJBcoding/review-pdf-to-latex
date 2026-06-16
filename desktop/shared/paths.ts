// Shared, pure cross-platform path helpers.
//
// `basename`/`dirnameOf` were hand-copied in three places (renderer/index.ts,
// renderer/tree.ts, shared/priming.ts as `basenameOf`) — byte-identical, each
// with the same "avoid dragging in a node path polyfill just for a title-bar
// label" comment. Single-sourced here so the next tweak (e.g. a UNC-path edge
// case) lands once. Pure string math, no node `path` import — works in the
// renderer (web), preload, and main alike.

/** Last path segment. Handles both POSIX (`/`) and Windows (`\`) separators;
 *  returns the whole string when there is no separator. */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Parent directory of a path. Returns `'/'` when the path has no parent
 *  segment (root-relative or bare name), mirroring the renderer's prior
 *  behavior. Handles both POSIX and Windows separators. */
export function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i > 0 ? p.slice(0, i) : '/';
}
