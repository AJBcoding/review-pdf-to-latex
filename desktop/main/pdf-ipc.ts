// ─── §5.1 / L4 native PDF comments IPC surface ─────────────────────────────
//
// Thin invoke wrappers around the `pdf-comments.ts` adapter. The adapter owns
// all the pdf-lib work (annotation building, /QuadPoints, reply /IRT cascade,
// the load/save round-trip); this module only bridges it to the renderer and
// normalizes the adapter's result shapes into the discriminated
// `PdfComment*Result` unions the contract declares. Call registerPdfIpc() once
// inside `app.whenReady()`.
//
// Native-pdf comments are a READ PROJECTION of the source PDF (the twin of the
// native-docx flow): the renderer reads them on open, surfaces them as cards,
// and never freezes them into the drafts sidecar. Reading goes through the SAME
// adapter as edit/delete — so a card's `(page_index, annot_index)` handle comes
// from the very pdf-lib walk that a later edit/delete locates against, keeping
// the fallback handle valid even for annots that lack a stable /NM. Create/edit/
// delete mutate the file in place (the adapter writes atomically); the renderer
// re-opens the doc afterward to pick up the new bytes and any minted /NM.

import { resolve } from 'node:path';
import { typedHandle } from './typed-ipc.js';
import { assertObjectArg, assertPathArg, assertStringArg } from './ipc-validators.js';
import {
  readPdfComments as readPdfCommentsFromFile,
  writePdfComments as writePdfCommentsToFile,
  editPdfComment as editPdfCommentInFile,
  deletePdfComment as deletePdfCommentFromFile,
  type AnnotHandle,
} from './pdf-comments.js';
import type {
  PdfCommentsReadResult,
  PdfCommentWriteResult,
  CommentPayload,
} from '@shared/comments';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The adapter mints `p{pageIndex}-i{annotIndex}` as the commentId for an annot
 *  with no /NM (the §3.2 fallback handle). Detecting that exact shape is how we
 *  choose between locating by /NM and locating by the read-time index pair —
 *  matching the adapter's own convention rather than guessing. */
const SYNTHETIC_HANDLE = /^p\d+-i\d+$/;

/** Build the adapter's `AnnotHandle` from a card's native ref: prefer the /NM,
 *  fall back to `(pageIndex, annotIndex)` when the id is the synthetic sentinel. */
function handleFor(commentId: string, pageIndex: number, annotIndex: number): AnnotHandle {
  return SYNTHETIC_HANDLE.test(commentId) ? { pageIndex, annotIndex } : { nm: commentId };
}

/** Register the four `pdf:` invoke handlers. `ipcMain.handle` throws on a
 *  duplicate channel, so call this exactly once. */
export function registerPdfIpc(): void {
  // Read native markup annotations out of a PDF, mapped to native-pdf
  // CommentPayloads. `docVersion` becomes the payloads' doc_version (the renderer
  // passes the doc's sha256); `docId` is the resolved path. A PDF with no markup
  // annotations yields an empty array — only a real I/O / parse failure (corrupt
  // or non-PDF bytes) is `read_failed`.
  typedHandle(
    'readPdfComments',
    async (_event, docPath, docVersion): Promise<PdfCommentsReadResult> => {
      const resolvedPath = resolve(docPath);
      try {
        const comments = await readPdfCommentsFromFile(resolvedPath, {
          docId: resolvedPath,
          docVersion,
        });
        return { ok: true, comments };
      } catch (err) {
        return { ok: false, reason: 'read_failed', error: errMessage(err) };
      }
    },
    ([docPath, docVersion]) => {
      assertPathArg('pdf:readComments', docPath);
      assertStringArg('pdf:readComments docVersion', docVersion);
    },
  );

  // Create a markup annotation over the request's pdf-quad anchor. We route a
  // single `app-draft` comment through the adapter's write path (the same one the
  // bundle writer uses) and read the minted /NM back out of its id→/NM map. An
  // out-of-range/stale anchor is skipped by the adapter (never throws) and comes
  // back as `out_of_range`.
  typedHandle(
    'createPdfComment',
    async (_event, request): Promise<PdfCommentWriteResult> => {
      const resolvedPath = resolve(request.docPath);
      const draftId = 'pdf-ipc-create';
      const payload: CommentPayload = {
        id: draftId,
        doc_id: resolvedPath,
        doc_version: '',
        anchor: request.anchor,
        highlighted_text: '',
        comment: request.commentText,
        redraft: null,
        redraft_suggestion: null,
        engagement_level: request.engagementLevel ?? 'comment',
        author: request.author,
        kind: 'comment',
        status: 'open',
        created_at: new Date().toISOString(),
        origin: 'app-draft',
      };
      try {
        const res = await writePdfCommentsToFile(resolvedPath, [payload]);
        const mintedName = res.idMap[draftId];
        if (mintedName) return { ok: true, commentId: mintedName };
        const reason = res.skipped.find((s) => s.id === draftId)?.reason ?? 'not written';
        return { ok: false, reason: 'out_of_range', error: `create skipped: ${reason}` };
      } catch (err) {
        return { ok: false, reason: 'write_failed', error: errMessage(err) };
      }
    },
    ([request]) => assertObjectArg('pdf:createComment', request),
  );

  // Edit a native annotation's body text. The adapter returns `{ ok: false }`
  // when the handle no longer locates an annot; surface that as `not_found`. On
  // success it echoes the stable /NM the annot is now addressed by (minted on the
  // first edit of a foreign annot).
  typedHandle(
    'editPdfComment',
    async (_event, request): Promise<PdfCommentWriteResult> => {
      const resolvedPath = resolve(request.docPath);
      const handle = handleFor(request.commentId, request.pageIndex, request.annotIndex);
      try {
        const res = await editPdfCommentInFile(resolvedPath, handle, request.newText);
        if (res.ok) return { ok: true, commentId: res.name ?? request.commentId };
        return { ok: false, reason: 'not_found', error: `no annot for handle ${request.commentId}` };
      } catch (err) {
        return { ok: false, reason: 'write_failed', error: errMessage(err) };
      }
    },
    ([request]) => assertObjectArg('pdf:editComment', request),
  );

  // Delete a native annotation and its reply subtree.
  typedHandle(
    'deletePdfComment',
    async (_event, request): Promise<PdfCommentWriteResult> => {
      const resolvedPath = resolve(request.docPath);
      const handle = handleFor(request.commentId, request.pageIndex, request.annotIndex);
      try {
        const res = await deletePdfCommentFromFile(resolvedPath, handle);
        if (res.ok) return { ok: true, commentId: request.commentId };
        return { ok: false, reason: 'not_found', error: `no annot for handle ${request.commentId}` };
      } catch (err) {
        return { ok: false, reason: 'write_failed', error: errMessage(err) };
      }
    },
    ([request]) => assertObjectArg('pdf:deleteComment', request),
  );
}
