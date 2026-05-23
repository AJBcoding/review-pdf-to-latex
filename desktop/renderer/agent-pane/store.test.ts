// @vitest-environment jsdom
//
// Unit tests for the agent-pane zustand store's apply() reducer + actions.
// jsdom env gives us window + localStorage so the persist middleware can
// initialise without bailing (it still no-ops on assign since we never set
// values, but module load works).
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { useStore } from './store';
import type {
  BackendEvent,
  ChatMessage,
  PermissionRequest,
  SessionInfo,
  ThreadActivity,
  TurnDone,
} from '@shared/agent-pane/types';

// ─── Fixture builders ───────────────────────────────────────────────────

function msg(input: {
  id: string;
  role?: ChatMessage['role'];
  text?: string;
  createdAt?: string;
  streaming?: boolean;
}): ChatMessage {
  return {
    id: input.id,
    role: input.role ?? 'user',
    text: input.text ?? `text-${input.id}`,
    createdAt: input.createdAt ?? '2026-01-01T00:00:00Z',
    streaming: input.streaming ?? false,
  };
}

function act(input: {
  id: string;
  kind?: string;
  createdAt?: string;
  summary?: string;
}): ThreadActivity {
  return {
    id: input.id,
    tone: 'info',
    kind: input.kind ?? 'tool.started',
    summary: input.summary ?? `s-${input.id}`,
    createdAt: input.createdAt ?? '2026-01-01T00:00:00Z',
  };
}

function permission(input: {
  toolUseId: string;
  toolName?: string;
}): PermissionRequest {
  return {
    toolUseId: input.toolUseId,
    toolName: input.toolName ?? 'Bash',
    input: { command: 'ls' },
    createdAt: '2026-01-01T00:00:00Z',
  };
}

function session(input: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
  return {
    sessionId: input.sessionId,
    status: input.status ?? 'running',
    updatedAt: input.updatedAt ?? '2026-01-01T00:00:00Z',
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
  };
}

