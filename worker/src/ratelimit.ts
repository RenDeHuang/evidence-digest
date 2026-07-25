/** Fixed-window rate limiter backed by the `rate_limits` table. Two windows
 * are checked by callers: per-IP and per-email, each with its own limit.
 *
 * Data retention: a `key` here is either an IP or a SHA-256 hash of a
 * normalized email — the latter is arguably still personal data under a
 * strict reading, even hashed. Rows aren't deleted on unsubscribe (there's
 * nothing to look up by subscriber id — the table isn't keyed that way, and
 * a rate-limit row can outlive or predate any subscription attempt for that
 * address). Instead they age out on their own: every call opportunistically
 * prunes rows from windows more than RETENTION_WINDOWS old before doing
 * anything else, so no row survives long past the window it was ever
 * useful for, with no separate cleanup cron needed. */

const RETENTION_WINDOWS_MS = 2 * 60 * 60 * 1000; // 2 hourly windows of slack past the current one

function windowStart(now: Date): string {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0); // hourly buckets
  return d.toISOString();
}

/** Returns true if the request is allowed (and records it); false if the
 * caller has exceeded `limit` in the current window. */
export async function checkRateLimit(db: D1Database, key: string, limit: number, now: Date): Promise<boolean> {
  const ws = windowStart(now);
  const staleBefore = new Date(now.getTime() - RETENTION_WINDOWS_MS).toISOString();

  await db.prepare(`DELETE FROM rate_limits WHERE window_start < ?1`).bind(staleBefore).run();

  // Upsert-and-read in one round trip: increment, then check the new count.
  await db
    .prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`,
    )
    .bind(key, ws)
    .run();
  const row = await db
    .prepare(`SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2`)
    .bind(key, ws)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= limit;
}

export async function hashKey(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown';
}
