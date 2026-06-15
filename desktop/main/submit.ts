// §10.1 Submit flow — main-process implementation.
//
// Three operations, all exposed via IPC:
//   1. promoteDraft()  — write `.review-state/submit-<ts>.json` from the
//      current draft, flip `open` entries to `submitted` in the frozen copy.
//   2. slingViaGtMail() — spawn `gt mail send` with the rev-2k7 payload
//      shape; pipe the JSON body via --stdin to avoid shell-quoting bugs.
//   3. abandonRound() — rename `results-<ts>.json` → `results-<ts>.abandoned.json`
//      (§10.1 step 6 soft tombstone — partial results preserved).
//
// The pending_send / sent_unconfirmed state machine lives in the renderer.
// Main reports the raw process result; the renderer drives the UI
// transitions and pairs the eventual results-file appearance with the
// submit_id via the existing results-watcher (rev-1md.5).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { atomicWriteJson } from './atomic-write.js';
import type {
  SubmitAbandonRequest,
  SubmitAbandonResult,
  SubmitFile,
  SubmitPromoteRequest,
  SubmitPromoteResult,
  SubmitSlingRequest,
  SubmitSlingResult,
  CommentPayload,
} from '@shared/types';
import { downConvertSubmitFileToV1 } from '@shared/comments';

const GT_MAIL_TIMEOUT_MS = 30_000;
const DEFAULT_SUBJECT_PREFIX = 'review-pdf submit';

/** Mint a submit_id in the same `YYYYMMDD-HHmmss` UTC shape the bundle id
 *  uses (see shared/bundle.ts mintBundleId). Distinct from bundleId in
 *  semantics — bundleId identifies the deliverable artifact; submitId
 *  identifies the round of work the user just packaged. */
function mintSubmitId(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

/** Resolve `gt` via PATH. Returns absolute path or null. Mirrors the
 *  pattern in claude-pty.ts:whichSync — kept inline rather than shared so
 *  the two modules stay decoupled (claude-pty's lifetime is much longer-
 *  lived than a submit invocation). */
function whichGt(): string | null {
  const PATH = process.env.PATH ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : [''];
  for (const dir of PATH.split(sep)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = `${dir}/gt${ext.toLowerCase()}`;
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        // PATH entry unreadable
      }
    }
  }
  return null;
}

export async function promoteDraft(
  req: SubmitPromoteRequest,
): Promise<SubmitPromoteResult> {
  const date = new Date();
  const submitId = mintSubmitId(date);
  const sourcePath = resolve(req.sourcePath);
  const reviewStateDir = join(dirname(sourcePath), '.review-state');
  const submitFilePath = join(reviewStateDir, `submit-${submitId}.json`);
  const submittedAt = date.toISOString();

  try {
    await mkdir(reviewStateDir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      reason: 'mkdir_failed',
      error: err instanceof Error ? err.message : String(err),
      submitFilePath: null,
    };
  }

  // Promote only `open` entries to `submitted` — already-terminal entries
  // (applied / build_failed / etc. from a previous round) are preserved
  // as-is in the frozen submit copy. The renderer mirrors only the actual
  // status flips back onto live drafts.
  const statusUpdates: { commentId: string; submittedAt: string }[] = [];
  const frozenComments: CommentPayload[] = req.comments.map((c) => {
    const status = c.status ?? 'open';
    if (status === 'open') {
      statusUpdates.push({ commentId: c.id, submittedAt });
      return { ...c, status: 'submitted', submitted_at: submittedAt };
    }
    return { ...c };
  });

  // In-memory submit file is v2 (its comments carry the anchor union). What we
  // WRITE to disk during the rollout window (§4.4 step 1) is the v2→v1
  // down-conversion: `pdf-quad` → `{page, region}`, native.comment_id →
  // pdf_annotation_id. The submit-WRITER flip to v2 is gated on an OBSERVED
  // rig-written schema_version:2 results file (§4.4 step 3) and is NOT done
  // here — sufficient because only PDF rounds promote during the window.
  const submitFile: SubmitFile = {
    schema_version: 2,
    submit_id: submitId,
    doc_id: sourcePath,
    doc_version: req.sourceSha256,
    source_file_version: req.sourceFileVersion ?? '',
    submitted_at: submittedAt,
    origin_rig: req.originRig,
    bundle_pdf: req.bundlePdfPath,
    bundle_json: req.bundleJsonPath,
    comments: frozenComments,
  };

  try {
    await atomicWriteJson(submitFilePath, downConvertSubmitFileToV1(submitFile));
  } catch (err) {
    return {
      ok: false,
      reason: 'write_failed',
      error: err instanceof Error ? err.message : String(err),
      submitFilePath,
    };
  }

  return {
    ok: true,
    submitId,
    submitFilePath,
    submitFile,
    statusUpdates,
  };
}

/** Address the destination the gt mail way: `<rig>/` (broadcast to all
 *  agents in the rig). `reviewer-local` resolves to `reviewer/` so the
 *  user's own Reviewer rig picks it up — kept distinct from the literal
 *  rig name so the renderer / spec language can stay decoupled from gt's
 *  address grammar. */
