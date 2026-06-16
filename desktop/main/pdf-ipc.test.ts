// Unit tests for the §5.1 / L4 pdf-comments IPC bridge (registerPdfIpc).
//
// The adapter (pdf-comments.ts) is exercised end-to-end by pdf-comments.test.ts.
// This module only adds the IPC seam: channel binding from IPC_INVOKE, arg
// passthrough, the /NM-vs-(page,index) handle selection, and the normalization of
// the adapter's result shapes into the `PdfComment*Result` unions. We mock both
// electron (to capture handlers) and the adapter (to drive each branch).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_INVOKE } from '@shared/ipc';
import type { CommentPayload, PdfQuadAnchor } from '@shared/types';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: HandlerFn) => {
      handlers.set(channel, fn);
    }),
  },
}));

const adapter = {
  readPdfComments: vi.fn(),
  writePdfComments: vi.fn(),
  editPdfComment: vi.fn(),
  deletePdfComment: vi.fn(),
};
vi.mock('./pdf-comments.js', () => adapter);

// Imported after the mocks so it binds to them.
const { registerPdfIpc } = await import('./pdf-ipc.js');

const FAKE_EVENT = {} as never;

const ANCHOR: PdfQuadAnchor = {
  kind: 'pdf-quad',
  page: 1,
  region: { x: 10, y: 20, w: 100, h: 12 },
};

function register() {
  handlers.clear();
  registerPdfIpc();
}

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('registerPdfIpc — channel binding', () => {
  it('registers all four channels under their IPC_INVOKE names', () => {
    register();
    expect(handlers.has(IPC_INVOKE.readPdfComments)).toBe(true);
    expect(handlers.has(IPC_INVOKE.createPdfComment)).toBe(true);
    expect(handlers.has(IPC_INVOKE.editPdfComment)).toBe(true);
    expect(handlers.has(IPC_INVOKE.deletePdfComment)).toBe(true);
    // The method name is never the channel.
    expect(handlers.has('readPdfComments')).toBe(false);
  });
});

describe('pdf:readComments', () => {
  it('maps the adapter payloads into an ok result', async () => {
    const payloads = [{ id: 'native-pdf-1', origin: 'native-pdf' }] as unknown as CommentPayload[];
    adapter.readPdfComments.mockResolvedValue(payloads);
    register();
    const res = await handlers.get(IPC_INVOKE.readPdfComments)!(FAKE_EVENT, '/x/a.pdf', 'sha-1');
    expect(res).toEqual({ ok: true, comments: payloads });
    // docId is the resolved path, docVersion is passed straight through.
    expect(adapter.readPdfComments).toHaveBeenCalledWith(
      expect.stringContaining('a.pdf'),
      expect.objectContaining({ docVersion: 'sha-1' }),
    );
  });

  it('turns an adapter throw into read_failed', async () => {
    adapter.readPdfComments.mockRejectedValue(new Error('not a PDF'));
    register();
    const res = await handlers.get(IPC_INVOKE.readPdfComments)!(FAKE_EVENT, '/x/a.pdf', 'v');
    expect(res).toEqual({ ok: false, reason: 'read_failed', error: 'not a PDF' });
  });

  it('rejects a non-string path via the validator', () => {
    register();
    expect(() => handlers.get(IPC_INVOKE.readPdfComments)!(FAKE_EVENT, 123, 'v')).toThrow();
  });
});

