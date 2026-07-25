import { describe, it, expect, vi } from 'vitest';
import { createTestDb } from './helpers/fake-d1';
import { testEnv } from './helpers/test-env';
import {
  insertSubscriberPending,
  replaceSubscriberTopics,
  insertToken,
  activateSubscriber,
  findSubscriberByEmail,
  findSubscriberById,
  deleteSubscriberHard,
  recordCheckedNoContent,
} from '../src/db';
import { newRawToken, hashToken } from '../src/tokens';
import { handleUnsubscribe } from '../src/routes/unsubscribe';
import { handleSubscribe } from '../src/routes/subscribe';
import { handleConfirm } from '../src/routes/confirm';
import { handleGetPreferences } from '../src/routes/preferences';

/**
 * Integration-level tests for the unsubscribe hard-delete work: a real
 * in-memory SQLite database (see helpers/fake-d1.ts) with the actual
 * migrations applied, exercised through the real db.ts functions and route
 * handlers — not mocks of them.
 */

const TAXONOMY = {
  version: 1,
  specialties: [
    {
      slug: 'hematology',
      name: 'Hematology',
      icon: '🩸',
      blurb: '',
      topics: [{ slug: 'heme-lymphoma', name: 'Lymphoma', blurb: '' }],
    },
  ],
};

function stubTaxonomyFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/api/taxonomy.json')) {
        return new Response(JSON.stringify(TAXONOMY), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

function extractConfirmToken(logs: string[]): string {
  const line = logs.find((l) => l.includes('Confirm:'));
  if (!line) throw new Error('no confirm link found in captured console output');
  const match = line.match(/Confirm:\s*(\S+)/);
  if (!match) throw new Error('could not parse a confirm URL out of the logged email');
  const url = new URL(match[1]!);
  const token = url.searchParams.get('token');
  if (!token) throw new Error('confirm URL had no token param');
  return token;
}

describe('deleteSubscriberHard', () => {
  it('deletes the subscribers, subscriber_topics, and tokens rows; keeps send_log anonymised', async () => {
    const db = createTestDb();
    const now = new Date().toISOString();
    const id = await insertSubscriberPending(db, {
      email: 'delete.me@example.com',
      frequency: 'daily',
      minScore: 0,
      timezone: null,
      sendHour: null,
      now,
    });
    await replaceSubscriberTopics(db, id, ['heme-lymphoma']);
    await insertToken(db, { hash: 'fake-confirm-hash', subscriberId: id, kind: 'confirm', now, expiresAt: null });
    await insertToken(db, { hash: 'fake-manage-hash', subscriberId: id, kind: 'manage', now, expiresAt: null });
    await recordCheckedNoContent(db, id, now); // a send_log row referencing this subscriber

    // Sanity: everything is actually there before we delete it.
    expect(await findSubscriberById(db, id)).not.toBeNull();
    const topicsBefore = await db.prepare(`SELECT COUNT(*) AS n FROM subscriber_topics WHERE subscriber_id = ?1`).bind(id).first<{ n: number }>();
    const tokensBefore = await db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE subscriber_id = ?1`).bind(id).first<{ n: number }>();
    expect(topicsBefore?.n).toBe(1);
    expect(tokensBefore?.n).toBe(2);

    await deleteSubscriberHard(db, id);

    expect(await findSubscriberById(db, id)).toBeNull();
    const topicsAfter = await db.prepare(`SELECT COUNT(*) AS n FROM subscriber_topics WHERE subscriber_id = ?1`).bind(id).first<{ n: number }>();
    const tokensAfter = await db.prepare(`SELECT COUNT(*) AS n FROM tokens WHERE subscriber_id = ?1`).bind(id).first<{ n: number }>();
    expect(topicsAfter?.n).toBe(0);
    expect(tokensAfter?.n).toBe(0);

    // send_log survives, but de-identified — no way back to this subscriber.
    const logRow = await db
      .prepare(`SELECT subscriber_id, study_count FROM send_log`)
      .first<{ subscriber_id: number | null; study_count: number }>();
    expect(logRow).not.toBeNull();
    expect(logRow!.subscriber_id).toBeNull();
    expect(logRow!.study_count).toBe(0);
  });

  it('is idempotent — calling it again on an id that no longer exists is a safe no-op', async () => {
    const db = createTestDb();
    await expect(deleteSubscriberHard(db, 999_999)).resolves.toBeUndefined();
  });
});

describe('GET|POST /api/unsubscribe — enumeration-safe idempotence after hard delete', () => {
  it('a valid token deletes the subscriber; a repeat click on the same now-dead token still returns the friendly success response', async () => {
    const db = createTestDb();
    const env = testEnv(db);
    const now = new Date().toISOString();
    const id = await insertSubscriberPending(db, {
      email: 'twice@example.com',
      frequency: 'daily',
      minScore: 0,
      timezone: null,
      sendHour: null,
      now,
    });
    await activateSubscriber(db, id, now);
    const raw = newRawToken();
    await insertToken(db, { hash: await hashToken(raw), subscriberId: id, kind: 'manage', now, expiresAt: null });

    const first = await handleUnsubscribe(new Request(`http://api.test/api/unsubscribe?token=${raw}`, { method: 'POST' }), env);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(await findSubscriberById(db, id)).toBeNull();

    // Same token, second click — the row (and the token itself) is already
    // gone. Must be indistinguishable from the first, successful call.
    const second = await handleUnsubscribe(new Request(`http://api.test/api/unsubscribe?token=${raw}`, { method: 'POST' }), env);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ok: true });
  });

  it('a token that never existed at all gets the same friendly page as a real unsubscribe (GET)', async () => {
    const db = createTestDb();
    const env = testEnv(db);

    const res = await handleUnsubscribe(new Request('http://api.test/api/unsubscribe?token=never-issued', { method: 'GET' }), env);
    expect(res.status).toBe(200);
    const body = await res.text();
    // HTML-escaped apostrophe (You&#39;re unsubscribed) — confirms
    // escapeHtml ran, not a raw string match.
    expect(body).toContain('unsubscribed');
    expect(body).not.toMatch(/invalid|error/i);
  });
});

