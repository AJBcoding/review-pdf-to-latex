// Unit tests for the agent-pane IPC layer.
//
// Mocks the electron module to capture ipcMain handler registrations + the
// BrowserWindow's webContents.send so we can assert on emitted events.
// Mocks claude-backend.startSession to return a deterministic fake session
// (spy methods, controllable getSessionId). Mocks session-store so we can
// track saved-resume semantics across "conv" vs worker sessions.
//
// Covers Project 4 M-int-2 through M-int-4a behavior:
// - default sessionId routing (omit → "conv")
// - explicit worker sessionId via agent:spawnSession
// - saved-resume applies to conv only; workers always fresh
// - doc-switch debounce (M-int-3)
// - Fresh Start tear-down + reseed (M-int-5)
// - shutdownAgentPane closes every live session
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import type { BackendEvent } from '@shared/agent-pane/types.js';

// ─── Mock the modules agent-pane-ipc.ts depends on ───────────────────────

type HandlerFn = (event: unknown, ...args: unknown[]) => unknown;

const handlers = new Map<string, HandlerFn>();
const emittedEvents: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => {
  const ipcMain = {
    handle: vi.fn((channel: string, fn: HandlerFn) => {
      handlers.set(channel, fn);
    }),
  };
  // app.getPath backs the session cwd fallback (dirname(userData)).
  const app = { getPath: vi.fn(() => '/tmp/userData') };
  return { ipcMain, BrowserWindow: vi.fn(), app };
});

type FakeSessionSpy = {
  send: Mock;
  interrupt: Mock;
  setModel: Mock;
  approve: Mock;
  close: Mock;
  getSessionId: Mock;
};

const createdSessions: Array<{
  options: { resume?: string; model?: string };
  emit: (event: BackendEvent) => void;
  onSessionId?: (id: string) => void;
  onClosed?: () => void;
  spy: FakeSessionSpy;
}> = [];

vi.mock('./claude-backend.js', () => ({
  startSession: vi.fn(
    (opts: {
      emit: (e: BackendEvent) => void;
      resume?: string;
      onSessionId?: (id: string) => void;
      onClosed?: () => void;
      model?: string;
    }) => {
      const spy: FakeSessionSpy = {
        send: vi.fn(),
        interrupt: vi.fn(async () => undefined),
        setModel: vi.fn(async () => undefined),
        approve: vi.fn(),
        close: vi.fn(async () => undefined),
        getSessionId: vi.fn(() => null),
      };
      createdSessions.push({
        options: { resume: opts.resume, model: opts.model },
        emit: opts.emit,
        onSessionId: opts.onSessionId,
        onClosed: opts.onClosed,
        spy,
      });
      return spy;
    },
  ),
}));

const savedSessionStore = { current: null as string | null };
vi.mock('./session-store.js', () => ({
  loadSavedSessionId: vi.fn(() => savedSessionStore.current),
  saveSessionId: vi.fn((id: string) => {
    savedSessionStore.current = id;
  }),
  clearSavedSessionId: vi.fn(() => {
    savedSessionStore.current = null;
  }),
}));

// ─── Import under test (after mocks are set up) ──────────────────────────

const ipcModule = await import('./agent-pane-ipc.js');

function makeFakeMainWindow() {
  return {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn((channel: string, payload: unknown) => {
        emittedEvents.push({ channel, payload });
      }),
    },
  } as unknown as Electron.BrowserWindow;
}

function call(channel: string, payload?: unknown): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn({}, payload);
}

function resetAll(): void {
  handlers.clear();
  emittedEvents.length = 0;
  createdSessions.length = 0;
  savedSessionStore.current = null;
}

