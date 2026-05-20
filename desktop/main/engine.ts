// Engine spawn layer.
//
// The Electron app talks to the Python engine through one function — runEngine(args).
// PATH-discovery resolution chain follows spec §13.1 (2026-05-19-electron-app-ux-spec.md):
//
//   1. user override (env var REVIEW_PDF_ENGINE_PATH; settings-file override is a later milestone)
//   2. `review-pdf` on PATH
//   3. repo-local .venv/bin/review-pdf (resolved relative to the app's cwd)
//   4. ~/.venvs/review-pdf-to-latex/bin/review-pdf
//
// If none resolve, the renderer gets a structured `not_found` result containing the
// chain that was tried, so the load-time banner can show a useful message
// ("set the engine path in Settings or run `pip install -e .` in the repo").

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { delimiter } from 'node:path';

export type EngineResolution =
  | { ok: true; resolvedPath: string; via: ResolutionStep }
  | { ok: false; triedPaths: ResolutionAttempt[] };

export type ResolutionStep =
  | 'env_override'
  | 'path'
  | 'repo_venv'
  | 'home_venv';

export interface ResolutionAttempt {
  step: ResolutionStep;
  path: string;
}

export type EngineResult =
  | {
      ok: true;
      stdout: string;
      stderr: string;
      exitCode: number;
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: 'not_found';
      triedPaths: ResolutionAttempt[];
    }
  | {
      ok: false;
      reason: 'spawn_failed';
      error: string;
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: 'failed';
      stdout: string;
      stderr: string;
      exitCode: number | null;
      resolvedPath: string;
    }
  | {
      ok: false;
      reason: 'timeout';
      resolvedPath: string;
      timeoutMs: number;
    };

const ENGINE_BIN = 'review-pdf';
const DEFAULT_TIMEOUT_MS = 5_000;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findOnPath(): Promise<string | null> {
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, ENGINE_BIN);
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk the §13.1 resolution chain and return the first executable hit,
 * or a failure result naming every path attempted.
 */
export async function resolveEngine(): Promise<EngineResolution> {
  const attempts: ResolutionAttempt[] = [];

  // 1. env override
  const override = process.env.REVIEW_PDF_ENGINE_PATH;
  if (override) {
    const resolved = resolve(override);
    attempts.push({ step: 'env_override', path: resolved });
    if (await isExecutable(resolved)) {
      return { ok: true, resolvedPath: resolved, via: 'env_override' };
    }
  }

  // 2. PATH
  const fromPath = await findOnPath();
  if (fromPath) {
    attempts.push({ step: 'path', path: fromPath });
    return { ok: true, resolvedPath: fromPath, via: 'path' };
  }
  attempts.push({ step: 'path', path: `<not found in PATH>` });

  // 3. repo-local .venv — search up from cwd a few levels.
  // In dev `npm run dev` runs from desktop/, so the repo root is one level up.
  // In a packaged app, cwd is wherever the user launched from; we still try a few levels.
  const cwd = process.cwd();
  for (let depth = 0; depth <= 3; depth++) {
    const ascended = depth === 0 ? cwd : join(cwd, ...Array(depth).fill('..'));
    const candidate = resolve(ascended, '.venv/bin', ENGINE_BIN);
    attempts.push({ step: 'repo_venv', path: candidate });
    if (await isExecutable(candidate)) {
      return { ok: true, resolvedPath: candidate, via: 'repo_venv' };
    }
  }

  // 4. ~/.venvs/review-pdf-to-latex/bin/review-pdf
  const homeVenv = join(homedir(), '.venvs/review-pdf-to-latex/bin', ENGINE_BIN);
  attempts.push({ step: 'home_venv', path: homeVenv });
  if (await isExecutable(homeVenv)) {
    return { ok: true, resolvedPath: homeVenv, via: 'home_venv' };
  }

  return { ok: false, triedPaths: attempts };
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  // env vars merged over process.env; useful for test isolation.
  env?: Record<string, string>;
}

