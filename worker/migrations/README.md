# Migrations

- `0001_init.sql` — subscribers, subscriber_topics, tokens, send_log,
  rate_limits, meta. Each table has a comment above it explaining why it
  exists.
- `0002_unsubscribe_hard_delete.sql` — makes `send_log.subscriber_id`
  nullable (`ON DELETE SET NULL` instead of `CASCADE`) so it can outlive a
  hard-deleted subscriber. See the comment at the top of that file for the
  full retention rationale — also summarised in `README.md`'s "Data
  retention" section.

## First-time setup

```bash
cd worker
npx wrangler d1 create evidence-digest-db
# paste the printed database_id into wrangler.toml's [[d1_databases]] block
```

## Apply migrations

Local (used by `wrangler dev` and by the VERIFY steps in this repo):

```bash
npx wrangler d1 migrations apply evidence-digest-db --local
```

Remote (the production/staging D1 instance):

```bash
npx wrangler d1 migrations apply evidence-digest-db --remote
```

Wrangler tracks which migrations have already applied in a bookkeeping table
inside the database itself, so re-running either command is safe — only new
files in `migrations/` get applied.

## Adding a new migration

Add `000N_description.sql` — never edit a migration that has already shipped.
Apply it locally first, confirm the app still works, then apply remotely.
