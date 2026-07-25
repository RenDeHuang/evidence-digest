#!/usr/bin/env python3
"""ci-harvest-report.py — small stdlib-only helper used by .github/workflows/harvest.yml.

GitHub Actions `run:` blocks that embed multi-line Python via a heredoc
(`python3 - <<'PY' ... PY`) are fragile inside a YAML block scalar: bash requires
an UNindented heredoc terminator, but the surrounding YAML step is indented, so the
two constraints fight each other. Rather than fight it three times, this one file
holds the logic and the workflow just calls it.

Two data sources, used for different things:

1. `data/state/runs.json` — written by `evidence_digest.store.record_run()` (see
   pipeline/evidence_digest/store.py and cli.py's `_write_run_outputs`). This is
   the ONLY thing that survives across workflow runs (it's one of the two
   directories CI commits), so it is the source of truth for anything that needs
   run-over-run history — specifically the "0 new studies two runs in a row"
   health check. One entry looks like:

       {
         "timestamp": "2026-07-24T07:03:12Z",
         "command": "harvest",              # or "backfill"
         "windowDays": 3,
         "newCount": 1204,
         "perJournal": {
           "<MEDLINE ta>": {"found": 12, "new": 8, "error": null},
           ...
         },
         "errors": ["efetch batch starting pmid=...: ...", ...],
         "targetDate": "2026-07-24"          # backfill entries only
       }

   Note there is no "date" field (use "timestamp") and no "newStudies" field
   (it's "newCount"). `backfill` runs append to the same file as `harvest` runs,
   so the health check filters to `command == "harvest"` — a backfill
   legitimately re-touches many old, already-fully-harvested days and will show
   0 new on most of them, which is not a signal of anything being broken.

2. The harvest step's own stdout, captured to a log file by the workflow (see
   the `tee` in harvest.yml's "Harvest newly indexed studies" step). Per-specialty
   counts and "hit the retmax cap" (truncated) journals are printed by
   `cli._print_harvest_summary` but are NOT written to runs.json, so the ONLY
   place to recover them is that run's own log output. This script's `summary`
   command takes an optional `--log` pointing at it and parses two known,
   exact-format sections:

       By specialty:
         oncology                     210
         cardiology                    84

       WARNING: 2 journal(s) exceeded --max-per-journal - ...
         - Some Journal [Some J]: true count 612 > retmax

   If the log isn't available, the summary says so plainly rather than
   fabricating zeros.

Subcommands:
    latest-count   Print the newest run's `newCount` (or "unknown"). Used to
                   build the harvest commit message.
    health         Exit 1 if the last two HARVEST (not backfill) runs both
                   show 0 new studies.
    summary        Print a Markdown run summary and, if --output is given,
                   append it there (intended to be $GITHUB_STEP_SUMMARY).
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

RUNS_PATH = pathlib.Path("data/state/runs.json")


def load_runs() -> list[dict] | None:
    """Returns the parsed run history, or None if it doesn't exist yet or can't be read."""
    if not RUNS_PATH.exists():
        return None
    try:
        data = json.loads(RUNS_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 — any parse failure should degrade gracefully in CI
        print(f"::warning::Could not parse {RUNS_PATH} ({exc}).")
        return None
    if not isinstance(data, list):
        print(f"::warning::{RUNS_PATH} does not contain a JSON array; ignoring it.")
        return None
    return data


def errored_journals(run: dict) -> list[str]:
    """Journal `ta`s whose perJournal entry has a non-null error, from the run record itself."""
    per_journal = run.get("perJournal") or {}
    return [ta for ta, info in per_journal.items() if isinstance(info, dict) and info.get("error")]


def cmd_latest_count(_args: argparse.Namespace) -> int:
    runs = load_runs()
    if not runs:
        print("unknown")
        return 0
    print(runs[-1].get("newCount", "unknown"))
    return 0


def cmd_health(_args: argparse.Namespace) -> int:
    runs = load_runs()
    if runs is None:
        print(
            f"{RUNS_PATH} not found or unreadable — skipping the health check "
            "(expected on the very first run, before any run history exists)."
        )
        return 0

    # Backfill runs legitimately produce many 0-new entries (re-touching old,
    # already-fully-harvested days) and would otherwise trip a false positive.
    harvest_runs = [r for r in runs if r.get("command") == "harvest"]
    if len(harvest_runs) < 2:
        print(f"Only {len(harvest_runs)} recorded harvest run(s) so far; skipping the two-in-a-row check.")
        return 0

    last_two = harvest_runs[-2:]
    counts = [r.get("newCount") for r in last_two]

    if all(c == 0 for c in counts):
        timestamps = [r.get("timestamp", "?") for r in last_two]
        errored = errored_journals(last_two[-1])
        print(
            "::error::Harvest returned 0 new studies for two runs in a row "
            f"({timestamps[0]} and {timestamps[1]}). All of medicine did not stop "
            "publishing overnight — this almost always means PubMed changed "
            "something (an E-utilities response shape, a rate limit) or a "
            f"journal MEDLINE abbreviation rotted. {len(errored)} journal(s) "
            f"errored on the latest run: {errored[:10]}. See "
            "evidence-digest-docs/operations.md, 'The harvest failed'."
        )
        return 1

    print(f"Harvest health OK — the latest run added {counts[-1]} new studies.")
    return 0


# --------------------------------------------------------------------------- #
# log parsing (for data that never reaches runs.json — see module docstring)
# --------------------------------------------------------------------------- #

_SPECIALTY_LINE_RE = re.compile(r"^  (\S+)\s+(\d+)\s*$")
_TRUNCATED_ITEM_RE = re.compile(r"^  - (.+?) \[(.+?)\]: true count \d+ > retmax\s*$")


def _parse_log_sections(log_text: str) -> tuple[dict[str, int], list[str]]:
    """Returns (specialtyCounts, cappedJournalLabels) parsed out of a harvest
    run's captured stdout, matching the exact format `cli._print_harvest_summary`
    is known to emit (see pipeline/evidence_digest/cli.py). Returns empty
    results (never raises) if the expected sections aren't found, e.g. because
    the log is from a run with zero new studies and no "By specialty:" header."""
    lines = log_text.splitlines()
    specialty_counts: dict[str, int] = {}
    capped: list[str] = []

    in_specialty_section = False
    in_truncated_section = False
    for line in lines:
        if line.strip() == "By specialty:":
            in_specialty_section = True
            in_truncated_section = False
            continue
        if line.strip() == "By journal:":
            in_specialty_section = False
            continue
        if line.startswith("WARNING:") and "exceeded --max-per-journal" in line:
            in_truncated_section = True
            in_specialty_section = False
            continue
        if line.startswith("WARNING:") and "errored and were skipped" in line:
            in_truncated_section = False
            continue

        if in_specialty_section:
            m = _SPECIALTY_LINE_RE.match(line)
            if m:
                specialty_counts[m.group(1)] = int(m.group(2))
            elif line.strip() == "":
                in_specialty_section = False
            continue

        if in_truncated_section:
            m = _TRUNCATED_ITEM_RE.match(line)
            if m:
                capped.append(f"{m.group(1)} ({m.group(2)})")
            elif line.strip() == "":
                in_truncated_section = False
            continue

    return specialty_counts, capped


def cmd_summary(args: argparse.Namespace) -> int:
    runs = load_runs()
    run = runs[-1] if runs else None

    lines = ["# Harvest summary", ""]
    if run is None:
        lines.append(
            f"_No run record found in `{RUNS_PATH}` — the harvest step may not have "
            "completed. Check the job log above._"
        )
    else:
        per_journal = run.get("perJournal") or {}
        errored = errored_journals(run)

        lines.append(f"- **New studies:** {run.get('newCount', 'unknown')}")
        lines.append(f"- **Journals queried:** {len(per_journal)}")
        lines.append(f"- **Run finished:** {run.get('timestamp', 'unknown')}")

        specialty_counts: dict[str, int] = {}
        capped: list[str] = []
        log_note = None
        if args.log:
            log_path = pathlib.Path(args.log)
            if log_path.exists():
                specialty_counts, capped = _parse_log_sections(log_path.read_text(encoding="utf-8", errors="replace"))
            else:
                log_note = f"_(log file `{args.log}` not found — per-specialty breakdown and retmax-cap detection unavailable this run.)_"
        else:
            log_note = "_(no --log given — per-specialty breakdown and retmax-cap detection unavailable this run.)_"

        if specialty_counts:
            lines.append("")
            lines.append("| Specialty | New studies |")
            lines.append("|---|---|")
            for slug, count in sorted(specialty_counts.items(), key=lambda kv: -kv[1]):
                lines.append(f"| {slug} | {count} |")
        elif log_note:
            lines.append("")
            lines.append(log_note)

        lines.append("")
        lines.append(
            f"- **Journals that errored ({len(errored)}):** " + ", ".join(errored)
            if errored
            else "- **Journals that errored:** none"
        )
        lines.append(
            f"- **Journals that hit the retmax cap ({len(capped)}):** " + ", ".join(capped)
            if capped
            else "- **Journals that hit the retmax cap:** none detected"
        )

    lines.append("")
    lines.append(f"- **Deployed URL:** {args.site_url or '(not deployed this run)'}")

    text = "\n".join(lines) + "\n"
    print(text)
    if args.output:
        with open(args.output, "a", encoding="utf-8") as fh:
            fh.write(text)
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("latest-count", help="Print the newest run's new-study count.")
    sub.add_parser("health", help="Exit 1 if the last two harvest runs both added 0 studies.")

    p_summary = sub.add_parser("summary", help="Print (and optionally write) a Markdown run summary.")
    p_summary.add_argument("--site-url", default="", help="Deployed site URL to show in the summary.")
    p_summary.add_argument("--output", default=None, help="File to append the summary to, e.g. $GITHUB_STEP_SUMMARY.")
    p_summary.add_argument("--log", default=None, help="Path to the harvest step's captured stdout, for specialty counts + retmax-cap detection.")

    args = parser.parse_args()
    handlers = {
        "latest-count": cmd_latest_count,
        "health": cmd_health,
        "summary": cmd_summary,
    }
    sys.exit(handlers[args.command](args))


if __name__ == "__main__":
    main()
