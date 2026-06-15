// Per-channel runtime validators for IPC invoke args.
//
// The renderer runs with contextIsolation + sandbox, so these args are
// normally well-typed by construction. The checks here are defense-in-depth:
// if a compromised or buggy renderer (or a future channel added without care —
// L3–L6 bring docx/html fs channels) hands main a malformed argument, we reject
// it with a clear, channel-attributed error instead of letting it reach `fs`
// or `spawn` and surface as a cryptic Node error across the IPC boundary.
//
// fs PATH-SCOPING: we deliberately do NOT confine paths to a fixed root. The
// app's core flow is opening arbitrary user-chosen PDFs and folders (the
// Obsidian model — see openFolderDialog / indexPdfs), so a root jail would
// break legitimate use. "Scoping" here means: every fs channel runs its path
// args through `assertPathArg`, which enforces they are non-empty strings free
// of NUL bytes (the classic path-truncation / injection vector — Node rejects
// NUL in paths, but we catch it early with an attributable message). New fs
// channels inherit this guard for free by validating through the same helper.

/** Assert an IPC arg is a usable filesystem path: a non-empty string with no
 *  NUL byte. `label` names the channel/param so a rejection is traceable. */
export function assertPathArg(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label}: expected a string path, got ${value === null ? 'null' : typeof value}`);
  }
  if (value.length === 0) {
    throw new RangeError(`${label}: empty path`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label}: path contains a NUL byte`);
  }
}

/** Assert an IPC arg is a string (no NUL/empty constraint — for non-path
 *  strings like the `ping` echo payload or a sha256 hex digest). */
export function assertStringArg(label: string, value: unknown): asserts value is string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label}: expected a string, got ${value === null ? 'null' : typeof value}`);
  }
  if (value.includes('\0')) {
    throw new Error(`${label}: string contains a NUL byte`);
  }
}

/** Assert an IPC arg is a plain object (the request-payload shape used by
 *  bundle:write, submit:*, pty:start, etc.). Rejects null and arrays. */
export function assertObjectArg(label: string, value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}: expected an object payload`);
  }
}
