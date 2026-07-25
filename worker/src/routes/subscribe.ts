/*
 * POST /api/subscribe
 *
 * Trust model: the caller supplies an email address and a set of topic
 * slugs. Topic slugs are NEVER trusted — every one is checked against the
 * site's live api/taxonomy.json. The response is enumeration-safe: whether
 * the address is new, already pending, already active, previously
 * unsubscribed, or bounced, the HTTP response body is byte-identical, so a
 * script cannot use this endpoint to discover who is subscribed.
 */
import type { Env } from '../env';
import { maxTopics } from '../env';
import { json, badRequest } from '../http';
import {
  isValidEmail,
  isValidFrequency,
  isValidMinScore,
  isValidTimezone,
  normalizeEmail,
  readBodyWithSizeLimit,
  validateTopicsShape,
} from '../validate';
import { validTopicSlugs, getTaxonomy, topicNames } from '../taxonomy';
import { checkRateLimit, clientIp, hashKey } from '../ratelimit';
import {
  findSubscriberByEmail,
  insertSubscriberPending,
  resetSubscriberToPending,
  replaceSubscriberTopics,
  deleteUnusedConfirmTokens,
  insertToken,
} from '../db';
import { newRawToken, hashToken, confirmExpiry } from '../tokens';
import { getEmailProvider } from '../email';
import { confirmEmail, manageLinkEmail } from '../templates/confirm';
import { verifyTurnstile } from '../turnstile';

const IP_LIMIT_PER_HOUR = 10;
const EMAIL_LIMIT_PER_HOUR = 5;

// Always the same shape, regardless of what actually happened — see the
// trust-model note above.
const GENERIC_SUCCESS = {
  ok: true,
  message:
    "If that address is new, check your inbox to confirm. If it's already subscribed, we've emailed a fresh link to manage your preferences.",
};

