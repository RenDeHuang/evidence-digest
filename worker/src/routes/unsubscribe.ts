/*
 * GET|POST /api/unsubscribe?token=...
 *
 * GET is the link in the email footer; POST is RFC 8058 one-click
 * (List-Unsubscribe-Post: List-Unsubscribe=One-Click). Both perform the same
 * action. Accepts either a 'manage' or an 'unsubscribe' token.
 *
 * Unsubscribing is a HARD DELETE (see deleteSubscriberHard in ../db and
 * README.md "Data retention") — the subscribers row, all subscriber_topics
 * rows, and all tokens rows for them (including the very token used here)
 * are removed. Which makes this endpoint's idempotence a little different
 * from a soft-flag design: the SECOND click on the same link — or a mail
 * client prefetching it, or a stale/garbled token — finds no matching token
 * at all, because the first click already deleted it. That is not an error
 * case: it gets the exact same friendly "you're unsubscribed" response as a
 * real deletion, both because that's the honest state of the world (this
 * address is not subscribed, whether or not this specific click did that)
 * and because distinguishing the two in the response would let a caller
 * enumerate which unsubscribe tokens were ever valid.
 */
import type { Env } from '../env';
import { html, json, simplePage } from '../http';
import { hashToken } from '../tokens';
import { findToken, deleteSubscriberHard } from '../db';

export async function handleUnsubscribe(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const isGet = request.method === 'GET';

  if (!token) {
    return isGet
      ? html(simplePage('Missing token', 'This unsubscribe link is incomplete.', env.SITE_URL), { status: 400 })
      : json({ ok: false, error: 'missing_token' }, { status: 400 });
  }

  const hash = await hashToken(token);
  const row = await findToken(env.DB, hash);
  if (row && (row.kind === 'manage' || row.kind === 'unsubscribe')) {
    await deleteSubscriberHard(env.DB, row.subscriber_id);
  }
  // A token that doesn't resolve — never existed, wrong kind, or already
  // consumed by an earlier delete — falls straight through to the same
  // success response below. Nothing to do; there is (now) nothing there.

  if (isGet) {
    return html(
      simplePage(
        "You're unsubscribed",
        "You will not receive any more Evidence Digest emails at this address. If this was a mistake, you can subscribe again at any time.",
        env.SITE_URL,
      ),
    );
  }
  return json({ ok: true });
}