function addressForDestination(destinationRig: string): string {
  if (destinationRig === 'reviewer-local') return 'reviewer/';
  // Already in `<rig>/` form? Pass through.
  if (destinationRig.endsWith('/')) return destinationRig;
  return `${destinationRig}/`;
}

/** Subject line per the rev-2k7 contract:
 *    review-pdf submit · <base>-<source_version> · <bundle_id>
 *  The rig matches on the prefix so renames here are user-facing only. */
function buildSubject(opts: {
  prefix: string;
  sourcePath: string;
  sourceFileVersion: string | null;
  bundleId: string;
}): string {
  // Derive a short `<base>-<source_version>` chunk from the source path —
  // if the filename didn't parse into a version, fall back to the bare
  // basename minus extension. Loose: the rig doesn't parse this field.
  const base = opts.sourcePath.replace(/^.*[\\/]/, '').replace(/\.[^./]+$/, '');
  // Source-file-version is already in the base via parseSourceName, so we
  // just use the source basename as-is and append the bundle id.
  return `${opts.prefix} · ${base} · ${opts.bundleId}`;
}

export async function slingViaGtMail(
  req: SubmitSlingRequest,
): Promise<SubmitSlingResult> {
  const gtBin = whichGt();
  if (!gtBin) {
    return {
      ok: false,
      reason: 'no_gt',
      message: '`gt` not found on PATH. Install gas-town or pick Reviewer (local).',
    };
  }

  const address = addressForDestination(req.destinationRig);
  const subject = buildSubject({
    prefix: req.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX,
    sourcePath: req.sourcePath,
    sourceFileVersion: null,
    bundleId: req.bundleId,
  });

  // rev-2k7 payload. Schema_version, kind, expected_skill are constant per
  // contract; the rest comes from the request. JSON.stringify with 2-space
  // indent so a human reading the gt mail body in the rig terminal can
  // eyeball the contents without piping through jq.
  const payload = JSON.stringify(
    {
      schema_version: 1,
      kind: 'review-pdf.submit',
      app_version: req.appVersion,
      bundle_id: req.bundleId,
      submit_id: req.submitId,
      origin_rig: req.originRig,
      destination_rig: req.destinationRig,
      source_doc: req.sourcePath,
      submit_file: req.submitFilePath,
      bundle_pdf: req.bundlePdfPath,
      bundle_json: req.bundleJsonPath,
      expected_skill: '/review-pdf process',
      submitted_at: new Date().toISOString(),
    },
    null,
    2,
  );

  const args = [
    'mail', 'send', address,
    '--type', 'task',
    '--priority', '1',
    '--permanent',
    '--subject', subject,
    '--stdin',
  ];

  let child;
  try {
    child = spawn(gtBin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
  child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });

  // Wrap the exit + timeout race in a promise. 30s matches §10.1 step 4's
  // gt-mail-exit deadline — local op; anything slower means gt is wedged.
  const result = await new Promise<SubmitSlingResult>((resolveResult) => {
    let settled = false;
    const settle = (r: SubmitSlingResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(r);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* already dead */ }
      settle({ ok: false, reason: 'timeout', timeoutMs: GT_MAIL_TIMEOUT_MS });
    }, GT_MAIL_TIMEOUT_MS);

    // Handle stdin errors (EPIPE, etc.) — these would crash the main process
    // if left unhandled. Route to settle path to cleanly report the error.
    child.stdin.on('error', (err) => {
      settle({
        ok: false,
        reason: 'stdin_error',
        error: err instanceof Error ? err.message : String(err),
      });
    });

    child.on('error', (err) => {
      settle({
        ok: false,
        reason: 'spawn_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    });
    child.on('close', (code) => {
      if (code === 0) {
        settle({
          ok: true,
          exitCode: 0,
          stdout,
          stderr,
          payload,
          subject,
        });
      } else {
        settle({
          ok: false,
          reason: 'gt_failed',
          exitCode: code ?? null,
          stdout,
          stderr,
        });
      }
    });

    // Pipe the payload to stdin, then close the stream so gt doesn't wait.
    // Error handlers above will catch any async errors from writing.
    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (err) {
      settle({
        ok: false,
        reason: 'stdin_write_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return result;
}

export async function abandonRound(
  req: SubmitAbandonRequest,
): Promise<SubmitAbandonResult> {
  const resolvedPath = resolve(req.resultsFilePath);
  if (!existsSync(resolvedPath)) {
    return { ok: false, reason: 'not_found', error: `not found: ${resolvedPath}` };
  }
  // The .abandoned suffix is a soft tombstone (§10.1 step 6 / §10.3). Match
  // the suffix in the rename — if the file already ends `.abandoned.json`
  // we no-op-rename to avoid double-tombstoning.
  if (resolvedPath.endsWith('.abandoned.json')) {
    return { ok: true, renamedTo: resolvedPath };
  }
  const renamedTo = resolvedPath.replace(/\.json$/, '.abandoned.json');
  try {
    await rename(resolvedPath, renamedTo);
    return { ok: true, renamedTo };
  } catch (err) {
    return {
      ok: false,
      reason: 'rename_failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
