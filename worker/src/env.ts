/** Cloudflare bindings + vars + secrets available to every handler. */
export interface Env {
  DB: D1Database;

  // vars (wrangler.toml [vars])
  API_URL: string;
  SITE_URL: string;
  ALLOWED_ORIGIN: string;
  EMAIL_PROVIDER: string; // "brevo" | "resend" | "console" | "none"
  EMAIL_FROM: string;
  EMAIL_FROM_NAME: string;
  EMAIL_REPLY_TO: string;
  BATCH_SIZE: string;
  MAX_TOPICS: string;
  MAX_TOPIC_FILES_PER_TICK: string;

  // secrets (wrangler secret put)
  BREVO_API_KEY?: string;
  RESEND_API_KEY?: string;
  TURNSTILE_SECRET?: string;
}

export function batchSize(env: Env): number {
  const n = parseInt(env.BATCH_SIZE, 10);
  return Number.isFinite(n) && n > 0 ? n : 15;
}

export function maxTopics(env: Env): number {
  const n = parseInt(env.MAX_TOPICS, 10);
  return Number.isFinite(n) && n > 0 ? n : 40;
}

/** Cap on distinct topic files fetched+parsed in one cron tick — the
 * dominant CPU cost per tick (see digest.ts / scheduled.ts). Batch selection
 * is topic-aware (src/due.ts selectTick) precisely so this cap, not
 * BATCH_SIZE, is what actually bounds per-tick work. */
export function maxTopicFilesPerTick(env: Env): number {
  const n = parseInt(env.MAX_TOPIC_FILES_PER_TICK, 10);
  return Number.isFinite(n) && n > 0 ? n : 10;
}