describe('pdf:createComment', () => {
  it('returns the minted /NM out of the adapter id-map', async () => {
    adapter.writePdfComments.mockResolvedValue({ idMap: { 'pdf-ipc-create': 'annot-7' }, skipped: [] });
    register();
    const res = await handlers.get(IPC_INVOKE.createPdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      anchor: ANCHOR,
      commentText: 'hi',
      author: 'AJB',
    });
    expect(res).toEqual({ ok: true, commentId: 'annot-7' });
    // The adapter is handed a single app-draft comment over the anchor.
    const [, comments] = adapter.writePdfComments.mock.calls[0];
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ origin: 'app-draft', comment: 'hi', author: 'AJB', anchor: ANCHOR });
  });

  it('maps a skipped (out-of-range) anchor to out_of_range', async () => {
    adapter.writePdfComments.mockResolvedValue({
      idMap: {},
      skipped: [{ id: 'pdf-ipc-create', reason: 'out-of-range page 9' }],
    });
    register();
    const res = await handlers.get(IPC_INVOKE.createPdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      anchor: ANCHOR,
      commentText: 'hi',
      author: 'AJB',
    });
    expect(res).toMatchObject({ ok: false, reason: 'out_of_range' });
  });

  it('maps an adapter throw to write_failed', async () => {
    adapter.writePdfComments.mockRejectedValue(new Error('disk full'));
    register();
    const res = await handlers.get(IPC_INVOKE.createPdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      anchor: ANCHOR,
      commentText: 'hi',
      author: 'AJB',
    });
    expect(res).toEqual({ ok: false, reason: 'write_failed', error: 'disk full' });
  });
});

describe('pdf:editComment — handle selection', () => {
  it('locates a named annot by /NM and echoes the stable name', async () => {
    adapter.editPdfComment.mockResolvedValue({ ok: true, name: 'annot-3' });
    register();
    const res = await handlers.get(IPC_INVOKE.editPdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      commentId: 'annot-3',
      pageIndex: 0,
      annotIndex: 2,
      newText: 'edited',
    });
    expect(res).toEqual({ ok: true, commentId: 'annot-3' });
    // A real /NM → locate by name, NOT by the (page,index) fallback.
    expect(adapter.editPdfComment).toHaveBeenCalledWith(
      expect.stringContaining('a.pdf'),
      { nm: 'annot-3' },
      'edited',
    );
  });

  it('locates a synthetic-id annot by (pageIndex, annotIndex)', async () => {
    adapter.editPdfComment.mockResolvedValue({ ok: true, name: 'annot-9' });
    register();
    const res = await handlers.get(IPC_INVOKE.editPdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      commentId: 'p0-i2',
      pageIndex: 0,
      annotIndex: 2,
      newText: 'edited',
    });
    // The freshly-stamped /NM comes back as the commentId.
    expect(res).toEqual({ ok: true, commentId: 'annot-9' });
    expect(adapter.editPdfComment).toHaveBeenCalledWith(
      expect.stringContaining('a.pdf'),
      { pageIndex: 0, annotIndex: 2 },
      'edited',
    );
  });

  it('maps a missing annot (ok:false) to not_found', async () => {
    adapter.editPdfComment.mockResolvedValue({ ok: false, name: null });
    register();
    const res = await handlers.get(IPC_INVOKE.editPdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      commentId: 'p1-i9',
      pageIndex: 1,
      annotIndex: 9,
      newText: 'x',
    });
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('pdf:deleteComment', () => {
  it('echoes the commentId on success', async () => {
    adapter.deletePdfComment.mockResolvedValue({ ok: true, removed: ['annot-5'] });
    register();
    const res = await handlers.get(IPC_INVOKE.deletePdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      commentId: 'annot-5',
      pageIndex: 0,
      annotIndex: 1,
    });
    expect(res).toEqual({ ok: true, commentId: 'annot-5' });
    expect(adapter.deletePdfComment).toHaveBeenCalledWith(
      expect.stringContaining('a.pdf'),
      { nm: 'annot-5' },
    );
  });

  it('maps a missing annot (ok:false) to not_found', async () => {
    adapter.deletePdfComment.mockResolvedValue({ ok: false, removed: [] });
    register();
    const res = await handlers.get(IPC_INVOKE.deletePdfComment)!(FAKE_EVENT, {
      docPath: '/x/a.pdf',
      commentId: 'p0-i9',
      pageIndex: 0,
      annotIndex: 9,
    });
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejects a non-object request via the validator', () => {
    register();
    expect(() => handlers.get(IPC_INVOKE.deletePdfComment)!(FAKE_EVENT, 'nope')).toThrow();
  });
});
