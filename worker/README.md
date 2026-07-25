# Evidence Digest — worker

Cloudflare Worker + D1 + Cron Trigger that emails readers newly-published
studies for the topics they chose. Reads static JSON from the public site
(`SITE_URL`); never touches PubMed directly.

## Endpoints

| Method    | Path                | Body / query                                             | Notes |
|-----------|---------------------|------------------------------------------------------------|-------|
| POST      | `/api/subscribe`    | `{ email, topics[], frequency, minScore?, timezone?, honeypot?, turnstileToken? }` | Enumeration-safe: always the same response. |
| GET       | `/api/confirm`      | `?token=`                                                   | 302 → `SITE_URL/manage?token=...&welcome=1`. |
| GET       | `/api/preferences`  | `?token=` (manage token)                                    | Masked email, topics, frequency, minScore, status. |
| POST      | `/api/preferences`  | `{ token, topics[], frequency, minScore? }`                 | Manage token only. |
| GET/POST  | `/api/unsubscribe`  | `?token=` (manage or unsubscribe token)                     | POST is RFC 8058 one-click. **Hard-deletes** the subscriber — see "Data retention". |
| GET       | `/api/health`       | —                                                            | No PII. |

## Data retention

An email address exists in this database only for as long as its
subscription is active. **Unsubscribing hard-deletes it** — the
`subscribers` row, every `subscriber_topics` row, and every `tokens` row for
that person, atomically in one `db.batch()` (`deleteSubscriberHard` in
`src/db.ts`). This matches the site's `/privacy` page, which promises
deletion rather than a soft opt-out flag. After it runs, that address is not
recoverable from this database in any form; `POST /api/subscribe` from the
same address afterwards just creates a fresh `pending` row, same as any
other new signup.

Two tables needed a deliberate decision rather than a blanket delete:

- **`send_log`** — rows are *kept*, with `subscriber_id` set to `NULL`
  rather than the row being deleted (migration `0002` makes that column
  nullable, `ON DELETE SET NULL` instead of `CASCADE`). A send_log row
  carries no email address or other identifying field, just
  `sent_at`/`study_count`/`provider_message_id`/`error` — an anonymised row
  is defensible to retain, and doing so preserves aggregate delivery/error
  history for operators after someone leaves. Counts survive; identity
  doesn't.
- **`rate_limits`** — rows are *not* touched by unsubscribe at all (the
  table isn't keyed by subscriber id, and a rate-limit hit can predate or
  postdate any actual subscription). Its `email:<sha256>` keys are closer to
  personal data than a send_log row is, so instead they age out on their
  own: every `checkRateLimit()` call opportunistically deletes rows from
  more than two hourly windows ago before doing anything else (see
  `src/ratelimit.ts`) — no row outlives its usefulness, no separate cleanup
  cron required.

`subscribers.status` still permits `'unsubscribed'` in its `CHECK`
constraint and `unsubscribed_at` still exists as a column — left in place
rather than dropped, since that would be a riskier migration for no
correctness benefit — but the application no longer produces either. They're
dead capability from here on; a row simply stops existing instead.

## Run locally

```bash
npm install
cp .dev.vars.example .dev.vars   # add secrets if testing brevo/resend; console needs none
npx wrangler d1 migrations apply evidence-digest-db --local
npx wrangler dev
```

`wrangler dev` needs `SITE_URL`/`API_URL` pointing at something real. For a
zero-dependency local loop, serve the sample tree in `fixtures/` (shaped per
`contract/api.schema.json`) with `cd fixtures && python3 -m http.server 8788`
in a separate terminal, and add to `.dev.vars`:

```
SITE_URL=http://localhost:8788
API_URL=http://localhost:8787
EMAIL_PROVIDER=console
```

Trigger the cron handler manually — this wrangler version exposes it at
`/cdn-cgi/handler/scheduled`, not the older `/__scheduled`:
`curl "http://localhost:8787/cdn-cgi/handler/scheduled"`.

## Migrations

See `migrations/README.md`. Short version: `npx wrangler d1 create
evidence-digest-db`, paste the id into `wrangler.toml`, then
`npx wrangler d1 migrations apply evidence-digest-db --local` (or `--remote`).

## Testing

`npx vitest run`. Two layers:

- **Pure-function tests** (`digest.ts` selection/ranking, `validate.ts`,
  `due.ts` hour matching + topic-aware selection, `tokens.ts` hashing,
  template escaping) — plain vitest, no I/O.
