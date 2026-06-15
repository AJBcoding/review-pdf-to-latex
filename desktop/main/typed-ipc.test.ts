// Unit tests for the typedHandle invoke registrar (rev-x4).
//
// Mocks electron's ipcMain.handle to capture the registered channel + wrapper
// fn, then exercises the wrapper directly to assert: channel binding from
// IPC_INVOKE, arg/return passthrough, and validator ordering (validate runs
// before the body; a throwing validator skips the body and rejects).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IPC_INVOKE } from '@shared/ipc';

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, HandlerFn>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: HandlerFn) => {
      handlers.set(channel, fn);
    }),
  },
}));

// Imported after the mock is declared so it binds to the mocked ipcMain.
const { typedHandle } = await import('./typed-ipc.js');

afterEach(() => {
  handlers.clear();
  vi.clearAllMocks();
});

const FAKE_EVENT = {} as never;

describe('typedHandle', () => {
  it('registers under the channel resolved from IPC_INVOKE', () => {
    typedHandle('pdfHealth', async () => ({ ok: false, reason: 'engine_failed', engine: {} as never }));
    expect(handlers.has(IPC_INVOKE.pdfHealth)).toBe(true);
    expect(handlers.has('pdfHealth')).toBe(false); // method name is NOT the channel
  });

  it('passes invoke args to the body and returns its result', async () => {
    const body = vi.fn(async (_event: unknown, message: string) => `pong: ${message}`);
    typedHandle('ping', body);
    const wrapper = handlers.get(IPC_INVOKE.ping)!;
    const result = await wrapper(FAKE_EVENT, 'hi');
    expect(body).toHaveBeenCalledWith(FAKE_EVENT, 'hi');
    expect(result).toBe('pong: hi');
  });

  it('runs the validator before the body', async () => {
    const order: string[] = [];
    const body = vi.fn(async () => { order.push('body'); return 'ok'; });
    const validate = vi.fn(() => { order.push('validate'); });
    typedHandle('ping', body, validate);
    await handlers.get(IPC_INVOKE.ping)!(FAKE_EVENT, 'x');
    expect(order).toEqual(['validate', 'body']);
    expect(validate).toHaveBeenCalledWith(['x']);
  });

  it('a throwing validator skips the body (electron turns the throw into an invoke rejection)', () => {
    const body = vi.fn(async () => 'should-not-run');
    typedHandle('ping', body, () => { throw new Error('bad arg'); });
    // Called directly here, so the throw is synchronous; under ipcMain.handle
    // electron catches it and rejects the renderer's invoke() promise.
    expect(() => handlers.get(IPC_INVOKE.ping)!(FAKE_EVENT, 123)).toThrow('bad arg');
    expect(body).not.toHaveBeenCalled();
  });
});
