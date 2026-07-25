-- Evidence Digest — initial schema.
--
-- Design notes:
--   * All timestamps are ISO-8601 strings (TEXT), UTC, e.g. "2026-07-24T13:00:00.000Z".
--     D1/SQLite has no native datetime type; storing text keeps values directly
--     comparable with `<`/`>` and readable in `wrangler d1 execute` output.
--   * Every table a request handler touches is reached through an indexed
--     lookup — no full scans on the hot paths (subscribe, confirm, cron).

-- subscribers: one row per email address. The whole system hangs off this
-- table's `id`. `status` gates every read the cron does (only 'active' rows
-- are ever due) and every write a handler does (re-subscribing a 'pending' or
-- 'unsubscribed' row must work; an 'active' row must never be silently
-- overwritten by a second /api/subscribe call).
CREATE TABLE subscribers (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  email                   TEXT NOT NULL UNIQUE,               -- lowercased + trimmed before insert
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'active', 'unsubscribed', 'bounced')),
  frequency               TEXT NOT NULL DEFAULT 'daily'
                            CHECK (frequency IN ('daily', 'weekly', 'monthly')),
  min_score               INTEGER NOT NULL DEFAULT 0 CHECK (min_score BETWEEN 0 AND 100),
  timezone                TEXT,                                -- IANA name, e.g. "America/Chicago"; NULL = no local-hour preference
  send_hour               INTEGER CHECK (send_hour IS NULL OR send_hour BETWEEN 0 AND 23),
  created_at              TEXT NOT NULL,
  confirmed_at            TEXT,
  unsubscribed_at         TEXT,
  last_sent_at            TEXT,                                -- last time the cron *checked* this subscriber, sent or not (drives due-ness)
  last_sent_entry_date    TEXT,                                -- watermark: newest study entryDate actually included in a sent digest
  consecutive_failures    INTEGER NOT NULL DEFAULT 0            -- send.ts flips status to 'bounced' once this crosses a threshold
);

-- subscriber_topics: many-to-many between subscribers and the site's topic
-- slugs. Composite primary key doubles as the index the cron's join needs
-- ("give me every topic for this batch of subscriber ids") and prevents
-- duplicate topic rows for the same subscriber.
CREATE TABLE subscriber_topics (
  subscriber_id  INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  topic_slug     TEXT NOT NULL,
  PRIMARY KEY (subscriber_id, topic_slug)
);

-- Reverse lookup ("who is subscribed to topic X") — not on the cron's hot
-- path today, but cheap to maintain and the natural index for future
-- per-topic analytics or a "how many subscribers" admin view.
CREATE INDEX idx_subscriber_topics_topic ON subscriber_topics(topic_slug);

-- tokens: every link the app ever emails (confirm / manage / unsubscribe)
-- resolves through this table. Only the SHA-256 hash of the token is stored —
-- a stolen database row is useless without also breaking SHA-256, since the
-- raw token never touches disk. Lookups are by primary key (the hash), so a
-- request handler never needs a manual string-compare loop for the token
-- itself (no timing side-channel to guard against there); the equivalent of
-- "constant time" here is that finding a valid hash requires already knowing
-- the 32-byte random token, which is computationally what a timing attack on
-- the compare would also require.
CREATE TABLE tokens (
  token_hash    TEXT PRIMARY KEY,                              -- hex SHA-256 of the base64url token
  subscriber_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('confirm', 'manage', 'unsubscribe')),
  created_at    TEXT NOT NULL,
  expires_at    TEXT,                                          -- NULL for manage/unsubscribe (non-expiring); confirm = created_at + 7d
  used_at       TEXT                                           -- set once for single-use 'confirm' tokens; manage/unsubscribe are reusable and stay NULL
);

-- Needed to find (and revoke) a subscriber's outstanding confirm tokens when
-- they re-subscribe before confirming, and to mint/rotate manage links.
CREATE INDEX idx_tokens_subscriber ON tokens(subscriber_id);

-- send_log: one row per subscriber per cron tick that reached the "did they
-- get mail" decision point — including zero-study checks (study_count = 0,
-- error NULL) and failures (error set). This is the table that answers
-- "why did this person not get an email" without having to reason about
-- current subscriber state, which only reflects the *latest* outcome.
-- Prunable: nothing else joins against it, so old rows can be deleted by
-- sent_at on a schedule if it grows large.
CREATE TABLE send_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id         INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  sent_at               TEXT NOT NULL,
  study_count           INTEGER NOT NULL DEFAULT 0,             -- 0 = checked, nothing new (no email sent — an empty digest is spam)
  provider_message_id   TEXT,                                   -- set on a confirmed successful send
  error                 TEXT                                    -- set on a failed send attempt (truncated provider error body)
);

CREATE INDEX idx_send_log_subscriber ON send_log(subscriber_id, sent_at);

-- rate_limits: fixed-window counter for POST /api/subscribe, keyed by either
-- "ip:<CF-Connecting-IP>" or "email:<sha256 of normalized address>" (the
-- address itself is never stored here). The composite primary key is both
-- the uniqueness constraint for the upsert and the index the check reads.
CREATE TABLE rate_limits (
  key           TEXT NOT NULL,
  window_start  TEXT NOT NULL,                                  -- ISO-8601 start of the current fixed window, truncated to the minute
  count         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (key, window_start)
);

-- meta: tiny singleton key/value store. Today it holds exactly one row,
-- last_cron_at, so GET /api/health can prove the Cron Trigger is actually
-- firing without inferring it from send_log (which stays empty on ticks
-- with no due subscribers).
CREATE TABLE meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
