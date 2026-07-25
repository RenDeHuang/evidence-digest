import type { Frequency } from '../../shared/types';
import type { TokenKind } from './tokens';

/** 'unsubscribed' remains a valid schema value (see migrations/0001) but is
 * no longer produced: unsubscribing hard-deletes the row instead (see
 * deleteSubscriberHard below and README.md "Data retention"). Kept in the
 * type/schema rather than removed to avoid an unnecessary breaking
 * migration for a value that simply stops occurring going forward. */
export type SubscriberStatus = 'pending' | 'active' | 'unsubscribed' | 'bounced';

export interface SubscriberRow {
  id: number;
  email: string;
  status: SubscriberStatus;
  frequency: Frequency;
  min_score: number;
  timezone: string | null;
  send_hour: number | null;
  created_at: string;
  confirmed_at: string | null;
  unsubscribed_at: string | null;
  last_sent_at: string | null;
  last_sent_entry_date: string | null;
  consecutive_failures: number;
}

export async function findSubscriberByEmail(db: D1Database, email: string): Promise<SubscriberRow | null> {
  return db.prepare(`SELECT * FROM subscribers WHERE email = ?1`).bind(email).first<SubscriberRow>();
}

export async function findSubscriberById(db: D1Database, id: number): Promise<SubscriberRow | null> {
  return db.prepare(`SELECT * FROM subscribers WHERE id = ?1`).bind(id).first<SubscriberRow>();
}

export async function getSubscriberTopics(db: D1Database, subscriberId: number): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT topic_slug FROM subscriber_topics WHERE subscriber_id = ?1`)
    .bind(subscriberId)
    .all<{ topic_slug: string }>();
  return (results ?? []).map((r) => r.topic_slug);
}

export async function replaceSubscriberTopics(db: D1Database, subscriberId: number, topics: string[]): Promise<void> {
  const statements = [
    db.prepare(`DELETE FROM subscriber_topics WHERE subscriber_id = ?1`).bind(subscriberId),
    ...topics.map((t) =>
      db.prepare(`INSERT INTO subscriber_topics (subscriber_id, topic_slug) VALUES (?1, ?2)`).bind(subscriberId, t),
    ),
  ];
  await db.batch(statements);
}

export interface TokenRow {
  token_hash: string;
  subscriber_id: number;
  kind: TokenKind;
  created_at: string;
  expires_at: string | null;
  used_at: string | null;
}

export async function insertToken(
  db: D1Database,
  params: { hash: string; subscriberId: number; kind: TokenKind; now: string; expiresAt: string | null },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tokens (token_hash, subscriber_id, kind, created_at, expires_at, used_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
    )
    .bind(params.hash, params.subscriberId, params.kind, params.now, params.expiresAt)
    .run();
}

export async function findToken(db: D1Database, hash: string): Promise<TokenRow | null> {
  return db.prepare(`SELECT * FROM tokens WHERE token_hash = ?1`).bind(hash).first<TokenRow>();
}

export async function markTokenUsed(db: D1Database, hash: string, now: string): Promise<void> {
  await db.prepare(`UPDATE tokens SET used_at = ?2 WHERE token_hash = ?1`).bind(hash, now).run();
}

export async function deleteUnusedConfirmTokens(db: D1Database, subscriberId: number): Promise<void> {
  await db
    .prepare(`DELETE FROM tokens WHERE subscriber_id = ?1 AND kind = 'confirm' AND used_at IS NULL`)
    .bind(subscriberId)
    .run();
}

export async function insertSubscriberPending(
  db: D1Database,
  params: { email: string; frequency: Frequency; minScore: number; timezone: string | null; sendHour: number | null; now: string },
): Promise<number> {
  const result = await db
    .prepare(
      `INSERT INTO subscribers (email, status, frequency, min_score, timezone, send_hour, created_at)
       VALUES (?1, 'pending', ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(params.email, params.frequency, params.minScore, params.timezone, params.sendHour, params.now)
    .run();
  return result.meta.last_row_id as number;
}