export async function handleSubscribe(request: Request, env: Env): Promise<Response> {
  const bodyText = await readBodyWithSizeLimit(request);
  if (bodyText === null) return badRequest('payload_too_large', 'request body exceeds 8 KB');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    return badRequest('invalid_json');
  }
  if (typeof body !== 'object' || body === null) return badRequest('invalid_json');

  // Honeypot: a bot fills this field. Return the same success response an
  // honest user gets, so it learns nothing, and do no further work.
  if (typeof body.honeypot === 'string' && body.honeypot.trim().length > 0) {
    return json(GENERIC_SUCCESS);
  }

  if (env.EMAIL_PROVIDER === 'none') {
    return json(
      {
        ok: false,
        error: 'email_not_configured',
        message:
          'Email delivery is not configured on this deployment, so we cannot accept new email subscriptions. ' +
          'Use the Atom feeds instead — every topic has one, and they need no signup: ' +
          `${env.SITE_URL}/feeds/all.xml (or ${env.SITE_URL}/feeds/<topic-slug>.xml for a single topic).`,
      },
      { status: 503 },
    );
  }

  if (typeof body.email !== 'string' || !isValidEmail(body.email)) {
    return badRequest('invalid_email');
  }
  const email = normalizeEmail(body.email);

  const topicsShape = validateTopicsShape(body.topics, maxTopics(env));
  if (!topicsShape.ok) return badRequest('invalid_topics', topicsShape.error);

  if (!isValidFrequency(body.frequency)) return badRequest('invalid_frequency');
  const frequency = body.frequency;

  let minScore = 0;
  if (body.minScore !== undefined) {
    if (!isValidMinScore(body.minScore)) return badRequest('invalid_min_score');
    minScore = body.minScore;
  }

  let timezone: string | null = null;
  if (body.timezone !== undefined && body.timezone !== null) {
    if (!isValidTimezone(body.timezone)) return badRequest('invalid_timezone');
    timezone = body.timezone;
  }

  const ip = clientIp(request);
  const emailKey = `email:${await hashKey(email)}`;
  const now = new Date();
  const ipOk = await checkRateLimit(env.DB, `ip:${ip}`, IP_LIMIT_PER_HOUR, now);
  const emailOk = await checkRateLimit(env.DB, emailKey, EMAIL_LIMIT_PER_HOUR, now);
  if (!ipOk || !emailOk) {
    return json({ ok: false, error: 'rate_limited', message: 'Too many requests. Try again later.' }, { status: 429 });
  }

  if (body.turnstileToken !== undefined) {
    const passed = await verifyTurnstile(env, body.turnstileToken, ip);
    if (!passed) return badRequest('turnstile_failed');
  }

  const { valid, unknown } = await validTopicSlugs(env, topicsShape.topics);
  if (!valid) return badRequest('unknown_topics', `unknown topic slug(s): ${unknown.slice(0, 5).join(', ')}`);

  const provider = getEmailProvider(env);
  if (!provider) {
    // EMAIL_PROVIDER named a provider but its secret is missing — fail closed,
    // but don't leak configuration detail to the caller.
    return json({ ok: false, error: 'email_not_configured' }, { status: 503 });
  }

  const existing = await findSubscriberByEmail(env.DB, email);
  const nowIso = now.toISOString();

  if (existing && existing.status === 'active') {
    // Never overwrite an active subscriber's preferences from a bare
    // /api/subscribe call. Send them a fresh manage link instead.
    const manageRaw = newRawToken();
    await insertToken(env.DB, {
      hash: await hashToken(manageRaw),
      subscriberId: existing.id,
      kind: 'manage',
      now: nowIso,
      expiresAt: null,
    });
    const manageUrl = `${env.SITE_URL}/manage?token=${manageRaw}`;
    const rendered = manageLinkEmail({ manageUrl, siteUrl: env.SITE_URL });
    await trySend(provider, env, email, rendered);
    return json(GENERIC_SUCCESS);
  }

  let subscriberId: number;
  if (existing) {
    // pending / unsubscribed / bounced: re-subscribing must work and must
    // re-send the confirmation, using the freshly submitted preferences.
    await resetSubscriberToPending(env.DB, {
      id: existing.id,
      frequency,
      minScore,
      timezone,
      sendHour: existing.send_hour,
      now: nowIso,
    });
    await deleteUnusedConfirmTokens(env.DB, existing.id);
    subscriberId = existing.id;
  } else {
    subscriberId = await insertSubscriberPending(env.DB, {
      email,
      frequency,
      minScore,
      timezone,
      sendHour: null,
      now: nowIso,
    });
  }
  await replaceSubscriberTopics(env.DB, subscriberId, topicsShape.topics);

  const confirmRaw = newRawToken();
  await insertToken(env.DB, {
    hash: await hashToken(confirmRaw),
    subscriberId,
    kind: 'confirm',
    now: nowIso,
    expiresAt: confirmExpiry(now),
  });
  const confirmUrl = `${env.API_URL}/api/confirm?token=${confirmRaw}`;
  const { taxonomy } = await getTaxonomy(env);
  const rendered = confirmEmail({
    topicNames: topicNames(taxonomy, topicsShape.topics),
    frequency,
    confirmUrl,
    siteUrl: env.SITE_URL,
    expiryDays: 7,
  });
  await trySend(provider, env, email, rendered);

  return json(GENERIC_SUCCESS);
}

async function trySend(
  provider: NonNullable<ReturnType<typeof getEmailProvider>>,
  env: Env,
  to: string,
  rendered: { subject: string; html: string; text: string },
): Promise<void> {
  try {
    await provider.send({
      to,
      from: { email: env.EMAIL_FROM, name: env.EMAIL_FROM_NAME },
      replyTo: env.EMAIL_REPLY_TO,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      tags: ['transactional'],
    });
  } catch (err) {
    // Never let a provider hiccup change the enumeration-safe response, and
    // never log the address — the subscriber id isn't known at this call
    // site by design (kept local to routes/subscribe.ts), so log nothing
    // beyond the error shape.
    console.log(`[subscribe] transactional send failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  }
}
