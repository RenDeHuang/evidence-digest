#!/usr/bin/env bash
#
# first-run.sh — turn a fresh clone into a repo with real data in it.
#
# A brand-new clone has config but no data: data/archive/ is empty (it's the one
# thing CI commits, and there won't be any commits yet on a fresh fork). This
# script is what makes the site non-empty on day one, before the first scheduled
# harvest.yml run even happens. It is safe to re-run — `backfill` skips PMIDs
# already recorded in data/state/seen/, so running this twice just confirms
# nothing changed rather than double-harvesting.
#
# Steps: validate config -> check journal abbreviations -> backfill ~30 days of
# history -> build the static API -> report what you got.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

step()  { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
info()  { printf '    %s\n' "$1"; }
ok()    { printf '\033[1;32m    ✓ %s\033[0m\n' "$1"; }
die() {
  printf '\n\033[1;31m✗ %s\033[0m\n' "$1" >&2
  if [ -n "${2:-}" ]; then printf '  Fix: %s\n' "$2" >&2; fi
  exit 1
}

# The evidence_digest package lives under pipeline/ and is never pip-installed
# (this project is stdlib-only by design), so it must be put on the import path
# explicitly for every `python3 -m evidence_digest.cli ...` call below.
# pipeline/evidence_digest/config.py resolves data/ etc. relative to the
# package file itself, so this is safe regardless of the caller's cwd.
export PYTHONPATH="${REPO_ROOT}/pipeline${PYTHONPATH:+:${PYTHONPATH}}"

if ! command -v python3 >/dev/null 2>&1; then
  die 'python3 is not on PATH.' 'Install Python 3.12+ and re-run.'
fi

# ---------------------------------------------------------------------------
# 1. Validate configuration
# ---------------------------------------------------------------------------

step 'Validating pipeline/config/*.json against contract/config.schema.json'
python3 -m evidence_digest.cli validate \
  || die 'Configuration is invalid.' \
         'Fix the errors above in pipeline/config/ before continuing — nothing downstream can succeed with an invalid config.'
ok 'Configuration is valid.'

# ---------------------------------------------------------------------------
# 2. Check journal abbreviations against live PubMed
# ---------------------------------------------------------------------------

step 'Checking journal abbreviations (queries PubMed — this makes real network requests)'
info 'This confirms every "ta" in journals.json actually resolves to hits on PubMed.'
python3 -m evidence_digest.cli check \
  || die 'One or more journals failed the check.' \
         'A 0-hit journal almost always means its "ta" abbreviation is wrong — see evidence-digest-docs/operations.md, "Fix a rotted journal abbreviation".'
ok 'All journal abbreviations resolve.'

# ---------------------------------------------------------------------------
# 3. Backfill ~30 days of history
# ---------------------------------------------------------------------------

START_DATE="$(python3 -c "import datetime; print((datetime.date.today() - datetime.timedelta(days=30)).isoformat())")"

step "Backfilling from ${START_DATE} through today"
info 'This queries every watched journal once per day in the window — expect this to take a while.'
info 'Set NCBI_API_KEY and PUBMED_EMAIL as environment variables first to backfill at 10 req/s instead of 3.'
python3 -m evidence_digest.cli backfill --start "$START_DATE" \
  || die 'Backfill did not complete.' \
         'Check the error above. It is safe to just re-run this script — backfill skips PMIDs already recorded in data/state/seen/, so a partial backfill resumes rather than restarting.'
ok "Backfill from ${START_DATE} complete."

# ---------------------------------------------------------------------------
# 4. Build the static API from the archive
# ---------------------------------------------------------------------------

step 'Building data/api + data/feeds from the archive'
python3 -m evidence_digest.cli build --site-url 'http://localhost:5173/' \
  || die 'Build failed.' 'Check the error above — this step is a pure function of data/archive/, so a failure here usually points at a build bug rather than bad data.'
ok 'Build complete.'

# ---------------------------------------------------------------------------
# 5. Report
# ---------------------------------------------------------------------------

step 'Report'

python3 - <<'PY'
import json
import pathlib

manifest_path = pathlib.Path('data/api/manifest.json')
if not manifest_path.exists():
    print('    data/api/manifest.json was not produced — something upstream failed silently.')
    raise SystemExit(0)

manifest = json.loads(manifest_path.read_text())
print(f"    Total studies served: {manifest.get('totalStudies', '?')}")
print(f"    Journals covered:     {manifest.get('journalCount', '?')}")
print(f"    Days of history:      {len(manifest.get('days', []))} (window: {manifest.get('windowDays', '?')} days)")

topic_counts = manifest.get('topicCounts') or {}
if topic_counts:
    top5 = sorted(topic_counts.items(), key=lambda kv: -kv[1])[:5]
    print('    Busiest topics:')
    for slug, count in top5:
        print(f"      - {slug}: {count}")
PY

cat <<EOF

Next:
  - Run ./scripts/dev.sh to browse the site locally against this data.
  - Push to a branch and open a PR to run CI, or push to main + enable Pages
    (Settings -> Pages -> Source: GitHub Actions) to deploy for real.
  - See evidence-digest-docs/deployment.md for the full path to a live public site.

EOF
