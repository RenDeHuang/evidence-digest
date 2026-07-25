#!/usr/bin/env bash
#
# setup-cloudflare.sh — the one command an operator runs to switch email digests on.
#
# Evidence Digest works fully as a free, anonymous, read-only site with no Cloudflare
# account at all: the site, the topic feeds, and the daily harvest never touch this
# script. This script is ONLY for the optional email half — a Cloudflare Worker + D1
# database that stores subscriber preferences and sends digests through Brevo.
#
# It is meant to be safe to re-run: it checks what already exists before creating
# anything, so running it twice does not create a second database or clobber a
# secret you already set (it will ask before doing anything destructive).
#
# What it does, in order:
#   1. Checks for node/npx.
#   2. Logs in to Cloudflare via `wrangler login` if not already authenticated.
#   3. Creates the `evidence-digest-db` D1 database (or reuses it if it already
#      exists — that is the exact name worker/wrangler.toml and worker/package.json's
#      migrate:remote script already expect).
#   4. Patches the returned database_id into worker/wrangler.toml (backing up the
#      original to worker/wrangler.toml.bak first).
#   5. Applies D1 migrations to the remote database.
#   6. Prompts for a Brevo API key and stores it with `wrangler secret put` — the key
#      is read silently and is never echoed, logged, or written to disk by this script.
#   7. Prompts for a verified Brevo sender address and the site's public URL, and
#      writes EMAIL_PROVIDER ("brevo"), EMAIL_FROM, SITE_URL, and ALLOWED_ORIGIN
#      into wrangler.toml's [vars] block — none of these are secret, they are
#      public configuration the Worker reads at runtime (see worker/src/env.ts).
#      Skipping EMAIL_PROVIDER specifically would leave the Worker silently
#      logging to console instead of sending real email, even with a valid key.
#   8. Deploys the Worker, then patches the just-learned deployed URL into
#      API_URL (used to build absolute links in emails — the scheduled/cron
#      handler has no incoming request to derive this from) and deploys once
#      more so that change takes effect.
#   9. Curls the deployed Worker's /api/health endpoint, confirms it reports
#      provider "brevo", and prints the exact VITE_WORKER_URL line to add as a
#      GitHub repository variable, which is what switches the signup form on
#      in the web app.
#
# See evidence-digest-docs/deployment.md for the full walkthrough, including what
# stays broken (an honest "email is not switched on" state, not a crash) if you
# skip this script entirely.

set -euo pipefail

# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKER_DIR="${REPO_ROOT}/worker"
WRANGLER_TOML="${WORKER_DIR}/wrangler.toml"
# Must match worker/wrangler.toml's [[d1_databases]].database_name and
# worker/package.json's migrate:local/migrate:remote scripts exactly.
DB_NAME="evidence-digest-db"

