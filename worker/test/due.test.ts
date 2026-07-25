import { describe, expect, it } from 'vitest';
import type { SubscriberRow } from '../src/db';
import { isDueThisHour, isStarved, selectTick } from '../src/due';

function subscriber(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: 1,
    email: 'reader@example.com',
    status: 'active',
    frequency: 'daily',
    min_score: 0,
    timezone: null,
    send_hour: null,
    created_at: '2026-01-01T00:00:00.000Z',
    confirmed_at: '2026-01-01T00:00:00.000Z',
    unsubscribed_at: null,
    last_sent_at: null,
    last_sent_entry_date: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

describe('isDueThisHour', () => {
  it('always matches when no send_hour/timezone preference is set', () => {
    const now = new Date('2026-07-25T14:00:00.000Z');
    expect(isDueThisHour(subscriber(), now)).toBe(true);
  });

  it('matches only when the local hour equals send_hour', () => {
    // UTC 14:00 is 09:00 in America/Chicago (UTC-5 in July, DST).
    const now = new Date('2026-07-25T14:00:00.000Z');
    expect(isDueThisHour(subscriber({ timezone: 'America/Chicago', send_hour: 9 }), now)).toBe(true);
    expect(isDueThisHour(subscriber({ timezone: 'America/Chicago', send_hour: 10 }), now)).toBe(false);
  });

  it('does not block sending when the stored timezone is invalid', () => {
    const now = new Date('2026-07-25T14:00:00.000Z');
    expect(isDueThisHour(subscriber({ timezone: 'Not/AZone', send_hour: 9 }), now)).toBe(true);
  });
});

describe('isStarved', () => {
  const now = new Date('2026-07-25T14:00:00.000Z');

  it('is false for a daily subscriber well inside 1.25x their interval (30h)', () => {
    const s = subscriber({ frequency: 'daily', last_sent_at: '2026-07-24T20:00:00.000Z' }); // 18h ago
    expect(isStarved(s, now)).toBe(false);
  });

  it('is true for a daily subscriber past 1.25x their interval (30h)', () => {
    const s = subscriber({ frequency: 'daily', last_sent_at: '2026-07-24T07:00:00.000Z' }); // 31h ago
    expect(isStarved(s, now)).toBe(true);
  });

  it('falls back to created_at when never sent', () => {
    const s = subscriber({ frequency: 'daily', last_sent_at: null, created_at: '2026-07-24T07:00:00.000Z' }); // 31h ago
    expect(isStarved(s, now)).toBe(true);
  });

  it('scales the threshold with frequency (weekly ~8.75d)', () => {
    const justUnder = subscriber({ frequency: 'weekly', last_sent_at: '2026-07-17T00:00:00.000Z' }); // ~8.58d ago
    const justOver = subscriber({ frequency: 'weekly', last_sent_at: '2026-07-16T00:00:00.000Z' }); // ~9.58d ago
    expect(isStarved(justUnder, now)).toBe(false);
    expect(isStarved(justOver, now)).toBe(true);
  });
});

describe('selectTick — hour preference', () => {
  it('stops at batchSize and skips candidates outside their preferred hour, without diversity pressure', () => {
    const now = new Date('2026-07-25T14:00:00.000Z'); // 09:00 America/Chicago
    // last_sent_at 1h ago on every candidate — recent enough that none of
    // them trip the starvation guard and hijack this into that branch; the
    // default subscriber()'s Jan 1 created_at would otherwise read as many
    // months overdue against this test's `now` and do exactly that.
    const recent = '2026-07-25T13:00:00.000Z';
    const candidates = [
      subscriber({ id: 1, timezone: 'America/Chicago', send_hour: 3, last_sent_at: recent }), // not due this hour
      subscriber({ id: 2, last_sent_at: recent }), // no preference, always due
      subscriber({ id: 3, last_sent_at: recent }), // no preference, always due
      subscriber({ id: 4, last_sent_at: recent }), // no preference, always due
    ];
    const topics = new Map<number, string[]>([
      [1, ['a']],
      [2, ['a']],
      [3, ['a']],
      [4, ['a']],
    ]);
    const tick = selectTick(candidates, topics, now, 2, 40);
    expect(tick.selected.map((s) => s.id)).toEqual([2, 3]);
    expect(tick.starvationRelief).toBe(false);
  });
});

describe('selectTick — topic-aware greedy selection (6 candidates, union of 25 slugs)', () => {
  // Oldest last_sent_at first, as fetchDueCandidates would return them.
  // A: 8 new slugs.  B: 2 new (t9,t10).  C: 2 new (t11,t12) — same cost as B,
  // but evaluated after B has already spent the remaining budget: tests that
  // the OLDER of two equally-cheap candidates wins when only one fits.
  // D: 0 new (overlaps A) — picked even though C, right before it, was
  // skipped: tests that a later, cheaper candidate isn't blocked by an
  // earlier expensive one. E: 3 new, F: 10 new (own topic list alone already
  // equals the cap) — both never fit alongside anyone else, every tick.
  const A = subscriber({ id: 1, last_sent_at: '2026-07-24T00:00:00.000Z' });
  const B = subscriber({ id: 2, last_sent_at: '2026-07-24T01:00:00.000Z' });
  const C = subscriber({ id: 3, last_sent_at: '2026-07-24T02:00:00.000Z' });
  const D = subscriber({ id: 4, last_sent_at: '2026-07-24T03:00:00.000Z' });
  const E = subscriber({ id: 5, last_sent_at: '2026-07-24T04:00:00.000Z' });
  const F = subscriber({ id: 6, last_sent_at: '2026-07-24T05:00:00.000Z' });
  const candidates = [A, B, C, D, E, F];

  const topics = new Map<number, string[]>([
    [1, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']], // 8
    [2, ['t9', 't10']], // 2
    [3, ['t11', 't12']], // 2
    [4, ['t1', 't2']], // 0 new (overlaps A)
    [5, ['t13', 't14', 't15']], // 3
    [6, ['t16', 't17', 't18', 't19', 't20', 't21', 't22', 't23', 't24', 't25']], // 10
  ]);

  it('the union across all 6 candidates is exactly 25 distinct slugs', () => {
    const all = new Set<string>();
    for (const list of topics.values()) for (const t of list) all.add(t);
    expect(all.size).toBe(25);
  });

  it('respects both the batch-size and topic-file caps, prefers the older of equally-cheap candidates, and lets a later free candidate through despite an earlier skip', () => {
    const now = new Date('2026-07-25T00:00:00.000Z'); // none of these are starved yet
    const tick = selectTick(candidates, topics, now, 6, 10);

    expect(tick.starvationRelief).toBe(false);
    expect(tick.selected.length).toBeLessThanOrEqual(6);
    expect(tick.topicSlugs.size).toBeLessThanOrEqual(10);

    const ids = tick.selected.map((s) => s.id);
    expect(ids).toEqual([1, 2, 4]); // A, B, D

    // B (older, cost 2) wins the last slot; C (younger, equally cheap) does not.
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);

    // D (cost 0) is picked even though C, right before it, was skipped.
    expect(ids).toContain(4);

    expect(tick.topicSlugs.size).toBe(10);
  });

  it('starvation guard: once F has gone unselected long enough, it alone is processed, cap bypassed', () => {
    const now = new Date('2026-07-25T00:00:00.000Z');
    // Everyone but F checked in an hour ago (not starved); F hasn't been
    // selected in 36h — well past the 30h (1.25x daily) starvation line.
    const notStarved = (c: SubscriberRow): SubscriberRow => subscriber({ ...c, last_sent_at: '2026-07-24T23:00:00.000Z' });
    const starvedF = subscriber({ ...F, last_sent_at: '2026-07-23T12:00:00.000Z' });
    const candidatesThisTick = [notStarved(A), notStarved(B), notStarved(C), notStarved(D), notStarved(E), starvedF];

    const tick = selectTick(candidatesThisTick, topics, now, 6, 10);

    expect(tick.starvationRelief).toBe(true);
    expect(tick.selected.map((s) => s.id)).toEqual([6]);
    expect(tick.topicSlugs.size).toBe(10); // F's own 10 topics, cap bypassed
  });
});
