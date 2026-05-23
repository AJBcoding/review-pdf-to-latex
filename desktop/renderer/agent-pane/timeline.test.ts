// Unit tests for buildTimeline — the pure derivation that merges messages
// and activities into a chronological timeline with consecutive activities
// grouped into workGroup entries.
import { describe, expect, it } from 'vitest';
import { buildTimeline } from './timeline';
import type {
  ChatMessage,
  ThreadActivity,
} from '@shared/agent-pane/types';

function msg(id: string, createdAt: string, role: 'user' | 'assistant' = 'user'): ChatMessage {
  return { id, role, text: `text-${id}`, createdAt, streaming: false };
}

function act(id: string, createdAt: string): ThreadActivity {
  return {
    id,
    createdAt,
    tone: 'info',
    kind: 'tool.started',
    summary: `summary-${id}`,
  };
}

function build(input: {
  messages?: ChatMessage[];
  activities?: ThreadActivity[];
  displayMode?: 'phone' | 't3';
}): ReturnType<typeof buildTimeline> {
  const msgArr = input.messages ?? [];
  const actArr = input.activities ?? [];
  return buildTimeline({
    messageIds: msgArr.map((m) => m.id),
    activityIds: actArr.map((a) => a.id),
    messages: Object.fromEntries(msgArr.map((m) => [m.id, m])),
    activities: Object.fromEntries(actArr.map((a) => [a.id, a])),
    displayMode: input.displayMode ?? 't3',
  });
}

describe('buildTimeline', () => {
  it('returns empty list when no messages or activities', () => {
    expect(build({})).toEqual([]);
  });

  it('emits messages in order without grouping', () => {
    const result = build({
      messages: [
        msg('m1', '2026-01-01T00:00:00Z'),
        msg('m2', '2026-01-01T00:00:01Z'),
      ],
    });
    expect(result.map((e) => e.kind)).toEqual(['message', 'message']);
    expect(result.map((e) => e.id)).toEqual(['m1', 'm2']);
  });

  it('groups consecutive activities into a single workGroup', () => {
    const result = build({
      activities: [
        act('a1', '2026-01-01T00:00:00Z'),
        act('a2', '2026-01-01T00:00:01Z'),
        act('a3', '2026-01-01T00:00:02Z'),
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ kind: 'workGroup', id: 'wg-a1' });
    if (result[0]?.kind === 'workGroup') {
      expect(result[0].data.map((a) => a.id)).toEqual(['a1', 'a2', 'a3']);
    }
  });

  it('splits workGroups around interleaved messages', () => {
    const result = build({
      messages: [
        msg('m1', '2026-01-01T00:00:00Z'),
        msg('m2', '2026-01-01T00:00:03Z'),
      ],
      activities: [
        act('a1', '2026-01-01T00:00:01Z'),
        act('a2', '2026-01-01T00:00:02Z'),
        act('a3', '2026-01-01T00:00:04Z'),
      ],
    });
    expect(result.map((e) => e.kind)).toEqual([
      'message',
      'workGroup',
      'message',
      'workGroup',
    ]);
    expect(result.map((e) => e.id)).toEqual(['m1', 'wg-a1', 'm2', 'wg-a3']);
  });

  it('hides all activities in phone mode', () => {
    const result = build({
      messages: [msg('m1', '2026-01-01T00:00:00Z')],
      activities: [act('a1', '2026-01-01T00:00:01Z')],
      displayMode: 'phone',
    });
    expect(result.map((e) => e.kind)).toEqual(['message']);
    expect(result.map((e) => e.id)).toEqual(['m1']);
  });

  it('messages come before activities at the same timestamp (tiebreaker)', () => {
    const result = build({
      messages: [msg('m1', '2026-01-01T00:00:00Z')],
      activities: [act('a1', '2026-01-01T00:00:00Z')],
    });
    expect(result.map((e) => e.id)).toEqual(['m1', 'wg-a1']);
  });

  it('preserves the order of messageIds even if createdAt is identical', () => {
    const result = build({
      messages: [
        msg('m1', '2026-01-01T00:00:00Z'),
        msg('m2', '2026-01-01T00:00:00Z'),
      ],
    });
    expect(result.map((e) => e.id)).toEqual(['m1', 'm2']);
  });

  it('drops messageIds whose message is not in the messages map', () => {
    const result = buildTimeline({
      messageIds: ['m1', 'missing'],
      activityIds: [],
      messages: { m1: msg('m1', '2026-01-01T00:00:00Z') },
      activities: {},
      displayMode: 't3',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('m1');
  });

  it('drops activityIds whose activity is not in the activities map', () => {
    const result = buildTimeline({
      messageIds: [],
      activityIds: ['a1', 'missing'],
      messages: {},
      activities: { a1: act('a1', '2026-01-01T00:00:00Z') },
      displayMode: 't3',
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('wg-a1');
  });

  it('uses the first activity in a group for the createdAt + id', () => {
    const result = build({
      activities: [
        act('a1', '2026-01-01T00:00:00Z'),
        act('a2', '2026-01-01T00:00:05Z'),
      ],
    });
    expect(result[0]).toMatchObject({
      kind: 'workGroup',
      id: 'wg-a1',
      createdAt: '2026-01-01T00:00:00Z',
    });
  });
});
