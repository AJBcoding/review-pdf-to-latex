// Unit tests for the Claude Agent SDK driver's session teardown semantics
// (rev-ra3 zombie fix).
//
// Mocks @anthropic-ai/claude-agent-sdk's query() with a controllable async
// iterable so we can drive the run() loop to a normal end or a thrown error
// and assert the cleanup contract:
//   - on self-termination (stream end OR error): queue ends, pending
//     approvals drain as denies, and onClosed fires so the host drops the
//     registry entry (no more message-eating zombie).
//   - on host-initiated close(): onClosed does NOT fire (the host owns
//     teardown; firing would race a re-created session under the same key).
//
// The adapter is mocked to a no-op — these tests are about lifecycle, not
// message mapping (which adapter.test.ts covers).
import { afterEach, describe, expect, it, vi } from 'vitest';

// ─── Controllable fake query() ───────────────────────────────────────────

type QueryOptions = {
  canUseTool?: (
    toolName: string,
    input: Record<string, unknown>,
    options: {
      toolUseID: string;
      signal: AbortSignal;
      title?: string;
      displayName?: string;
      description?: string;
      blockedPath?: string;
      decisionReason?: string;
    },
  ) => Promise<unknown>;
};

let capturedOptions: QueryOptions | null = null;

function makeControllableQuery() {
  let resolveGate!: () => void;
  let rejectGate!: (err: unknown) => void;
  const gate = new Promise<void>((res, rej) => {
    resolveGate = res;
    rejectGate = rej;
  });
  // Swallow the rejection so an unconsumed gate (host-close path resolves it,
  // not rejects) never logs an unhandled rejection.
  gate.catch(() => undefined);

  const q = {
    async *[Symbol.asyncIterator]() {
      await gate; // resolve → stream ends (done); reject → loop throws
    },
    interrupt: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    return: vi.fn(async () => {
      resolveGate();
    }),
  };
  return {
    q,
    endStream: () => resolveGate(),
    throwStream: (err: unknown) => rejectGate(err),
  };
}

let controller: ReturnType<typeof makeControllableQuery>;

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn((args: { options: QueryOptions }) => {
    capturedOptions = args.options;
    return controller.q;
  }),
}));

vi.mock('@shared/agent-pane/adapter.js', () => ({
  createAdapterState: vi.fn(() => ({})),
  mapSdkMessage: vi.fn(() => []),
}));

const { startSession } = await import('./claude-backend.js');

// A microtask/timer flush so the run() loop's finally block settles.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  capturedOptions = null;
  vi.clearAllMocks();
});

describe('claude-backend session teardown', () => {
  it('fires onClosed when the SDK stream ends on its own', async () => {
    controller = makeControllableQuery();
    const onClosed = vi.fn();
    startSession({ emit: vi.fn(), onClosed });

    await flush(); // let run() reach the for-await
    controller.endStream();
    await flush();

    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('emits an error session event AND fires onClosed when query() throws', async () => {
    controller = makeControllableQuery();
    const emit = vi.fn();
    const onClosed = vi.fn();
    startSession({ emit, onClosed });

    await flush();
    controller.throwStream(new Error('network drop'));
    await flush();

    const errorEvent = emit.mock.calls
      .map((c) => c[0])
      .find(
        (e) =>
          e &&
          e.type === 'session' &&
          e.session?.status === 'error',
      );
    expect(errorEvent).toBeTruthy();
    expect(errorEvent.session.lastError).toContain('network drop');
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('drains pending tool approvals as denies on termination', async () => {
    controller = makeControllableQuery();
    const emit = vi.fn();
    startSession({ emit, onClosed: vi.fn() });

    await flush();
    expect(capturedOptions?.canUseTool).toBeTypeOf('function');

    // Raise a permission request — leaves a pending promise.
    const ac = new AbortController();
    const approvalPromise = capturedOptions!.canUseTool!('Bash', { cmd: 'ls' }, {
      toolUseID: 'tool-1',
      signal: ac.signal,
    });

    // Stream errors before the user answers — pending must resolve as deny.
    controller.throwStream(new Error('boom'));
    const result = (await approvalPromise) as {
      behavior: string;
      message?: string;
    };
    expect(result.behavior).toBe('deny');

    // A permissionResolved event was emitted for the drained approval.
    const resolved = emit.mock.calls
      .map((c) => c[0])
      .find((e) => e && e.type === 'permissionResolved');
    expect(resolved?.toolUseId).toBe('tool-1');
  });

  it('does NOT fire onClosed on a host-initiated close()', async () => {
    controller = makeControllableQuery();
    const onClosed = vi.fn();
    const session = startSession({ emit: vi.fn(), onClosed });

    await flush();
    await session.close(); // sets hostClosing, calls q.return() → stream ends
    await flush();

    expect(controller.q.return).toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
  });
});
