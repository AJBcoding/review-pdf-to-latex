// Shared session-policy resolution for both embedded-Claude routes.
//
// X8 Stage 1 (OD-3 convergence): the cwd-anchoring and skip-permissions
// decisions were duplicated across claude-pty.ts (spawnConversational +
// spawnWorker) and missing entirely from the SDK route — claude-backend.ts
// passed no `cwd` to query() and had no way to express the skip-permissions
// setting. This module is the single source of truth both routes call, so the
// pty and SDK/agent-pane sessions anchor cwd and resolve skip-permissions the
// same way. Pure (no electron import) so it unit-tests without a host.

import { existsSync } from 'node:fs';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

/**
 * Resolve the working directory for a Claude session.
 *
 * §9.2.9 — anchor to the source dir of the doc the user opened so the session's
 * relative-path resolution is stable. Falls back to `fallbackDir` when the
 * source dir is absent or doesn't exist on disk (unsaved buffer, or a path that
 * vanished between open and spawn). The caller supplies `fallbackDir` (the pty
 * and agent-pane routes both pass `dirname(app.getPath('userData'))`) so this
 * stays free of the electron dependency.
 */
export function resolveSessionCwd(
  docSourceDir: string | undefined,
  fallbackDir: string,
): string {
  if (docSourceDir && existsSync(docSourceDir)) return docSourceDir;
  return fallbackDir;
}

/**
 * Resolve whether a session bypasses Claude's permission prompts.
 *
 * AJB ask (claude-pty.ts): default ON so a fresh source dir doesn't stall the
 * pane on the per-directory trust prompt. Opt back into prompts by passing
 * `false` explicitly (the Settings toggle). `undefined` → default ON.
 */
export function resolveSkipPermissions(flag: boolean | undefined): boolean {
  return flag !== false;
}

/** CLI args for the pty route's `claude` spawn given a skip-permissions decision. */
export function ptySkipPermissionArgs(skipPermissions: boolean): string[] {
  return skipPermissions ? ['--dangerously-skip-permissions'] : [];
}

export interface SdkPermissionOptions {
  permissionMode: PermissionMode;
  allowDangerouslySkipPermissions?: boolean;
}

/**
 * Map a skip-permissions decision to Claude Agent SDK `query()` options.
 *
 * skip → `bypassPermissions` plus the SDK-required
 * `allowDangerouslySkipPermissions` safety flag; the SDK then never invokes
 * canUseTool, mirroring the pty route's `--dangerously-skip-permissions`. Not
 * skipping → `'default'` so the route's canUseTool permission hooks (the SDK
 * route's structural advantage per OD-3) stay active. The caller is
 * responsible for only wiring `canUseTool` into query() when the mode is
 * `'default'` — under bypass it would be dead weight.
 */
export function sdkPermissionOptions(
  skipPermissions: boolean,
): SdkPermissionOptions {
  return skipPermissions
    ? {
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      }
    : { permissionMode: 'default' };
}
