// Unit tests for the §5.3 / L5 docx-comments IPC bridge (registerDocxIpc).
//
// The adapter (docx-comments.ts) is exercised end-to-end by docx-comments.test.ts.
// This module only adds the IPC seam: channel binding from IPC_INVOKE, arg
// passthrough, and the normalization of the adapter's result shapes into the
// `DocxComment*Result` unions. We mock both electron (to capture handlers) and
// the adapter (to drive each branch deterministically).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_INVOKE } from '@shared/ipc';
import type { CommentPayload, TextQuoteAnchor } from '@shared/types';

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
  readDocxComments: vi.fn(),
  createDocxComment: vi.fn(),
  editDocxComment: vi.fn(),
  deleteDocxComment: vi.fn(),
};
vi.mock('./docx-comments.js', () => adapter);

// Imported after the mocks so it binds to them.
const { registerDocxIpc } = await import('./docx-ipc.js');

const FAKE_EVENT = {} as never;

const ANCHOR: TextQuoteAnchor = {
  kind: 'text-quote',
  quoted_text: 'quick',
  prefix: 'The ',
  suffix: ' brown',
  char_start: 4,
  char_end: 9,
  relocated: null,
};

function register() {
  handlers.clear();
  registerDocxIpc();
}

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

describe('registerDocxIpc — channel binding', () => {
  it('registers all four channels under their IPC_INVOKE names', () => {
    register();
    expect(handlers.has(IPC_INVOKE.readDocxComments)).toBe(true);
    expect(handlers.has(IPC_INVOKE.createDocxComment)).toBe(true);
    expect(handlers.has(IPC_INVOKE.editDocxComment)).toBe(true);
    expect(handlers.has(IPC_INVOKE.deleteDocxComment)).toBe(true);
    // The method name is never the channel.
    expect(handlers.has('readDocxComments')).toBe(false);
  });
});

describe('docx:readComments', () => {
  it('maps the adapter payloads into an ok result', async () => {
    const payloads = [{ id: 'native-docx-1', origin: 'native-docx' }] as unknown as CommentPayload[];
    adapter.readDocxComments.mockResolvedValue(payloads);
    register();
    const res = await handlers.get(IPC_INVOKE.readDocxComments)!(FAKE_EVENT, '/x/a.docx', 'sha-1');
    expect(res).toEqual({ ok: true, comments: payloads });
    // docId is the resolved path, docVersion is passed straight through.
    expect(adapter.readDocxComments).toHaveBeenCalledWith(
      expect.stringContaining('a.docx'),
      expect.objectContaining({ docVersion: 'sha-1' }),
    );
  });

  it('turns an adapter throw into read_failed', async () => {
    adapter.readDocxComments.mockRejectedValue(new Error('bad zip'));
    register();
    const res = await handlers.get(IPC_INVOKE.readDocxComments)!(FAKE_EVENT, '/x/a.docx', 'v');
    expect(res).toEqual({ ok: false, reason: 'read_failed', error: 'bad zip' });
  });

  it('rejects a non-string path via the validator', () => {
    register();
    expect(() => handlers.get(IPC_INVOKE.readDocxComments)!(FAKE_EVENT, 123, 'v')).toThrow();
  });
});

describe('docx:createComment', () => {
  it('stringifies the minted numeric id on success', async () => {
    adapter.createDocxComment.mockResolvedValue({ ok: true, commentId: 7 });
    register();
    const res = await handlers.get(IPC_INVOKE.createDocxComment)!(FAKE_EVENT, {
      docPath: '/x/a.docx',
      anchor: ANCHOR,
      commentText: 'hi',
      author: 'AJB',
    });
    expect(res).toEqual({ ok: true, commentId: '7' });
  });

  it('forwards a typed adapter failure', async () => {
    adapter.createDocxComment.mockResolvedValue({ ok: false, reason: 'anchor_unresolved' });
    register();
    const res = await handlers.get(IPC_INVOKE.createDocxComment)!(FAKE_EVENT, {
      docPath: '/x/a.docx',
      anchor: ANCHOR,
      commentText: 'hi',
      author: 'AJB',
    });
    expect(res).toMatchObject({ ok: false, reason: 'anchor_unresolved' });
  });

  it('maps an adapter throw to write_failed', async () => {
    adapter.createDocxComment.mockRejectedValue(new Error('disk full'));
    register();
    const res = await handlers.get(IPC_INVOKE.createDocxComment)!(FAKE_EVENT, {
      docPath: '/x/a.docx',
      anchor: ANCHOR,
      commentText: 'hi',
      author: 'AJB',
    });
    expect(res).toEqual({ ok: false, reason: 'write_failed', error: 'disk full' });
  });
});

describe('docx:editComment', () => {
  it('echoes the commentId on success', async () => {
    adapter.editDocxComment.mockResolvedValue({ ok: true });
    register();
    const res = await handlers.get(IPC_INVOKE.editDocxComment)!(FAKE_EVENT, {
      docPath: '/x/a.docx',
      commentId: '3',
      newText: 'edited',
    });
    expect(res).toEqual({ ok: true, commentId: '3' });
    expect(adapter.editDocxComment).toHaveBeenCalledWith(
      expect.stringContaining('a.docx'),
      '3',
      'edited',
    );
  });

  it('maps a missing comment (ok:false) to not_found', async () => {
    adapter.editDocxComment.mockResolvedValue({ ok: false });
    register();
    const res = await handlers.get(IPC_INVOKE.editDocxComment)!(FAKE_EVENT, {
      docPath: '/x/a.docx',
      commentId: '99',
      newText: 'x',
    });
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
  });
});

describe('docx:deleteComment', () => {
  it('echoes the commentId on success', async () => {
    adapter.deleteDocxComment.mockResolvedValue({ ok: true });
    register();
    const res = await handlers.get(IPC_INVOKE.deleteDocxComment)!(FAKE_EVENT, {
      docPath: '/x/a.docx',
      commentId: '5',
    });
    expect(res).toEqual({ ok: true, commentId: '5' });
  });

  it('maps a missing comment (ok:false) to not_found', async () => {
    adapter.deleteDocxComment.mockResolvedValue({ ok: false });
    register();
    const res = await handlers.get(IPC_INVOKE.deleteDocxComment)!(FAKE_EVENT, {
      docPath: '/x/a.docx',
      commentId: '99',
    });
    expect(res).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('rejects a non-object request via the validator', () => {
    register();
    expect(() => handlers.get(IPC_INVOKE.deleteDocxComment)!(FAKE_EVENT, 'nope')).toThrow();
  });
});
