// Shared reviewer-rig gating for both embedded-Claude routes.
//
// X8 Stage 3.5 (OD-3 convergence): the reviewer-rig enablement gate lived
// ONLY in claude-pty.ts — probeReviewer() decided, via `gt --version`, whether
// a spawned claude session belongs to the gas-town Reviewer rig, and
// buildPtyEnv() applied that decision by setting GT_RIG=reviewer. The SDK
// worker-spawn path (agent-pane-ipc.ts → claude-backend.ts) had the worker cap
// but no equivalent gate, so retiring claude-pty.ts in stage 4 would have
// deleted reviewer-rig enablement detection with no SDK replacement.
//
// This module is the single source of truth both routes call so the gate is
// decided AND applied identically regardless of route:
//   - probeReviewer()       → gt presence (§9.2.5) + best-effort identity
//   - reviewerEnvOverlay()  → the gate → env decision (GT_RIG=reviewer)
//
// Pure of electron (only node built-ins) so it unit-tests without a host.

import { spawnSync as spawnSyncBlocking } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type ReviewerProbe } from '@shared/pty';

/** Resolve a binary name via PATH. Returns absolute path or null. Mirrors
 *  `which` semantics — checks each PATH entry for an executable file. */
export function whichSync(bin: string): string | null {
  const PATH = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/${bin}${ext.toLowerCase()}`;
      try {
        if (existsSync(candidate)) return candidate;
      } catch { /* PATH entry unreadable */ }
    }
  }
  return null;
}

/** Cached reviewer probe; only re-run if forced (no real path to a gt install
 *  during a session, so caching is safe). Shared across both routes so the
 *  `gt --version`/`gt whoami` round-trip runs at most once per app run. */
let reviewerProbeCache: ReviewerProbe | null = null;

/** Run `gt --version` (the canonical presence check per §9.2.5). Fast, no
 *  Dolt touch. Identity comes from `gt whoami` only when presence shows
 *  enabled — we don't pre-emptively touch it. Cached. */
export function probeReviewer(): ReviewerProbe {
  if (reviewerProbeCache) return reviewerProbeCache;
  const gtPath = whichSync('gt');
  if (!gtPath) {
    reviewerProbeCache = { enabled: false, reason: 'no_gt' };
    return reviewerProbeCache;
  }
  // 2s timeout — `gt --version` should be sub-second; anything slower means
  // gt is wedged and we'd rather degrade than block app startup.
  const r = spawnSyncBlocking(gtPath, ['--version'], { timeout: 2000, encoding: 'utf8' });
  if (r.status !== 0) {
    reviewerProbeCache = { enabled: false, reason: 'gt_failed', gtPath, exitCode: r.status };
    return reviewerProbeCache;
  }
  const version = (r.stdout || '').trim();
  // Identity probe — `gt whoami` is reserved for *display*, not gating. We
  // run it here so the Settings UI can show it without a second round-trip.
  // If it fails, the pane still gets a Reviewer rig — the identity label is
  // best-effort.
  let identity: string | null = null;
  const w = spawnSyncBlocking(gtPath, ['whoami'], { timeout: 2000, encoding: 'utf8' });
  if (w.status === 0) identity = (w.stdout || '').trim() || null;
  reviewerProbeCache = { enabled: true, gtPath, version, identity };
  return reviewerProbeCache;
}

/** The gate → env decision, shared by both routes. When the reviewer rig is
 *  enabled the spawned claude session joins it via GT_RIG=reviewer; otherwise
 *  no overlay (degrade paths no_gt / gt_failed leave the env untouched). The
 *  pty route merges this into its full pty env (plus TERM); the SDK route
 *  merges it over process.env for query()'s `env` option. */
export function reviewerEnvOverlay(reviewer: ReviewerProbe): Record<string, string> {
  return reviewer.enabled ? { GT_RIG: 'reviewer' } : {};
}

/** Test seam — clear the cached probe so the next call re-runs `gt`. */
export function _resetReviewerProbeCacheForTests(): void {
  reviewerProbeCache = null;
}