step()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
info()  { printf '    %s\n' "$1"; }
ok()    { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
die() {
  printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '  Fix: %s\n' "$2" >&2; fi
  exit 1
}

# Patches (or inserts) `key = "value"` under wrangler.toml's [vars] table.
# Used for every non-secret var this script sets (EMAIL_PROVIDER, EMAIL_FROM,
# SITE_URL, ALLOWED_ORIGIN, API_URL) so there is exactly one, tested TOML-edit
# implementation rather than five near-duplicates. Uses JSON.stringify to quote
# the value, which is a safe superset of TOML's basic-string escaping for the
# plain URLs/addresses this script ever writes.
patch_toml_var() {
  local key="$1" value="$2"
  node -e "
    const fs = require('fs');
    const path = process.argv[1];
    const key = process.argv[2];
    const value = process.argv[3];
    let text = fs.readFileSync(path, 'utf8');
    const keyPattern = new RegExp('^(\\\\s*' + key + '\\\\s*=\\\\s*)\"[^\"]*\"', 'm');
    if (keyPattern.test(text)) {
      text = text.replace(keyPattern, (_m, prefix) => prefix + JSON.stringify(value));
    } else if (/^\[vars\]\s*\$/m.test(text)) {
      text = text.replace(/^\[vars\]\s*\$/m, (line) => line + '\\n' + key + ' = ' + JSON.stringify(value));
    } else {
      text = text.trimEnd() + '\\n\\n[vars]\\n' + key + ' = ' + JSON.stringify(value) + '\\n';
    }
    fs.writeFileSync(path, text);
  " "$WRANGLER_TOML" "$key" "$value"
}

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------

step 'Checking prerequisites'

if [ ! -d "$WORKER_DIR" ]; then
  die "worker/ does not exist at ${WORKER_DIR}." \
      'Run this script from a checkout that has the worker/ directory (Cloudflare Worker source). If you are on a fresh clone, make sure you are on a commit where worker/ has been added.'
fi

if ! command -v node >/dev/null 2>&1; then
  die 'node is not installed or not on PATH.' \
      'Install Node.js 20+ (https://nodejs.org) and re-run this script.'
fi

if ! command -v npx >/dev/null 2>&1; then
  die 'npx is not installed or not on PATH (it normally ships with Node.js).' \
      'Reinstall Node.js 20+ (https://nodejs.org) and re-run this script.'
fi

ok "node found: $(node --version)"
ok "npx found: $(npx --version)"

# ---------------------------------------------------------------------------
# 1. Cloudflare login
# ---------------------------------------------------------------------------

step 'Checking Cloudflare authentication'
info 'Running `wrangler whoami` to see if you are already logged in.'

WHOAMI_OUTPUT="$(cd "$WORKER_DIR" && npx wrangler whoami 2>&1 || true)"

if echo "$WHOAMI_OUTPUT" | grep -qi 'not authenticated'; then
  info 'Not authenticated yet. Opening `wrangler login` — a browser window will open for you to approve access.'
  (cd "$WORKER_DIR" && npx wrangler login) \
    || die 'wrangler login did not complete.' 'Re-run this script and complete the browser authorization step when it opens.'
  ok 'Logged in to Cloudflare.'
else
  ok 'Already authenticated with Cloudflare.'
  info "$(echo "$WHOAMI_OUTPUT" | grep -i 'account' || true)"
fi

# ---------------------------------------------------------------------------
# 2. D1 database: create, or reuse if it already exists
# ---------------------------------------------------------------------------

step "Looking for an existing D1 database named \"${DB_NAME}\""
info 'Running `wrangler d1 list` so re-running this script does not create a duplicate database.'

D1_LIST_JSON="$(cd "$WORKER_DIR" && npx wrangler d1 list --json 2>/dev/null || echo '[]')"

DB_ID="$(node -e "
  let list = [];
  try { list = JSON.parse(process.argv[1]); } catch { list = []; }
  const match = (Array.isArray(list) ? list : []).find(
    (d) => d && (d.name === process.argv[2] || d.database_name === process.argv[2])
  );
  process.stdout.write(match ? (match.uuid || match.database_id || '') : '');
" "$D1_LIST_JSON" "$DB_NAME")"

if [ -n "$DB_ID" ]; then
  ok "Found existing database \"${DB_NAME}\" (id: ${DB_ID}). Reusing it — not creating a new one."
else
  step "Creating D1 database \"${DB_NAME}\""
  CREATE_OUTPUT="$(cd "$WORKER_DIR" && npx wrangler d1 create "$DB_NAME" --json 2>&1)" \
    || die "wrangler d1 create ${DB_NAME} failed." \
           'Check the output above — a common cause is an account-level D1 limit. See evidence-digest-docs/deployment.md.'

  DB_ID="$(node -e "
    try {
      const parsed = JSON.parse(process.argv[1]);
      process.stdout.write(parsed.database_id || (parsed.d1_databases && parsed.d1_databases[0] && parsed.d1_databases[0].database_id) || '');
    } catch {
      process.stdout.write('');
    }
  " "$CREATE_OUTPUT" 2>/dev/null || true)"

  if [ -z "$DB_ID" ]; then
    # Fall back to scraping a UUID out of the human-readable output, in case this
    # wrangler version doesn't support --json for `d1 create` yet.
    DB_ID="$(echo "$CREATE_OUTPUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1 || true)"
  fi

  if [ -z "$DB_ID" ]; then
    die 'Created the database but could not parse a database_id out of the wrangler output.' \
        "Copy the database_id shown above by hand into ${WRANGLER_TOML}'s [[d1_databases]] block, then re-run this script — it will detect the database on the next pass and skip creation."
  fi

  ok "Created database \"${DB_NAME}\" (id: ${DB_ID})."
fi

# ---------------------------------------------------------------------------
# 3. Patch database_id into wrangler.toml
# ---------------------------------------------------------------------------

step "Patching database_id into $(basename "$WRANGLER_TOML")"

if [ ! -f "$WRANGLER_TOML" ]; then
  die "${WRANGLER_TOML} does not exist." \
      'This file should ship as part of worker/ with a [[d1_databases]] block already present (missing database_id). Pull the latest worker/ source and re-run.'
fi

cp "$WRANGLER_TOML" "${WRANGLER_TOML}.bak"
info "Backed up the original to $(basename "$WRANGLER_TOML").bak"

# database_id lives inside [[d1_databases]], not [vars] — patch_toml_var's
# "key not found, append under [vars]" fallback is specifically NOT what we
# want here, so this one case stays a direct, narrower patch rather than
# reusing that helper.
PATCH_RESULT="$(node -e "
  const fs = require('fs');
  const path = process.argv[1];
  const dbId = process.argv[2];
  let text = fs.readFileSync(path, 'utf8');
  const pattern = /^(\s*database_id\s*=\s*)\"[^\"]*\"/m;
  if (pattern.test(text)) {
    text = text.replace(pattern, (_m, prefix) => prefix + JSON.stringify(dbId));
    fs.writeFileSync(path, text);
    process.stdout.write('patched');
  } else {
    process.stdout.write('missing');
  }