/**
 * Spawn the engine with the given args. Returns a structured result instead of
 * throwing — IPC layers serialize discriminated unions cleanly; thrown errors
 * lose their typing across the contextBridge.
 */
export async function runEngine(args: string[], opts: RunOptions = {}): Promise<EngineResult> {
  const resolution = await resolveEngine();
  if (!resolution.ok) {
    return { ok: false, reason: 'not_found', triedPaths: resolution.triedPaths };
  }
  const { resolvedPath } = resolution;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<EngineResult>((resolvePromise) => {
    let settled = false;
    const settle = (result: EngineResult) => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };

    let child;
    try {
      child = spawn(resolvedPath, args, {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      settle({
        ok: false,
        reason: 'spawn_failed',
        error: err instanceof Error ? err.message : String(err),
        resolvedPath,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle({ ok: false, reason: 'timeout', resolvedPath, timeoutMs });
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      settle({
        ok: false,
        reason: 'spawn_failed',
        error: err.message,
        resolvedPath,
      });
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      if (exitCode === 0) {
        settle({ ok: true, stdout, stderr, exitCode, resolvedPath });
      } else {
        settle({
          ok: false,
          reason: 'failed',
          stdout,
          stderr,
          exitCode,
          resolvedPath,
        });
      }
    });
  });
}

/**
 * Convenience: get the engine version string via `review-pdf --version`.
 * Used by the renderer at startup to surface engine identity in the diagnostic
 * (and, when version-check-banner UX lands, to compare against expected ranges).
 */
export async function engineVersion(): Promise<EngineResult> {
  return runEngine(['--version']);
}

/**
 * Strongly-typed view of the `review-pdf pdf-health --json` report.
 * Re-exported from shared/types so callers in main can import from one place.
 */
export interface PdfHealthReport {
  schema_version: 1;
  pdf_path: string | null;
  total_pages: number | null;
  readable_pages: number[];
  unreadable_pages: number[];
  ligature_loss_detected: boolean;
  encrypted: boolean;
  producer: string | null;
  creator: string | null;
  page_errors: { page: number; error: string }[];
  error: string | null;
}

export type PdfHealthResult =
  | { ok: true; report: PdfHealthReport; exitCode: number; resolvedPath: string }
  | { ok: false; reason: 'engine_failed'; engine: EngineResult };

/**
 * Run `review-pdf pdf-health --pdf <path> --json` and parse the JSON report.
 *
 * The pdf-health engine subcommand emits exit codes 0 (ok) / 2 (missing) /
 * 21 (encrypted), and in all three cases prints a parseable JSON report. We
 * accept all of those as `ok: true` because the report itself describes the
 * outcome. Only true engine failures (binary not found, spawn errored, parse
 * failed) bubble up as `ok: false`.
 */
export async function pdfHealth(pdfPath: string): Promise<PdfHealthResult> {
  const engine = await runEngine(['pdf-health', '--pdf', pdfPath, '--json'], {
    timeoutMs: 30_000,  // walking a many-page PDF can take seconds; be generous.
  });

  // pdf-health emits JSON on stdout regardless of exit code. Even the
  // "missing file" and "encrypted" exit codes carry a partial report.
  const successfulExits = new Set([0, 2, 21]);
  if (
    (engine.ok || (!engine.ok && engine.reason === 'failed' && engine.exitCode !== null && successfulExits.has(engine.exitCode)))
  ) {
    const stdout = engine.ok ? engine.stdout : engine.stdout;
    const exitCode = engine.ok ? engine.exitCode : (engine.reason === 'failed' ? (engine.exitCode ?? -1) : -1);
    const resolvedPath = engine.ok ? engine.resolvedPath : (engine.reason === 'failed' ? engine.resolvedPath : '');
    try {
      const report = JSON.parse(stdout) as PdfHealthReport;
      return { ok: true, report, exitCode, resolvedPath };
    } catch {
      // Engine exited but stdout wasn't JSON — treat as engine failure.
      return { ok: false, reason: 'engine_failed', engine };
    }
  }

  return { ok: false, reason: 'engine_failed', engine };
}
