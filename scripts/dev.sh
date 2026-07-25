#!/usr/bin/env bash
#
# dev.sh — start everything needed for local development in one command.
#
# Runs three things side by side:
#   1. A tiny static file server over data/api/ + data/feeds/ (whatever the pipeline
#      has already built from the archive on your machine), standing in for what
#      GitHub Pages serves in production.
#   2. `vite dev` for the web app (web/), pointed at that static server.
#   3. `wrangler dev` for the Cloudflare Worker (worker/), if worker/ exists —
#      skipped with an explanation otherwise, since the site works fine without it.
#
# Ctrl-C stops all three cleanly.
#
# This script deliberately does NOT write anything into web/ or worker/ — it only
# runs their existing `npm`/`npx` commands and serves data/api + data/feeds (a
# top-level, gitignored build directory) from a separate process, so it never
# touches source files owned by the pipeline/web/worker workstreams.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${REPO_ROOT}/web"
WORKER_DIR="${REPO_ROOT}/worker"
DATA_DIR="${REPO_ROOT}/data"
API_PORT="${EVIDENCE_DIGEST_API_PORT:-8788}"
VITE_PORT="${EVIDENCE_DIGEST_VITE_PORT:-5173}"

# The evidence_digest package lives under pipeline/ and is never pip-installed
# (stdlib only, by design), so it must be on the import path explicitly for the
# `python -m evidence_digest.cli build` call below.
export PYTHONPATH="${REPO_ROOT}/pipeline${PYTHONPATH:+:${PYTHONPATH}}"

step()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
info()  { printf '    %s\n' "$1"; }

PIDS=()

cleanup() {
  step 'Shutting down'
  for pid in "${PIDS[@]:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  wait 2>/dev/null || true
  info 'All dev processes stopped.'
}
trap cleanup INT TERM EXIT

# ---------------------------------------------------------------------------
# 1. Build (or explain how to build) the static API from the local archive
# ---------------------------------------------------------------------------

step 'Preparing local data'

if [ -d "${DATA_DIR}/archive" ] && [ -n "$(ls -A "${DATA_DIR}/archive" 2>/dev/null)" ]; then
  info 'Building data/api + data/feeds from the existing archive...'
  (cd "$REPO_ROOT" && python -m evidence_digest.cli build --site-url "http://localhost:${VITE_PORT}/") \
    || info 'Build failed — see the error above. The dev server will still start, serving whatever was last built (or nothing).'
else
  cat <<EOF
    No archive found at data/archive/ — the site will render an empty state until
    you populate one. To get real data locally, run one of:

      python -m evidence_digest.cli harvest --days 3
      python -m evidence_digest.cli backfill --start <YYYY-MM-DD>

    then re-run this script.
EOF
fi

mkdir -p "${DATA_DIR}/api" "${DATA_DIR}/feeds"

# ---------------------------------------------------------------------------
# 2. Serve data/api + data/feeds
# ---------------------------------------------------------------------------

step "Serving data/ at http://localhost:${API_PORT}/"
python3 -m http.server "$API_PORT" --directory "$DATA_DIR" >/tmp/evidence-digest-dev-data.log 2>&1 &
PIDS+=("$!")
info "API:   http://localhost:${API_PORT}/api/manifest.json"
info "Feeds: http://localhost:${API_PORT}/feeds/all.xml"

# ---------------------------------------------------------------------------
# 3. Web app
# ---------------------------------------------------------------------------

step 'Starting the web app (vite dev)'

if [ ! -d "${WEB_DIR}/node_modules" ]; then
  info 'web/node_modules missing — installing dependencies first (one-time)...'
  (cd "$WEB_DIR" && { [ -f package-lock.json ] && npm ci || npm install; })
fi

(
  cd "$WEB_DIR" && \
  VITE_BASE='/' \
  VITE_API_BASE="http://localhost:${API_PORT}/api" \
  VITE_WORKER_URL="${VITE_WORKER_URL:-http://localhost:8787}" \
  npx vite dev --port "$VITE_PORT"
) &
PIDS+=("$!")
info "Web app: http://localhost:${VITE_PORT}/ (starting — first compile takes a moment)"

# ---------------------------------------------------------------------------
# 4. Worker (optional — only if worker/ exists)
# ---------------------------------------------------------------------------

step 'Starting the Cloudflare Worker (wrangler dev)'

if [ -d "$WORKER_DIR" ] && [ -f "${WORKER_DIR}/package.json" ]; then
  if [ ! -d "${WORKER_DIR}/node_modules" ]; then
    info 'worker/node_modules missing — installing dependencies first (one-time)...'
    (cd "$WORKER_DIR" && { [ -f package-lock.json ] && npm ci || npm install; })
  fi
  (cd "$WORKER_DIR" && npx wrangler dev) &
  PIDS+=("$!")
  info 'Worker: http://localhost:8787/ (default wrangler dev port — see worker/wrangler.toml if it differs)'
else
  info 'worker/ not found — skipping. The site works fully without it; email signup will'
  info 'render its honest "not switched on" state. See scripts/setup-cloudflare.sh when you want it.'
fi

# ---------------------------------------------------------------------------
# Done — wait for Ctrl-C
# ---------------------------------------------------------------------------

step 'Everything that is going to start has started'
info 'Press Ctrl-C to stop all dev processes.'

wait