" "$WRANGLER_TOML" "$DB_ID")"

if [ "$PATCH_RESULT" = 'patched' ]; then
  ok "database_id set to ${DB_ID}."
else
  die "Could not find a 'database_id = \"...\"' line in ${WRANGLER_TOML} to patch." \
      "Add a [[d1_databases]] block with binding = \"DB\", database_name = \"${DB_NAME}\", database_id = \"${DB_ID}\" by hand, then re-run this script — it will skip this step once the line exists."
fi

# ---------------------------------------------------------------------------
# 4. Apply D1 migrations
# ---------------------------------------------------------------------------

step 'Applying D1 migrations to the remote database'

if [ -d "${WORKER_DIR}/migrations" ] && [ -n "$(ls -A "${WORKER_DIR}/migrations" 2>/dev/null)" ]; then
  (cd "$WORKER_DIR" && npx wrangler d1 migrations apply "$DB_NAME" --remote) \
    || die 'wrangler d1 migrations apply failed.' \
           "Check the output above. You can re-run this script safely — already-applied migrations are skipped by wrangler."
  ok 'Migrations applied.'
else
  info "No worker/migrations/ directory (or it is empty) — skipping. If the Worker needs D1 tables, add migration .sql files under worker/migrations/ first."
fi

# ---------------------------------------------------------------------------
# 5. Brevo API key
# ---------------------------------------------------------------------------

step 'Setting the Brevo API key'

EXISTING_SECRETS="$(cd "$WORKER_DIR" && npx wrangler secret list 2>/dev/null || echo '[]')"
if echo "$EXISTING_SECRETS" | grep -q 'BREVO_API_KEY'; then
  info 'A secret named BREVO_API_KEY already exists for this Worker.'
  read -r -p '    Replace it with a new value? [y/N] ' REPLACE_KEY
  REPLACE_KEY="${REPLACE_KEY:-N}"
else
  REPLACE_KEY='y'
fi

if [[ "$REPLACE_KEY" =~ ^[Yy] ]]; then
  info 'Get an API key from Brevo: Settings -> SMTP & API -> API Keys (https://app.brevo.com/settings/keys/api).'
  info 'It will be read silently — nothing you type here is echoed to the terminal, logged, or written to disk by this script.'
  read -r -s -p '    Paste your Brevo API key and press Enter: ' BREVO_API_KEY
  echo
  if [ -z "$BREVO_API_KEY" ]; then
    die 'No API key entered.' 'Re-run the script and paste a non-empty Brevo API key.'
  fi
  printf '%s' "$BREVO_API_KEY" | (cd "$WORKER_DIR" && npx wrangler secret put BREVO_API_KEY) \
    || die 'wrangler secret put BREVO_API_KEY failed.' 'Check the output above and re-run.'
  unset BREVO_API_KEY
  ok 'BREVO_API_KEY stored (its value is never displayed by this script, wrangler, or the Cloudflare dashboard again).'
else
  ok 'Keeping the existing BREVO_API_KEY.'
fi

# ---------------------------------------------------------------------------
# 6. Verified sender address, site URL, and switching EMAIL_PROVIDER on
# ---------------------------------------------------------------------------

step 'Setting email configuration in wrangler.toml [vars]'
info 'None of the following are secret — they are plain config the Worker reads at'
info 'runtime (see worker/src/env.ts), same as any other wrangler.toml var.'
echo

info 'Verified "From" address — must already be verified as a sender in Brevo:'
info 'Settings -> Senders, Domains & Dedicated IPs -> Senders.'
read -r -p '    Verified "From" address, e.g. digest@yourdomain.org: ' EMAIL_FROM
if [ -z "$EMAIL_FROM" ]; then
  die 'No sender address entered.' 'Re-run the script and provide the address you verified in Brevo.'
fi

echo
info 'Public site URL — where the deployed web app lives (e.g. your GitHub Pages'
info 'URL). Used to build links back to the site from emails, and to set the'
info 'origin this Worker accepts requests from (CORS).'
read -r -p '    Site URL, e.g. https://you.github.io/evidence-digest/: ' SITE_URL_INPUT
if [ -z "$SITE_URL_INPUT" ]; then
  die 'No site URL entered.' 'Re-run the script and provide the URL the site is (or will be) deployed at.'
fi