- **DB/route integration tests** (`test/unsubscribe-retention.test.ts`) — the
  unsubscribe hard-delete behaviour needed genuine database coverage, not
  just pure functions. Rather than adding `@cloudflare/vitest-pool-workers`
  (the "fully correct" way to get a real D1 binding in tests, but real
  workerd + workspace config for what's needed here), `test/helpers/fake-d1.ts`
  spins up an in-memory database via Node's built-in `node:sqlite`, applies
  this project's actual `migrations/*.sql` against it, and wraps it in just
  enough of the D1 surface (`prepare().bind().run()/.first()/.all()`,
  `batch()`) for `src/db.ts` and the route handlers to run against
  unmodified. It's real SQL and real transactions, not a mock — genuine
  coverage of `deleteSubscriberHard`, the unsubscribe/preferences routes'
  reaction to what's actually in the database, and a full
  subscribe-confirm-unsubscribe-resubscribe-confirm cycle. Adding the
  workers pool later is still an option if broader D1-integration coverage
  is wanted; this was the narrower, lower-friction path for what this round
  needed.

## Vars and secrets

| Name | Where | Required | Purpose |
|---|---|---|---|
| `SITE_URL` | var | yes | Public site serving `api/manifest.json`, `api/topics/*.json`, `api/taxonomy.json`; also the base for `/manage` links. |
| `API_URL` | var | yes | This worker's own public URL — used for confirm/unsubscribe links (a `scheduled` event has no `request.url` to derive it from). |
| `ALLOWED_ORIGIN` | var | yes | Origin allowed to call body-accepting endpoints via CORS (plus `http://localhost:5173`, always). |
| `EMAIL_PROVIDER` | var | yes | `brevo` \| `resend` \| `console` \| `none`. |
| `EMAIL_FROM` / `EMAIL_FROM_NAME` / `EMAIL_REPLY_TO` | var | yes | Sender identity. |
| `BATCH_SIZE` | var | yes | Due subscribers processed per cron tick, at most (default 15). |
| `MAX_TOPIC_FILES_PER_TICK` | var | yes | Cap on distinct topic files fetched+parsed in one tick (default 10) — the real bound on per-tick work; see "CPU budget" below. |
| `MAX_TOPICS` | var | yes | Hard cap on topics per subscriber (default 40). |
| `BREVO_API_KEY` | secret | if `EMAIL_PROVIDER=brevo` | `wrangler secret put BREVO_API_KEY` |
| `RESEND_API_KEY` | secret | if `EMAIL_PROVIDER=resend` | `wrangler secret put RESEND_API_KEY` |
| `TURNSTILE_SECRET` | secret | no | If present, verifies a `turnstileToken` in the subscribe body; absent = skipped silently. |

## CPU budget

Cloudflare's free plan gives a Worker invocation a CPU-time ceiling (time
spent actually executing JS — awaiting `fetch`/D1 doesn't count). **I am not
certain whether the ceiling for a `scheduled` (cron) invocation is the same
10ms that applies to `fetch` invocations** — that limit has moved more than
once, and I'd rather the code be correct under either reading. So: the design
bounds per-tick work so it stays well inside the 10ms fetch-invocation
budget; if the scheduled budget is more generous, `BATCH_SIZE` and
`MAX_TOPIC_FILES_PER_TICK` can be raised — verify against Cloudflare's
current limits page before doing so.

The dominant per-tick cost is `JSON.parse`-ing topic files, and it scales
with **topic diversity in the batch, not subscriber count** — 15 subscribers
on 3 shared topics is cheap; 15 subscribers on 15 different niche topics is
not. That's why batch selection (`src/due.ts` `selectTick`) is topic-aware:
it greedily admits due subscribers, oldest-first, while the *union* of their
topic slugs stays at or below `MAX_TOPIC_FILES_PER_TICK` (default 10) —
stopping independently of `BATCH_SIZE` (default 15; 15 x 24 = 360/day still
clears Brevo's free 300/day cap with room to spare, 40% less worst-case
per-tick work than the previous default of 25). A subscriber who doesn't fit
this tick simply waits for the next hourly one — normal, already-documented
behaviour. A subscriber whose *own* topic list alone exceeds the cap (e.g.
20 niche topics) would never fit any tick under that rule alone, so a
starvation guard (`isStarved` in `due.ts`) detects when someone has gone
unselected for too long (>1.25x their frequency interval since last send —
inferred from the row, no extra column) and gives that tick over entirely to
processing them, cap bypassed, logged so an operator can see it happening.

One more thing worth knowing: the per-subscriber `db.batch()` commit inside
the cron loop (state written after each subscriber, not once at the end)
means a mid-tick CPU-limit termination is safe — subscribers already
processed keep their state, the rest simply retry next hour. Delays, never
loses or duplicates a send.

## Design notes worth knowing

- **Substantive-only filter.** Only records with `hasAbstract=true` appear in
  the main digest — most newly-indexed PubMed records are letters, replies,
  and news with no abstract, and no publication-type rule reliably separates
  those from research. One exception: a published erratum/retraction is
  pulled into a small "Corrections & retractions" block instead, bypassing
  `min_score`. See the comment at the top of `src/digest.ts`.
- **Digest tokens are minted per send.** `manage`/`unsubscribe` tokens are
  non-expiring by design, but only their hash is ever stored, so a raw token
  can't be recovered to reuse in the *next* digest email. Each cron send
  therefore mints one fresh `manage`-kind token (valid for both managing
  preferences and unsubscribing) rather than reusing the confirm-time one.
  For an active subscriber these accumulate over time (roughly 1 row/send;
  an old digest email's unsubscribe link must keep working, so nothing
  prunes them while the subscription is live) — but the moment that
  subscriber unsubscribes, *all* of their tokens are deleted at once as
  part of the hard delete (see "Data retention"), so the growth is bounded
  by how long someone stays subscribed, not by all-time send volume.
