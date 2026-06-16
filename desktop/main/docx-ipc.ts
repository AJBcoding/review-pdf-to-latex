// ─── §5.3 / L5 native DOCX comments IPC surface ────────────────────────────
//
// Thin invoke wrappers around the `docx-comments.ts` adapter. The adapter owns
// all the OOXML work (run-splitting, marker insertion, the zip round-trip); this
// module only bridges it to the renderer and normalizes the adapter's result
// shapes into the discriminated `DocxComment*Result` unions the contract
// declares. Call registerDocxIpc() once inside `app.whenReady()`.
//
// Native-docx comments are a READ PROJECTION of the source .docx (mirroring the
// native-pdf annotation flow): the renderer reads them on open, surfaces them as
// cards, and never freezes them into the drafts sidecar. Create/edit/delete
// mutate the file in place (the adapter writes atomically); the renderer
// re-opens the doc afterward to pick up the new bytes and minted `w:id`s.

import { resolve } from 'node:path';
import { typedHandle } from './typed-ipc.js';
import { assertObjectArg, assertPathArg, assertStringArg } from './ipc-validators.js';
import {
  readDocxComments as readDocxCommentsFromFile,
  createDocxComment as createDocxCommentInFile,
  editDocxComment as editDocxCommentInFile,
  deleteDocxComment as deleteDocxCommentInFile,
} from './docx-comments.js';
import type {
  DocxCommentsReadResult,
  DocxCommentWriteResult,
} from '@shared/comments';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Register the four `docx:` invoke handlers. `ipcMain.handle` throws on a
 *  duplicate channel, so call this exactly once. */
export function registerDocxIpc(): void {
  // Read native comments out of a .docx, mapped to native-docx CommentPayloads.
  // `docVersion` becomes the payloads' doc_version (the renderer passes the
  // doc's sha256); `docId` is the resolved path. A missing comments part yields
  // an empty array — only a real I/O / zip failure is `read_failed`.
  typedHandle(
    'readDocxComments',
    async (_event, docPath, docVersion): Promise<DocxCommentsReadResult> => {
      const resolvedPath = resolve(docPath);
      try {
        const comments = await readDocxCommentsFromFile(resolvedPath, {
          docId: resolvedPath,
          docVersion,
        });
        return { ok: true, comments };
      } catch (err) {
        return { ok: false, reason: 'read_failed', error: errMessage(err) };
      }
    },
    ([docPath, docVersion]) => {
      assertPathArg('docx:readComments', docPath);
      assertStringArg('docx:readComments docVersion', docVersion);
    },
  );

  // Create a comment over the request's text-quote anchor. The adapter resolves
  // the anchor against the document's run text; an unresolvable anchor or an
  // empty document come back as typed failures rather than throws.
  typedHandle(
    'createDocxComment',
    async (_event, request): Promise<DocxCommentWriteResult> => {
      const resolvedPath = resolve(request.docPath);
      try {
        const res = await createDocxCommentInFile(resolvedPath, {
          anchor: request.anchor,
          commentText: request.commentText,
          author: request.author,
        });
        if (res.ok) return { ok: true, commentId: String(res.commentId) };
        return { ok: false, reason: res.reason, error: `create failed: ${res.reason}` };
      } catch (err) {
        return { ok: false, reason: 'write_failed', error: errMessage(err) };
      }
    },
    ([request]) => assertObjectArg('docx:createComment', request),
  );

  // Edit a native comment's body text. The adapter returns `{ ok: false }` when
  // no comment carries the given `w:id` (or there's no comments part); surface
  // that as `not_found`.
  typedHandle(
    'editDocxComment',
    async (_event, request): Promise<DocxCommentWriteResult> => {
      const resolvedPath = resolve(request.docPath);
      try {
        const res = await editDocxCommentInFile(resolvedPath, request.commentId, request.newText);
        if (res.ok) return { ok: true, commentId: request.commentId };
        return { ok: false, reason: 'not_found', error: `no comment with id ${request.commentId}` };
      } catch (err) {
        return { ok: false, reason: 'write_failed', error: errMessage(err) };
      }
    },
    ([request]) => assertObjectArg('docx:editComment', request),
  );

  // Delete a native comment and its document markers.
  typedHandle(
    'deleteDocxComment',
    async (_event, request): Promise<DocxCommentWriteResult> => {
      const resolvedPath = resolve(request.docPath);
      try {
        const res = await deleteDocxCommentInFile(resolvedPath, request.commentId);
        if (res.ok) return { ok: true, commentId: request.commentId };
        return { ok: false, reason: 'not_found', error: `no comment with id ${request.commentId}` };
      } catch (err) {
        return { ok: false, reason: 'write_failed', error: errMessage(err) };
      }
    },
    ([request]) => assertObjectArg('docx:deleteComment', request),
  );
}