# ALLOWED_ORIGIN is compared against the browser's `Origin` header, which is
# always scheme+host(+port) only — never a path — so it must be derived from
# SITE_URL rather than reused verbatim (a GitHub Pages project-page URL like
# https://you.github.io/evidence-digest/ has a path; its origin does not).
ALLOWED_ORIGIN="$(node -e "try { process.stdout.write(new URL(process.argv[1]).origin); } catch { process.stdout.write(''); }" "$SITE_URL_INPUT")"
if [ -z "$ALLOWED_ORIGIN" ]; then
  die "\"${SITE_URL_INPUT}\" doesn't look like a valid URL." 'Include the scheme, e.g. https://you.github.io/evidence-digest/, and re-run.'
fi

patch_toml_var 'EMAIL_FROM' "$EMAIL_FROM"
patch_toml_var 'SITE_URL' "$SITE_URL_INPUT"
patch_toml_var 'ALLOWED_ORIGIN' "$ALLOWED_ORIGIN"
# Switching this on is the actual point of running this script — wrangler.toml
# ships with EMAIL_PROVIDER="console" (log-only) so that `wrangler dev` works
# with zero credentials out of the box.
patch_toml_var 'EMAIL_PROVIDER' 'brevo'

ok "EMAIL_FROM=${EMAIL_FROM}, SITE_URL=${SITE_URL_INPUT}, ALLOWED_ORIGIN=${ALLOWED_ORIGIN}, EMAIL_PROVIDER=brevo."

# ---------------------------------------------------------------------------
# 7. Deploy
# ---------------------------------------------------------------------------

step 'Deploying the Worker'

DEPLOY_OUTPUT="$(cd "$WORKER_DIR" && npx wrangler deploy 2>&1)" \
  || { echo "$DEPLOY_OUTPUT" >&2; die 'wrangler deploy failed.' 'Check the output above — a syntax error in wrangler.toml (from the patches above) is the most likely cause. The original is saved at wrangler.toml.bak if you need to compare.'; }

echo "$DEPLOY_OUTPUT"

WORKER_URL="$(echo "$DEPLOY_OUTPUT" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -n1 || true)"

if [ -z "$WORKER_URL" ]; then
  die 'Deploy appears to have succeeded but no *.workers.dev URL was found in its output.' \
      'Check the deploy output above for the URL (it may be a custom route instead of workers.dev), set API_URL and VITE_WORKER_URL to it by hand, and re-deploy with `npm run deploy` in worker/.'
fi

ok "Deployed: ${WORKER_URL}"

# API_URL is the Worker's own public URL, used to build absolute links (e.g.
# the confirm/unsubscribe links in an email) — it can only be known AFTER the
# first deploy prints it, so this necessarily takes a second deploy to take
# effect. The scheduled/cron handler in particular has no incoming
# request.url to derive this from the way an HTTP request does.
step 'Setting API_URL to the deployed URL and redeploying'
patch_toml_var 'API_URL' "$WORKER_URL"
(cd "$WORKER_DIR" && npx wrangler deploy >/dev/null 2>&1) \
  || die 'Redeploying with the updated API_URL failed.' 'Check `cd worker && npx wrangler deploy` output directly and re-run this script.'
ok "API_URL set to ${WORKER_URL} and redeployed."

# ---------------------------------------------------------------------------
# 8. Health check
# ---------------------------------------------------------------------------

step 'Checking /api/health'

HEALTH_FILE="$(mktemp)"
HEALTH_STATUS="$(curl -s -o "$HEALTH_FILE" -w '%{http_code}' "${WORKER_URL}/api/health" || echo '000')"

if [ "$HEALTH_STATUS" = '200' ]; then
  ok "Worker is healthy (HTTP 200): $(cat "$HEALTH_FILE")"
  if grep -q '"provider":"brevo"' "$HEALTH_FILE" 2>/dev/null || grep -q '"provider": *"brevo"' "$HEALTH_FILE" 2>/dev/null; then
    ok 'Confirmed: the deployed Worker reports EMAIL_PROVIDER=brevo.'
  else
    echo "The Worker is up, but /api/health doesn't report provider \"brevo\" — check $(basename "$WRANGLER_TOML")'s [vars] and the output above." >&2
  fi
else
  echo "Health check returned HTTP ${HEALTH_STATUS}." >&2
  echo "This can be normal for the first few seconds after a deploy — try: curl ${WORKER_URL}/api/health" >&2
fi
rm -f "$HEALTH_FILE"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

step 'Done — one manual step left'
cat <<EOF

Email is switched on for the Worker itself. To switch it on in the WEB APP, add
a repository variable so the next build points the signup form at your Worker:

  1. Go to: Settings -> Secrets and variables -> Actions -> Variables (repository variables)
  2. Add:
       Name:  VITE_WORKER_URL
       Value: ${WORKER_URL}
  3. Re-run the "Pages" workflow (or wait for the next harvest) to rebuild the site
     with it — until then, /subscribe and /manage will keep showing their honest
     "email isn't switched on yet" state instead of a broken form.

EOF
