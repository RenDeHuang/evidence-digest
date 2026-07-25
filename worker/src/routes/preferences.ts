/*
 * GET  /api/preferences?token=...   — read back masked email + current prefs
 * POST /api/preferences             — update topics/frequency/minScore
 *
 * Both only accept a 'manage' token. GET never returns the raw email.
 *
 * Because unsubscribing hard-deletes the subscriber (see ../db
 * deleteSubscriberHard), a manage token for a since-deleted subscriber no
 * longer resolves at all — its token row is gone along with everything
 * else. That's a normal, expected state here (a reader who unsubscribed
 * revisiting an old /manage link), not a server error: it degrades to a
 * clean 404 with a friendly message a frontend can render directly, never
 * a 500.
 */
import type { Env } from '../env';
import { maxTopics } from '../env';
import { json, badRequest } from '../http';
import { hashToken } from '../tokens';
import { findToken, findSubscriberById, getSubscriberTopics } from '../db';
import { isValidFrequency, isValidMinScore, readBodyWithSizeLimit, validateTopicsShape } from '../validate';
import { validTopicSlugs } from '../taxonomy';

function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '••••';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const first = local[0] ?? '•';
  const dots = '•'.repeat(Math.max(local.length - 1, 3));
  return `${first}${dots}@${domain}`;
}

/** The clean "this subscription no longer exists" state — used both when
 * the token itself doesn't resolve and (defensively) when it resolves but
 * the subscriber row is somehow already gone. 404, not 400: the request
 * was well-formed, the thing it asked for just isn't there. */
function subscriptionNotFound(): Response {
  return json(
    { ok: false, error: 'not_found', message: 'This subscription link is invalid, or the subscription no longer exists.' },
    { status: 404 },
  );
}

async function resolveManageToken(env: Env, token: string | null): Promise<{ subscriberId: number } | { error: Response }> {
  if (!token) return { error: badRequest('missing_token') };
  const hash = await hashToken(token);
  const row = await findToken(env.DB, hash);
  if (!row || row.kind !== 'manage') {
    return { error: subscriptionNotFound() };
  }
  if (row.expires_at && row.expires_at < new Date().toISOString()) {
    return { error: badRequest('expired_token') };
  }
  return { subscriberId: row.subscriber_id };
}

export async function handleGetPreferences(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const resolved = await resolveManageToken(env, url.searchParams.get('token'));
  if ('error' in resolved) return resolved.error;

  const subscriber = await findSubscriberById(env.DB, resolved.subscriberId);
  if (!subscriber) return subscriptionNotFound();

  const topics = await getSubscriberTopics(env.DB, subscriber.id);
  return json({
    ok: true,
    email: maskEmail(subscriber.email),
    topics,
    frequency: subscriber.frequency,
    minScore: subscriber.min_score,
    status: subscriber.status,
  });
}

export async function handlePostPreferences(request: Request, env: Env): Promise<Response> {
  const bodyText = await readBodyWithSizeLimit(request);
  if (bodyText === null) return badRequest('payload_too_large', 'request body exceeds 8 KB');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return badRequest('invalid_json');
  }

  const resolved = await resolveManageToken(env, typeof body.token === 'string' ? body.token : null);
  if ('error' in resolved) return resolved.error;

  const subscriber = await findSubscriberById(env.DB, resolved.subscriberId);
  if (!subscriber) return subscriptionNotFound();

  const topicsShape = validateTopicsShape(body.topics, maxTopics(env));
  if (!topicsShape.ok) return badRequest('invalid_topics', topicsShape.error);

  if (!isValidFrequency(body.frequency)) return badRequest('invalid_frequency');
  const frequency = body.frequency;

  let minScore = subscriber.min_score;
  if (body.minScore !== undefined) {
    if (!isValidMinScore(body.minScore)) return badRequest('invalid_min_score');
    minScore = body.minScore;
  }

  const { valid, unknown } = await validTopicSlugs(env, topicsShape.topics);
  if (!valid) return badRequest('unknown_topics', `unknown topic slug(s): ${unknown.slice(0, 5).join(', ')}`);

  // Transaction: subscriber row + topic membership update together.
  await env.DB.batch([
    env.DB.prepare(`UPDATE subscribers SET frequency = ?2, min_score = ?3 WHERE id = ?1`).bind(subscriber.id, frequency, minScore),
    env.DB.prepare(`DELETE FROM subscriber_topics WHERE subscriber_id = ?1`).bind(subscriber.id),
    ...topicsShape.topics.map((t) =>
      env.DB.prepare(`INSERT INTO subscriber_topics (subscriber_id, topic_slug) VALUES (?1, ?2)`).bind(subscriber.id, t),
    ),
  ]);

  return json({
    ok: true,
    email: maskEmail(subscriber.email),
    topics: topicsShape.topics,
    frequency,
    minScore,
    status: subscriber.status,
  });
}
