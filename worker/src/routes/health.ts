/*
 * GET /api/health — liveness + basic operational visibility. No PII: only
 * aggregate counts, never subscriber ids or addresses.
 */
import type { Env } from '../env';
import { json } from '../http';
import { activeSubscriberCount, getMeta } from '../db';
import { fetchManifest } from '../digest';

export async function handleHealth(_request: Request, env: Env): Promise<Response> {
  const [subscriberCount, lastCronAt, lastSubstantiveCount] = await Promise.all([
    activeSubscriberCount(env.DB),
    getMeta(env.DB, 'last_cron_at'),
    getMeta(env.DB, 'last_substantive_count'),
  ]);

  let dataVersion: number | null = null;
  try {
    const manifest = await fetchManifest(env);
    dataVersion = manifest.dataVersion;
  } catch {
    dataVersion = null;
  }

  return json({
    ok: true,
    dataVersion,
    subscriberCount,
    provider: env.EMAIL_PROVIDER,
    lastCronAt,
    // Distinct substantive (hasAbstract=true) studies seen across the topic
    // files the most recent cron tick actually fetched — lets an operator
    // tell "no emails went out because there was nothing new" apart from
    // "the cron didn't run" or "the mail provider failed". Null until the
    // first tick with at least one due subscriber.
    lastSubstantiveCount: lastSubstantiveCount === null ? null : Number(lastSubstantiveCount),
  });
}
