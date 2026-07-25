-- Unsubscribing is now a hard delete of the subscriber's personal data (see
-- "Data retention" in worker/README.md), not a status='unsubscribed' soft
-- flag. That was a real bug: the site's /privacy page already promised
-- deletion, and the code was keeping the row. src/db.ts's
-- deleteSubscriberHard() removes the subscribers row plus every
-- subscriber_topics and tokens row for them, atomically.
--
-- That means send_log rows can now outlive the subscriber they were about,
-- so subscriber_id has to become nullable and its ON DELETE action changes
-- from CASCADE to SET NULL. SQLite/D1 can't ALTER a column's NOT NULL-ness
-- or a foreign key's ON DELETE action in place, so the table is rebuilt.
--
-- Decision (send_log): KEEP the row, NULL the subscriber_id, rather than
-- deleting it alongside the subscriber. A send_log row carries no email
-- address or other identifying field — just sent_at / study_count /
-- provider_message_id / error — so an anonymised row is defensible to keep,
-- and it preserves aggregate delivery/error-rate history for operators
-- after someone leaves. deleteSubscriberHard() nulls it explicitly (it does
-- not rely on this FK action actually firing, since D1's enforcement of
-- declared FK actions isn't something this code depends on either way).
--
-- Decision (rate_limits): NOT touched by this migration or by
-- deleteSubscriberHard(). Its `email:<sha256>` keys are closer to
-- identifying data than send_log's rows are, but they're also what stops
-- the /api/subscribe endpoint being used to spam an address, and a
-- short-lived hash has no long-term operational value once its rate-limit
-- window has passed. So instead of retaining them, checkRateLimit() in
-- src/ratelimit.ts now opportunistically deletes rows older than a couple
-- of hours on every call — they age out continuously with no separate
-- cleanup cron needed, and no row survives past its usefulness.
--
-- Also note: `subscribers.status` still allows 'unsubscribed' and
-- `unsubscribed_at` still exists, but the application no longer produces
-- either — unsubscribing deletes the row outright instead. They're left in
-- the schema rather than dropped (a riskier migration) since dropping a
-- CHECK value / column wasn't asked for and isn't needed for correctness;
-- they're simply dead capability from here on.
CREATE TABLE send_log_new (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id         INTEGER REFERENCES subscribers(id) ON DELETE SET NULL,
  sent_at               TEXT NOT NULL,
  study_count           INTEGER NOT NULL DEFAULT 0,
  provider_message_id   TEXT,
  error                 TEXT
);

INSERT INTO send_log_new (id, subscriber_id, sent_at, study_count, provider_message_id, error)
  SELECT id, subscriber_id, sent_at, study_count, provider_message_id, error FROM send_log;

DROP TABLE send_log;
ALTER TABLE send_log_new RENAME TO send_log;

CREATE INDEX idx_send_log_subscriber ON send_log(subscriber_id, sent_at);