function turnDone(input: Partial<TurnDone> & { sessionId: string }): TurnDone {
  return {
    sessionId: input.sessionId,
    success: input.success ?? true,
    ...(input.numTurns !== undefined ? { numTurns: input.numTurns } : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

// ─── Reset helpers ───────────────────────────────────────────────────────

const INITIAL = {
  messages: {},
  messageIds: [],
  activities: {},
  activityIds: [],
  session: null,
  busy: false,
  lastTurn: null,
  displayMode: 'phone' as const,
  pendingApprovals: {},
  pendingApprovalIds: [],
  selectedModel: undefined,
};

function resetStore(): void {
  // Replace state without clobbering actions.
  useStore.setState(INITIAL);
}

describe('agent-pane store.apply', () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  describe('message events', () => {
    it('inserts a new message and tracks its id', () => {
      useStore.getState().apply({
        type: 'message',
        message: msg({ id: 'm1', role: 'assistant', text: 'hi' }),
      } satisfies BackendEvent);
      const s = useStore.getState();
      expect(s.messageIds).toEqual(['m1']);
      expect(s.messages.m1?.text).toBe('hi');
    });

    it('concatenates text when both existing and incoming are streaming', () => {
      useStore.getState().apply({
        type: 'message',
        message: msg({
          id: 'm1',
          role: 'assistant',
          text: 'hello ',
          streaming: true,
          createdAt: '2026-01-01T00:00:00Z',
        }),
      });
      useStore.getState().apply({
        type: 'message',
        message: msg({
          id: 'm1',
          role: 'assistant',
          text: 'world',
          streaming: true,
          createdAt: '2026-01-01T00:00:01Z',
        }),
      });
      const s = useStore.getState();
      expect(s.messages.m1?.text).toBe('hello world');
      expect(s.messageIds).toEqual(['m1']); // not duplicated
      // createdAt preserved from the first chunk
      expect(s.messages.m1?.createdAt).toBe('2026-01-01T00:00:00Z');
    });

    it('replaces (not concatenates) when the new message is no longer streaming', () => {
      useStore.getState().apply({
        type: 'message',
        message: msg({ id: 'm1', text: 'partial', streaming: true }),
      });
      useStore.getState().apply({
        type: 'message',
        message: msg({ id: 'm1', text: 'final authoritative', streaming: false }),
      });
      expect(useStore.getState().messages.m1?.text).toBe('final authoritative');
    });

    it('preserves original createdAt across replacement', () => {
      const first = '2026-01-01T00:00:00Z';
      useStore.getState().apply({
        type: 'message',
        message: msg({ id: 'm1', createdAt: first, streaming: true }),
      });
      useStore.getState().apply({
        type: 'message',
        message: msg({
          id: 'm1',
          createdAt: '2099-01-01T00:00:00Z',
          streaming: false,
        }),
      });
      expect(useStore.getState().messages.m1?.createdAt).toBe(first);
    });

    it('appends multiple distinct messages in arrival order', () => {
      useStore.getState().apply({ type: 'message', message: msg({ id: 'a' }) });
      useStore.getState().apply({ type: 'message', message: msg({ id: 'b' }) });
      useStore.getState().apply({ type: 'message', message: msg({ id: 'c' }) });
      expect(useStore.getState().messageIds).toEqual(['a', 'b', 'c']);
    });
  });

  describe('activity events', () => {
    it('inserts a new activity', () => {
      useStore.getState().apply({
        type: 'activity',
        activity: act({ id: 'a1', summary: 'reading config' }),
      });
      const s = useStore.getState();
      expect(s.activityIds).toEqual(['a1']);
      expect(s.activities.a1?.summary).toBe('reading config');
    });

    it('overwrites an existing activity with the same id without duplicating', () => {
      useStore.getState().apply({
        type: 'activity',
        activity: act({ id: 'a1', summary: 'starting' }),
      });
      useStore.getState().apply({
        type: 'activity',
        activity: act({ id: 'a1', summary: 'completed' }),
      });
      expect(useStore.getState().activityIds).toEqual(['a1']);
      expect(useStore.getState().activities.a1?.summary).toBe('completed');
    });
  });

  describe('session events', () => {
    it('sets session info on first emit', () => {
      useStore.getState().apply({
        type: 'session',
        session: session({ sessionId: 's1', model: 'opus' }),
      });
      expect(useStore.getState().session).toMatchObject({
        sessionId: 's1',
        model: 'opus',
      });
    });

    it('MERGES instead of replacing — earlier fields survive a partial later update', () => {
      // First emit sets model + cwd
      useStore.getState().apply({
        type: 'session',
        session: session({ sessionId: 's1', model: 'opus', cwd: '/repo' }),
      });
      // Later "ready" emit only carries sessionId + status — model + cwd
      // should be preserved.
      useStore.getState().apply({
        type: 'session',
        session: session({ sessionId: 's1', status: 'ready' }),
      });
      const s = useStore.getState().session;
      expect(s?.model).toBe('opus');
      expect(s?.cwd).toBe('/repo');
      expect(s?.status).toBe('ready');
    });
  });

  describe('turnDone events', () => {
    it('clears busy and records the last turn', () => {
      useStore.setState({ busy: true });
      useStore.getState().apply({
        type: 'turnDone',
        turnDone: turnDone({ sessionId: 's1', success: true, numTurns: 3 }),
      });
      const s = useStore.getState();
      expect(s.busy).toBe(false);
      expect(s.lastTurn?.numTurns).toBe(3);
    });
  });

  describe('permission events', () => {
    it('adds a pending approval', () => {
      useStore.getState().apply({
        type: 'permissionRequest',
        request: permission({ toolUseId: 't1' }),
      });
      const s = useStore.getState();
      expect(s.pendingApprovalIds).toEqual(['t1']);
      expect(s.pendingApprovals.t1?.toolName).toBe('Bash');
    });

    it('deduplicates a re-emitted permission request', () => {
      useStore.getState().apply({
        type: 'permissionRequest',
        request: permission({ toolUseId: 't1' }),
      });
      useStore.getState().apply({
        type: 'permissionRequest',
        request: permission({ toolUseId: 't1', toolName: 'Write' }),
      });
      expect(useStore.getState().pendingApprovalIds).toEqual(['t1']);
      // First write wins
      expect(useStore.getState().pendingApprovals.t1?.toolName).toBe('Bash');
    });

    it('removes the pending approval on permissionResolved', () => {
      useStore.getState().apply({
        type: 'permissionRequest',
        request: permission({ toolUseId: 't1' }),
      });
      useStore.getState().apply({
        type: 'permissionRequest',
        request: permission({ toolUseId: 't2' }),
      });
      useStore.getState().apply({
        type: 'permissionResolved',
        toolUseId: 't1',
      });
      const s = useStore.getState();
      expect(s.pendingApprovalIds).toEqual(['t2']);
      expect(s.pendingApprovals).toEqual({
        t2: expect.objectContaining({ toolUseId: 't2' }),
      });
    });

    it('permissionResolved is a no-op for an unknown toolUseId', () => {
      useStore.getState().apply({
        type: 'permissionResolved',
        toolUseId: 'never-existed',
      });
      const s = useStore.getState();
      expect(s.pendingApprovalIds).toEqual([]);
      expect(s.pendingApprovals).toEqual({});
    });
  });

  describe('pushUserMessage', () => {
    it('appends a user message and marks the store busy', () => {
      useStore.getState().pushUserMessage('hello there');
      const s = useStore.getState();
      expect(s.busy).toBe(true);
      expect(s.messageIds).toHaveLength(1);
      const id = s.messageIds[0]!;
      expect(s.messages[id]?.text).toBe('hello there');
      expect(s.messages[id]?.role).toBe('user');
    });

    it('produces unique ids across rapid sends', () => {
      useStore.getState().pushUserMessage('a');
      useStore.getState().pushUserMessage('b');
      useStore.getState().pushUserMessage('c');
      const { messageIds } = useStore.getState();
      expect(new Set(messageIds).size).toBe(3);
    });
  });

  describe('mode + model + reset', () => {
    it('setDisplayMode flips the displayMode', () => {
      expect(useStore.getState().displayMode).toBe('phone');
      useStore.getState().setDisplayMode('t3');
      expect(useStore.getState().displayMode).toBe('t3');
    });

    it('setSelectedModel updates the selectedModel', () => {
      useStore.getState().setSelectedModel('haiku');
      expect(useStore.getState().selectedModel).toBe('haiku');
    });

    it('resetTranscript wipes transcript state but preserves displayMode + selectedModel', () => {
      useStore.getState().setDisplayMode('t3');
      useStore.getState().setSelectedModel('opus');
      useStore.getState().apply({ type: 'message', message: msg({ id: 'm1' }) });
      useStore.getState().pushUserMessage('hi');

      useStore.getState().resetTranscript();

      const s = useStore.getState();
      expect(s.messages).toEqual({});
      expect(s.messageIds).toEqual([]);
      expect(s.session).toBeNull();
      expect(s.busy).toBe(false);
      // Prefs preserved
      expect(s.displayMode).toBe('t3');
      expect(s.selectedModel).toBe('opus');
    });
  });

  describe('markBusy', () => {
    it('toggles busy in either direction', () => {
      useStore.getState().markBusy(true);
      expect(useStore.getState().busy).toBe(true);
      useStore.getState().markBusy(false);
      expect(useStore.getState().busy).toBe(false);
    });
  });
});
