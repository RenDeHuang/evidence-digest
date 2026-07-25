/*
 * security.txt-style note on this file's trust model
 * ----------------------------------------------------------------------
 * This Worker handles strangers' email addresses on a public, unauthenticated
 * API. The design assumptions:
 *
 *   - No caller is trusted. Every body is size-capped (8 KB) and shape-
 *     validated before touching the database. Topic slugs are re-validated
 *     against the site's live api/taxonomy.json on every write — a client
 *     can send any string, so the taxonomy fetched from SITE_URL, not the
 *     request, is the source of truth for "does this topic exist".
 *
 *   - Possession of a token is the only credential in this system. Tokens
 *     are 32 random bytes (crypto.getRandomValues), base64url-encoded, and
 *     only their SHA-256 hash is ever persisted (migrations/0001_init.sql).
 *     A leaked database row does not leak a usable token.
 *
 *   - No endpoint ever reveals whether an email address is already
 *     subscribed. POST /api/subscribe returns byte-identical responses for
 *     "new address", "already pending", "already active", and "bot filled
 *     the honeypot" — the only observable difference lives in an email only
 *     the address owner can read. GET|POST /api/unsubscribe returns the same
 *     friendly "you're unsubscribed" response whether the token was valid,
 *     already used, or never existed — see routes/unsubscribe.ts.
 *
 *   - An address exists in this system only for as long as its subscription
 *     is active. Unsubscribing DELETES it — the subscribers row, every
 *     subscriber_topics row, and every tokens row for that person — not a
 *     status flag (migrations/0002_unsubscribe_hard_delete.sql,
 *     db.ts deleteSubscriberHard, README.md "Data retention"). After that
 *     completes the address is not recoverable from this database in any
 *     form; a later /api/subscribe from the same address starts fresh.
 *
 *   - GET /api/health is intentionally aggregate-only (counts, a version
 *     number, a timestamp) — never a subscriber id, address, or token.
 *     console.log never includes an address; where a row needs identifying
 *     in logs, only the numeric subscriber id is used.
 *
 *   - CORS never uses "*". Only ALLOWED_ORIGIN (the production site) and
 *     http://localhost:5173 (dev) can call this API from browser JS — see
 *     src/cors.ts.
 *
 * Report a vulnerability: see the SITE_URL footer for a contact address.
 * ----------------------------------------------------------------------
 */
import type { Env } from './env';
import { json, notFound, methodNotAllowed } from './http';
import { handlePreflight, withCors } from './cors';
import { handleSubscribe } from './routes/subscribe';
import { handleConfirm } from './routes/confirm';
import { handleGetPreferences, handlePostPreferences } from './routes/preferences';
import { handleUnsubscribe } from './routes/unsubscribe';
import { handleHealth } from './routes/health';
import { runScheduled } from './scheduled';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') return handlePreflight(request, env);

    let response: Response;
    try {
      response = await route(request, env, pathname, method);
    } catch (err) {
      console.log(`[http] unhandled error on ${pathname}: ${err instanceof Error ? err.message : 'unknown error'}`);
      response = json({ ok: false, error: 'internal_error' }, { status: 500 });
    }

    // Only the body-accepting endpoints strictly need CORS headers, but
    // applying them uniformly (never "*") is simpler and no less safe.
    return withCors(response, request, env);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
};

async function route(request: Request, env: Env, pathname: string, method: string): Promise<Response> {
  if (pathname === '/api/subscribe') {
    if (method !== 'POST') return methodNotAllowed();
    return handleSubscribe(request, env);
  }

  if (pathname === '/api/confirm') {
    if (method !== 'GET') return methodNotAllowed();
    return handleConfirm(request, env);
  }

  if (pathname === '/api/preferences') {
    if (method === 'GET') return handleGetPreferences(request, env);
    if (method === 'POST') return handlePostPreferences(request, env);
    return methodNotAllowed();
  }

  if (pathname === '/api/unsubscribe') {
    if (method === 'GET' || method === 'POST') return handleUnsubscribe(request, env);
    return methodNotAllowed();
  }

  if (pathname === '/api/health') {
    if (method !== 'GET') return methodNotAllowed();
    return handleHealth(request, env);
  }

  return notFound();
}