export async function resetSubscriberToPending(
  db: D1Database,
  params: { id: number; frequency: Frequency; minScore: number; timezone: string | null; sendHour: number | null; now: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE subscribers
       SET status = 'pending', frequency = ?2, min_score = ?3, timezone = ?4, send_hour = ?5,
           unsubscribed_at = NULL, consecutive_failures = 0
       WHERE id = ?1`,
    )
    .bind(params.id, params.frequency, params.minScore, params.timezone, params.sendHour)
    .run();
}

export async function activateSubscriber(db: D1Database, id: number, now: string): Promise<void> {
  await db
    .prepare(`UPDATE subscribers SET status = 'active', confirmed_at = ?2 WHERE id = ?1`)
    .bind(id, now)
    .run();
}

export async function updateSubscriberPrefs(
  db: D1Database,
  params: { id: number; frequency: Frequency; minScore: number },
): Promise<void> {
  await db
    .prepare(`UPDATE subscribers SET frequency = ?2, min_score = ?3 WHERE id = ?1`)
    .bind(params.id, params.frequency, params.minScore)
    .run();
}

/** Unsubscribing is a hard delete, not a status flag — see migrations/0002
 * and README.md "Data retention". Removes everything that identifies this
 * subscriber (the subscribers row, all subscriber_topics rows, all tokens
 * rows — including the very token used to call this) atomically in one
 * db.batch(). send_log rows are kept but de-identified (subscriber_id set
 * to NULL) rather than deleted: they carry no email address, just
 * aggregate delivery history, so an anonymised row is defensible to retain
 * — see the migration file for the full rationale. rate_limits is
 * untouched here; it ages out on its own (src/ratelimit.ts).
 *
 * Safe to call on an id that no longer exists (every statement here is a
 * no-op DELETE/UPDATE on zero rows) — callers rely on that for idempotence:
 * a second click on the same unsubscribe link must not error. */
export async function deleteSubscriberHard(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE send_log SET subscriber_id = NULL WHERE subscriber_id = ?1`).bind(id),
    db.prepare(`DELETE FROM tokens WHERE subscriber_id = ?1`).bind(id),
    db.prepare(`DELETE FROM subscriber_topics WHERE subscriber_id = ?1`).bind(id),
    db.prepare(`DELETE FROM subscribers WHERE id = ?1`).bind(id),
  ]);
}

export async function activeSubscriberCount(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM subscribers WHERE status = 'active'`).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Bulk topic lookup for a batch of subscriber ids in one round trip —
 * exactly the join the cron does once per tick, never per subscriber. */
export async function getTopicsForSubscribers(db: D1Database, ids: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>();
  for (const id of ids) map.set(id, []);
  if (ids.length === 0) return map;
  const placeholders = ids.map((_, i) => `?${i + 1}`).join(',');
  const { results } = await db
    .prepare(`SELECT subscriber_id, topic_slug FROM subscriber_topics WHERE subscriber_id IN (${placeholders})`)
    .bind(...ids)
    .all<{ subscriber_id: number; topic_slug: string }>();
  for (const r of results ?? []) map.get(r.subscriber_id)?.push(r.topic_slug);
  return map;
}

/** Nothing new for this subscriber this tick: advance the "checked at"
 * clock (so due-ness resets) but leave the entryDate watermark untouched —
 * an empty digest is spam, so nothing was actually sent. */
export async function recordCheckedNoContent(db: D1Database, subscriberId: number, now: string): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE subscribers SET last_sent_at = ?2 WHERE id = ?1`).bind(subscriberId, now),
    db
      .prepare(`INSERT INTO send_log (subscriber_id, sent_at, study_count, provider_message_id, error) VALUES (?1, ?2, 0, NULL, NULL)`)
      .bind(subscriberId, now),
  ]);
}

export async function recordSendSuccess(
  db: D1Database,
  params: { id: number; now: string; newestEntryDate: string | null; studyCount: number; providerMessageId: string },
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE subscribers SET last_sent_at = ?2, last_sent_entry_date = COALESCE(?3, last_sent_entry_date), consecutive_failures = 0 WHERE id = ?1`,
      )
      .bind(params.id, params.now, params.newestEntryDate),
    db
      .prepare(`INSERT INTO send_log (subscriber_id, sent_at, study_count, provider_message_id, error) VALUES (?1, ?2, ?3, ?4, NULL)`)
      .bind(params.id, params.now, params.studyCount, params.providerMessageId),
  ]);
}

/** A failed send does NOT advance last_sent_at, so the subscriber stays
 * "due" and is retried next tick — unless consecutive failures cross the
 * bounce threshold, at which point status flips to 'bounced' and they fall
 * out of dueSubscribers() on their own (only 'active' rows are selected).
 * `immediateBounce` short-circuits the threshold for a permanent (4xx,
 * non-429) provider error — a permanently-invalid address should not waste
 * several more ticks' worth of send attempts before giving up. */
export async function recordSendFailure(
  db: D1Database,
  params: { id: number; now: string; consecutiveFailures: number; bounceThreshold: number; error: string; immediateBounce?: boolean },
): Promise<void> {
  const newFailures = params.consecutiveFailures + 1;
  const status = params.immediateBounce || newFailures >= params.bounceThreshold ? 'bounced' : 'active';
  await db.batch([
    db.prepare(`UPDATE subscribers SET consecutive_failures = ?2, status = ?3 WHERE id = ?1`).bind(params.id, newFailures, status),
    db
      .prepare(`INSERT INTO send_log (subscriber_id, sent_at, study_count, provider_message_id, error) VALUES (?1, ?2, 0, NULL, ?3)`)
      .bind(params.id, params.now, params.error.slice(0, 500)),
  ]);
}

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT value FROM meta WHERE key = ?1`).bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(`INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2`)
    .bind(key, value)
    .run();
}