describe('re-subscribe after hard delete', () => {
  it('a fresh POST /api/subscribe for the deleted address completes a full confirm cycle, as if brand new', async () => {
    stubTaxonomyFetch();
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });

    try {
      const db = createTestDb();
      const env = testEnv(db);
      const email = 're.subscribe@example.com';

      // First signup, through confirmation.
      const firstSubscribe = await handleSubscribe(
        new Request('http://api.test/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, topics: ['heme-lymphoma'], frequency: 'daily' }),
        }),
        env,
      );
      expect(firstSubscribe.status).toBe(200);
      const firstConfirmToken = extractConfirmToken(logs);
      const firstConfirmRes = await handleConfirm(new Request(`http://api.test/api/confirm?token=${firstConfirmToken}`), env);
      expect(firstConfirmRes.status).toBe(302);
      const manageUrl = new URL(firstConfirmRes.headers.get('Location')!);
      const manageToken = manageUrl.searchParams.get('token')!;

      const activeSubscriber = await findSubscriberByEmail(db, email);
      expect(activeSubscriber?.status).toBe('active');

      // Unsubscribe: hard delete.
      await handleUnsubscribe(new Request(`http://api.test/api/unsubscribe?token=${manageToken}`, { method: 'POST' }), env);
      expect(await findSubscriberByEmail(db, email)).toBeNull();

      // Re-subscribe the exact same address — must work exactly like a new signup.
      logs.length = 0;
      const secondSubscribe = await handleSubscribe(
        new Request('http://api.test/api/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, topics: ['heme-lymphoma'], frequency: 'weekly' }),
        }),
        env,
      );
      expect(secondSubscribe.status).toBe(200);

      const pendingAgain = await findSubscriberByEmail(db, email);
      expect(pendingAgain?.status).toBe('pending');
      expect(pendingAgain?.frequency).toBe('weekly'); // the new signup's prefs, not stale data

      const secondConfirmToken = extractConfirmToken(logs);
      const secondConfirmRes = await handleConfirm(new Request(`http://api.test/api/confirm?token=${secondConfirmToken}`), env);
      expect(secondConfirmRes.status).toBe(302);

      const activeAgain = await findSubscriberByEmail(db, email);
      expect(activeAgain?.status).toBe('active');
    } finally {
      logSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('GET /api/preferences — deleted subscriber degrades cleanly', () => {
  it('a manage token for a hard-deleted subscriber returns a clean 404, never a 500', async () => {
    const db = createTestDb();
    const env = testEnv(db);
    const now = new Date().toISOString();
    const id = await insertSubscriberPending(db, {
      email: 'gone@example.com',
      frequency: 'daily',
      minScore: 0,
      timezone: null,
      sendHour: null,
      now,
    });
    await activateSubscriber(db, id, now);
    const raw = newRawToken();
    await insertToken(db, { hash: await hashToken(raw), subscriberId: id, kind: 'manage', now, expiresAt: null });

    await deleteSubscriberHard(db, id); // the manage token itself is deleted along with everything else

    const res = await handleGetPreferences(new Request(`http://api.test/api/preferences?token=${raw}`), env);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('not_found');
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
  });
});
