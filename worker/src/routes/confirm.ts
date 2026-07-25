/*
 * GET /api/confirm?token=...
 *
 * Activates a pending subscriber and mints the two long-lived tokens the
 * reader will need from then on. The confirm token itself is single-use:
 * marked used_at immediately so a replayed link can't re-run this handler.
 */
import type { Env } from '../env';
import { redirect, simplePage, html } from '../http';
import { hashToken, newRawToken } from '../tokens';
import { findToken } from '../db';

export async function handleConfirm(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return html(simplePage('Missing token', 'This confirmation link is incomplete.', env.SITE_URL), { status: 400 });
  }

  const hash = await hashToken(token);
  const row = await findToken(env.DB, hash);
  if (!row || row.kind !== 'confirm') {
    return html(
      simplePage(
        'Invalid link',
        'This confirmation link is invalid. If you recently subscribed, check for a more recent email, or subscribe again.',
        env.SITE_URL,
      ),
      { status: 400 },
    );
  }
  if (row.used_at) {
    return html(
      simplePage('Already confirmed', 'This confirmation link has already been used. Your subscription is active.', env.SITE_URL),
      { status: 200 },
    );
  }
  if (row.expires_at && row.expires_at < new Date().toISOString()) {
    return html(
      simplePage('Link expired', 'This confirmation link has expired. Please subscribe again to get a new one.', env.SITE_URL),
      { status: 400 },
    );
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const manageRaw = newRawToken();
  const unsubscribeRaw = newRawToken();

  await env.DB.batch([
    env.DB.prepare(`UPDATE subscribers SET status = 'active', confirmed_at = ?2 WHERE id = ?1`).bind(row.subscriber_id, nowIso),
    env.DB.prepare(`UPDATE tokens SET used_at = ?2 WHERE token_hash = ?1`).bind(hash, nowIso),
    env.DB.prepare(
      `INSERT INTO tokens (token_hash, subscriber_id, kind, created_at, expires_at, used_at) VALUES (?1, ?2, 'manage', ?3, NULL, NULL)`,
    ).bind(await hashToken(manageRaw), row.subscriber_id, nowIso),
    env.DB.prepare(
      `INSERT INTO tokens (token_hash, subscriber_id, kind, created_at, expires_at, used_at) VALUES (?1, ?2, 'unsubscribe', ?3, NULL, NULL)`,
    ).bind(await hashToken(unsubscribeRaw), row.subscriber_id, nowIso),
  ]);

  return redirect(`${env.SITE_URL}/manage?token=${manageRaw}&welcome=1`);
}