describe('agent-pane-ipc', () => {
  beforeEach(() => {
    resetAll();
    ipcModule.registerAgentPaneIpc(makeFakeMainWindow());
  });

  afterEach(async () => {
    // Make sure shutdown clears the session map between tests.
    await ipcModule.shutdownAgentPane();
    resetAll();
  });

  describe('handler registration', () => {
    it('registers all expected IPC channels', () => {
      const channels = [...handlers.keys()].sort();
      expect(channels).toEqual(
        [
          'agent:approveTool',
          'agent:close',
          'agent:freshStart',
          'agent:getSavedSessionId',
          'agent:interrupt',
          'agent:listSessions',
          'agent:newSession',
          'agent:notifyDocSwitch',
          'agent:send',
          'agent:setModel',
          'agent:spawnSession',
        ].sort(),
      );
    });
  });

  describe('agent:send', () => {
    it('lazily creates a conv session on first send', () => {
      expect(createdSessions).toHaveLength(0);
      call('agent:send', { text: 'hello' });
      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0]!.spy.send).toHaveBeenCalledWith('hello');
    });

    it('reuses the same session for subsequent sends', () => {
      call('agent:send', { text: 'one' });
      call('agent:send', { text: 'two' });
      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0]!.spy.send).toHaveBeenNthCalledWith(1, 'one');
      expect(createdSessions[0]!.spy.send).toHaveBeenNthCalledWith(2, 'two');
    });

    it('ignores non-string text payloads', () => {
      call('agent:send', { text: null });
      call('agent:send', null);
      call('agent:send', {});
      expect(createdSessions).toHaveLength(0);
    });

    it('threads the model option into a fresh session start', () => {
      call('agent:send', { text: 'with model', model: 'haiku' });
      expect(createdSessions[0]!.options.model).toBe('haiku');
    });

    it('applies the saved session id to a fresh conv session', () => {
      savedSessionStore.current = 'sess-saved-123';
      call('agent:send', { text: 'resume' });
      expect(createdSessions[0]!.options.resume).toBe('sess-saved-123');
    });

    it('does NOT apply the saved session id to a worker session', () => {
      savedSessionStore.current = 'sess-conv-saved';
      // Workers are created via spawnSession, not agent:send.
      call('agent:spawnSession', { sessionId: 'worker-1', prompt: 'work' });
      expect(createdSessions[0]!.options.resume).toBeUndefined();
    });

    it('routes conv vs worker sends to their respective sessions', () => {
      call('agent:send', { text: 'conv1' });
      call('agent:spawnSession', { sessionId: 'worker-a', prompt: 'work1' });
      call('agent:send', { text: 'conv2' });
      call('agent:send', { text: 'work2', sessionId: 'worker-a' });
      expect(createdSessions).toHaveLength(2);
      // conv session received both conv messages
      expect(createdSessions[0]!.spy.send).toHaveBeenCalledTimes(2);
      // worker session received the spawn prompt + the later send
      expect(createdSessions[1]!.spy.send).toHaveBeenCalledTimes(2);
      expect(createdSessions[1]!.spy.send).toHaveBeenNthCalledWith(1, 'work1');
      expect(createdSessions[1]!.spy.send).toHaveBeenNthCalledWith(2, 'work2');
    });

    it('does NOT create a session when sending to an unknown worker id', () => {
      // A renderer routing bug (stale/mistyped worker id) must not silently
      // spin up a brand-new full Claude session — it is a logged no-op.
      call('agent:send', { text: 'orphan', sessionId: 'worker-ctx-999' });
      expect(createdSessions).toHaveLength(0);
    });

    it('sends to an existing worker created via spawnSession', () => {
      call('agent:spawnSession', { sessionId: 'wk', prompt: 'seed' });
      call('agent:send', { text: 'follow-up', sessionId: 'wk' });
      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0]!.spy.send).toHaveBeenNthCalledWith(2, 'follow-up');
    });
  });

  describe('event emission', () => {
    it('forwards events with sessionId tag for conv', () => {
      call('agent:send', { text: 'hi' });
      const conv = createdSessions[0]!;
      conv.emit({ type: 'turnDone', turnDone: { sessionId: 'sess-1', success: true } });
      const sent = emittedEvents.find((e) => e.channel === 'agent:event');
      expect(sent?.payload).toMatchObject({
        type: 'turnDone',
        sessionId: 'conv',
      });
    });

    it('forwards events with the worker sessionId tag', () => {
      call('agent:spawnSession', { sessionId: 'worker-x', prompt: 'hi' });
      const worker = createdSessions[0]!;
      worker.emit({ type: 'turnDone', turnDone: { sessionId: 'sess-1', success: true } });
      expect(emittedEvents.at(-1)?.payload).toMatchObject({
        sessionId: 'worker-x',
      });
    });
  });

  describe('agent:approveTool / agent:setModel / agent:interrupt', () => {
    it('targets the conv session by default', async () => {
      call('agent:send', { text: 'hi' });
      const conv = createdSessions[0]!;
      call('agent:approveTool', { toolUseId: 'tool-1', allow: true });
      expect(conv.spy.approve).toHaveBeenCalledWith('tool-1', true, undefined);

      await call('agent:setModel', { modelId: 'opus' });
      expect(conv.spy.setModel).toHaveBeenCalledWith('opus');

      await call('agent:interrupt', undefined);
      expect(conv.spy.interrupt).toHaveBeenCalled();
    });

    it('targets a specified worker sessionId', async () => {
      call('agent:spawnSession', { sessionId: 'wk', prompt: 'hi' });
      const worker = createdSessions[0]!;
      call('agent:approveTool', {
        toolUseId: 't1',
        allow: false,
        denyReason: 'no',
        sessionId: 'wk',
      });
      expect(worker.spy.approve).toHaveBeenCalledWith('t1', false, 'no');

      await call('agent:setModel', { modelId: 'haiku', sessionId: 'wk' });
      expect(worker.spy.setModel).toHaveBeenCalledWith('haiku');
    });

    it('is a no-op when the target session does not exist', async () => {
      call('agent:approveTool', { toolUseId: 'no-such', allow: true });
      // No throw is enough — verify no session was created
      expect(createdSessions).toHaveLength(0);
    });
  });

  describe('agent:newSession + agent:close', () => {
    it('closes the conv session AND clears the saved id', async () => {
      savedSessionStore.current = 'old-conv';
      call('agent:send', { text: 'hi' });
      const conv = createdSessions[0]!;
      await call('agent:newSession', undefined);
      expect(conv.spy.close).toHaveBeenCalled();
      expect(savedSessionStore.current).toBeNull();
    });

    it('closes a worker session WITHOUT clearing the saved conv id', async () => {
      savedSessionStore.current = 'conv-saved';
      call('agent:send', { text: 'hi', sessionId: 'wk' });
      await call('agent:newSession', { sessionId: 'wk' });
      expect(savedSessionStore.current).toBe('conv-saved');
    });

    it('agent:close is identical to newSession except for the saved id', async () => {
      savedSessionStore.current = 'preserve-me';
      call('agent:send', { text: 'hi' });
      await call('agent:close', undefined);
      expect(savedSessionStore.current).toBe('preserve-me');
    });
  });

  describe('agent:spawnSession', () => {
    it('creates a worker session with the given prompt + sessionId', () => {
      call('agent:spawnSession', {
        sessionId: 'wk-create-1',
        prompt: 'do the thing',
      });
      expect(createdSessions).toHaveLength(1);
      expect(createdSessions[0]!.spy.send).toHaveBeenCalledWith('do the thing');
    });

    it('refuses to spawn into the conv sessionId', () => {
      call('agent:spawnSession', { sessionId: 'conv', prompt: 'no' });
      expect(createdSessions).toHaveLength(0);
    });

    it('refuses empty sessionId or non-string prompt', () => {
      call('agent:spawnSession', { sessionId: '', prompt: 'no' });
      call('agent:spawnSession', { sessionId: 'wk', prompt: 123 });
      call('agent:spawnSession', null);
      expect(createdSessions).toHaveLength(0);
    });

    it('caps simultaneous worker sessions at MAX_WORKER_PTYS (16)', () => {
      for (let i = 0; i < 16; i += 1) {
        call('agent:spawnSession', { sessionId: `wk-${i}`, prompt: 'p' });
      }
      expect(createdSessions).toHaveLength(16);
      // 17th worker is refused.
      call('agent:spawnSession', { sessionId: 'wk-overflow', prompt: 'p' });
      expect(createdSessions).toHaveLength(16);
      // The conv session is NOT counted against the worker cap.
      call('agent:send', { text: 'still works' });
      expect(call('agent:listSessions', undefined) as string[]).toContain(
        'conv',
      );
    });

    it('re-spawning an already-live worker id is allowed past the cap math', () => {
      for (let i = 0; i < 16; i += 1) {
        call('agent:spawnSession', { sessionId: `wk-${i}`, prompt: 'p' });
      }
      // Re-spawn an existing id — reuses the entry, not a new session.
      call('agent:spawnSession', { sessionId: 'wk-0', prompt: 'again' });
      expect(createdSessions).toHaveLength(16);
      expect(createdSessions[0]!.spy.send).toHaveBeenNthCalledWith(2, 'again');
    });
  });

  describe('self-termination cleanup (zombie fix)', () => {
    it('drops the session from the registry when it closes on its own', () => {
      call('agent:send', { text: 'hi' });
      expect(call('agent:listSessions', undefined)).toEqual(['conv']);
      // Simulate the backend's onClosed firing (SDK stream end or error).
      createdSessions[0]!.onClosed?.();
      expect(call('agent:listSessions', undefined)).toEqual([]);
    });

    it('a send after self-termination creates a FRESH session, not a zombie', () => {
      call('agent:send', { text: 'first' });
      const first = createdSessions[0]!;
      first.onClosed?.(); // session errored / ended
      call('agent:send', { text: 'second' });
      // A brand-new session object was created for the second send.
      expect(createdSessions).toHaveLength(2);
      expect(createdSessions[1]!.spy.send).toHaveBeenCalledWith('second');
      // The dead session did NOT receive the second message.
      expect(first.spy.send).not.toHaveBeenCalledWith('second');
    });

    it('frees a worker slot when a worker self-terminates', () => {
      for (let i = 0; i < 16; i += 1) {
        call('agent:spawnSession', { sessionId: `wk-${i}`, prompt: 'p' });
      }
      // One worker dies → its slot frees up.
      createdSessions[0]!.onClosed?.();
      call('agent:spawnSession', { sessionId: 'wk-new', prompt: 'p' });
      expect(createdSessions).toHaveLength(17);
      expect(call('agent:listSessions', undefined) as string[]).toContain(
        'wk-new',
      );
    });
  });

  describe('agent:listSessions', () => {
    it('returns live session ids', () => {
      expect(call('agent:listSessions', undefined)).toEqual([]);
      call('agent:send', { text: 'hi' });
      call('agent:spawnSession', { sessionId: 'w1', prompt: 'p' });
      const live = call('agent:listSessions', undefined) as string[];
      expect(live.sort()).toEqual(['conv', 'w1']);
    });

    it('drops sessions after newSession / close', async () => {
      call('agent:send', { text: 'hi' });
      await call('agent:newSession', undefined);
      expect(call('agent:listSessions', undefined)).toEqual([]);
    });
  });

  describe('agent:notifyDocSwitch (debounce)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('coalesces rapid switches into a single send after 500ms', () => {
      call('agent:notifyDocSwitch', { path: '/a.pdf', pages: 1, comments: 0 });
      call('agent:notifyDocSwitch', { path: '/b.pdf', pages: 2, comments: 1 });
      call('agent:notifyDocSwitch', { path: '/c.pdf', pages: 3, comments: 2 });
      // Not yet flushed
      expect(createdSessions).toHaveLength(0);

      vi.advanceTimersByTime(499);
      expect(createdSessions).toHaveLength(0);

      vi.advanceTimersByTime(1);
      expect(createdSessions).toHaveLength(1);
      const sentText = createdSessions[0]!.spy.send.mock.calls[0]?.[0] as string;
      // Last call wins
      expect(sentText).toContain('c.pdf');
      expect(sentText).toContain('3 pages');
      expect(sentText).toContain('2 comments');
      expect(sentText.startsWith('[Now reviewing:')).toBe(true);
    });

    it('ignores malformed payloads', () => {
      call('agent:notifyDocSwitch', null);
      call('agent:notifyDocSwitch', { path: 'x' }); // missing pages/comments
      call('agent:notifyDocSwitch', { path: 1, pages: 1, comments: 1 });
      vi.advanceTimersByTime(1000);
      expect(createdSessions).toHaveLength(0);
    });
  });

  describe('agent:freshStart', () => {
    it('closes the conv session, clears saved id, and reseeds with handoff text', async () => {
      savedSessionStore.current = 'old-conv';
      // Seed the original conv session
      call('agent:send', { text: 'hi' });
      const old = createdSessions[0]!;

      await call('agent:freshStart', { handoffText: 'pick up from here' });

      expect(old.spy.close).toHaveBeenCalled();
      expect(savedSessionStore.current).toBeNull();
      // A NEW conv session is created and seeded with the handoff
      expect(createdSessions).toHaveLength(2);
      const fresh = createdSessions[1]!;
      expect(fresh.options.resume).toBeUndefined();
      expect(fresh.spy.send).toHaveBeenCalledWith('pick up from here');
    });

    it('threads the model option', async () => {
      await call('agent:freshStart', {
        handoffText: 'go',
        model: 'sonnet-4',
      });
      expect(createdSessions[0]!.options.model).toBe('sonnet-4');
    });

    it('ignores missing handoff text', async () => {
      await call('agent:freshStart', { handoffText: 123 });
      await call('agent:freshStart', null);
      expect(createdSessions).toHaveLength(0);
    });
  });

  describe('shutdownAgentPane', () => {
    it('closes every live session', async () => {
      call('agent:send', { text: 'hi' });
      call('agent:spawnSession', { sessionId: 'w1', prompt: 'p1' });
      call('agent:spawnSession', { sessionId: 'w2', prompt: 'p2' });
      const closers = createdSessions.map((s) => s.spy.close);

      await ipcModule.shutdownAgentPane();

      for (const close of closers) {
        expect(close).toHaveBeenCalled();
      }
    });
  });

  describe('agent:getSavedSessionId', () => {
    it('returns the current saved id', () => {
      expect(call('agent:getSavedSessionId', undefined)).toBeNull();
      savedSessionStore.current = 'sess-42';
      expect(call('agent:getSavedSessionId', undefined)).toBe('sess-42');
    });
  });
});
