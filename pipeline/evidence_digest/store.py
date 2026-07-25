"""The committed state: an immutable daily archive, a lightweight seen-PMID
index, and a small run log.

Design goal (from the top of this project): the repository must stay small
forever, so nothing large is ever rewritten. Concretely:

* Each day's harvest lands in exactly one gzip file, `data/archive/<date>.jsonl.gz`,
  named for the study's `entryDate` (not the day the harvest command happened to
  run). Once written, a day's file is only ever re-opened to merge in records
  for PMIDs newly discovered for that same entryDate (e.g. delayed indexing) -
  existing records for that day are never rewound or dropped. Bytes are
  reproduced deterministically (sorted keys, sorted lines, mtime=0) so two
  runs that produce the same logical content produce an identical file, which
  keeps git diffs meaningful.
* The seen-PMID index is separate from the archive specifically so dedup
  never requires decompressing anything: it is one newline-separated text
  file per day the pipeline actually ran, listing PMIDs first emitted that
  day.
* `runs.json` is a small rolling log (last 120 runs) for `cli.py stats` and
  for debugging a bad harvest after the fact.
"""

from __future__ import annotations

import datetime as dt
import gzip
import json
from collections.abc import Iterable, Iterator
from pathlib import Path

from evidence_digest.config import PATHS, Paths

MAX_RUNS_KEPT = 120


# --------------------------------------------------------------------------- #
# archive
# --------------------------------------------------------------------------- #


def archive_path(date: str, paths: Paths = PATHS) -> Path:
    return paths.archive_dir / f"{date}.jsonl.gz"


def _read_jsonl_gz(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with gzip.open(path, "rb") as fh:
        raw = fh.read()
    if not raw:
        return []
    out = []
    for line in raw.decode("utf-8").splitlines():
        line = line.strip()
        if line:
            out.append(json.loads(line))
    return out


def _write_jsonl_gz(path: Path, records: list[dict]) -> None:
    lines = [
        json.dumps(r, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        for r in records
    ]
    body = ("\n".join(lines) + ("\n" if lines else "")).encode("utf-8")
    compressed = gzip.compress(body, compresslevel=9, mtime=0)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_bytes(compressed)
    tmp_path.replace(path)


def append_archive(date: str, records: list[dict], paths: Paths = PATHS) -> int:
    """Merge `records` (keyed by pmid) into the day file for `date`, which is
    each record's own entryDate - not necessarily the day this function is
    called. Existing records for a PMID already in the file are overwritten
    by the incoming version (the only reason that happens is re-harvesting
    the same day, e.g. via backfill, with fresher data). Returns the total
    record count in the file after the merge."""
    path = archive_path(date, paths)
    existing = {r["pmid"]: r for r in _read_jsonl_gz(path)}
    for record in records:
        existing[record["pmid"]] = record
    merged = [existing[pmid] for pmid in sorted(existing, key=lambda p: (len(p), p))]
    _write_jsonl_gz(path, merged)
    return len(merged)


def read_archive_day(date: str, paths: Paths = PATHS) -> list[dict]:
    return _read_jsonl_gz(archive_path(date, paths))


def _archive_dates(paths: Paths = PATHS) -> list[str]:
    if not paths.archive_dir.is_dir():
        return []
    dates = []
    for p in paths.archive_dir.glob("*.jsonl.gz"):
        name = p.name[: -len(".jsonl.gz")]
        dates.append(name)
    return sorted(dates)


# Records can land in an archive file named for a slightly earlier entryDate
# than the day the harvest actually ran, when PubMed's own indexing lags the
# reldate window we queried. This grace period widens which archive files we
# bother opening for a given served window, without ever including a record
# whose actual entryDate falls outside the requested window.
_ARCHIVE_SCAN_GRACE_DAYS = 14


def read_archive(
    window_days: int, today: dt.date | None = None, paths: Paths = PATHS
) -> Iterator[dict]:
    """Yield every archived record whose entryDate falls within the last
    `window_days` days (inclusive of today). Pure function of the committed
    archive; used by build.py, never touches the network."""
    today = today or dt.date.today()
    cutoff = today - dt.timedelta(days=window_days)
    scan_from = cutoff - dt.timedelta(days=_ARCHIVE_SCAN_GRACE_DAYS)

    for date_str in _archive_dates(paths):
        try:
            file_date = dt.date.fromisoformat(date_str)
        except ValueError:
            continue
        if file_date < scan_from or file_date > today:
            continue
        for record in read_archive_day(date_str, paths):
            entry_date_str = record.get("entryDate", "")
            try:
                entry_date = dt.date.fromisoformat(entry_date_str)
            except ValueError:
                continue
            if cutoff <= entry_date <= today:
                yield record


# --------------------------------------------------------------------------- #
# seen store
# --------------------------------------------------------------------------- #


def seen_path(date: str, paths: Paths = PATHS) -> Path:
    return paths.seen_dir / f"{date}.txt"


def write_seen(date: str, pmids: Iterable[str], paths: Paths = PATHS) -> None:
    """Merge `pmids` into data/state/seen/<date>.txt (union with whatever is
    already there, so re-running harvest the same day is safe), sorted."""
    path = seen_path(date, paths)
    existing: set[str] = set()
    if path.exists():
        existing = {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}
    merged = existing | {p for p in pmids if p}
    path.parent.mkdir(parents=True, exist_ok=True)
    content = "\n".join(sorted(merged, key=lambda p: (len(p), p)))
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(content + ("\n" if content else ""), encoding="utf-8")
    tmp_path.replace(path)


def load_seen(window_days: int, today: dt.date | None = None, paths: Paths = PATHS) -> set[str]:
    """Union of every seen/<date>.txt file within the last `window_days` days."""
    if not paths.seen_dir.is_dir():
        return set()
    today = today or dt.date.today()
    cutoff = today - dt.timedelta(days=window_days)
    out: set[str] = set()
    for path in paths.seen_dir.glob("*.txt"):
        date_str = path.stem
        try:
            file_date = dt.date.fromisoformat(date_str)
        except ValueError:
            continue
        if file_date < cutoff or file_date > today:
            continue
        out.update(
            line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
        )
    return out


def seen_count(paths: Paths = PATHS) -> int:
    if not paths.seen_dir.is_dir():
        return 0
    total = set()
    for path in paths.seen_dir.glob("*.txt"):
        total.update(
            line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
        )
    return len(total)


# --------------------------------------------------------------------------- #
# run log
# --------------------------------------------------------------------------- #


# Only the newest few run records keep their full per-journal detail; older ones
# are compacted to scalars on write.
#
# This is not premature optimisation, it is a measured fix. A full record embeds
# a perJournal dict covering all 152 journals and weighs ~14.3 KB. Retaining 120
# of those means a ~1.7 MB file rewritten on EVERY daily commit, which works out
# to roughly 612 MB of git objects a year - against only ~73 MB/yr for the
# gzipped archive that is the actual product data. The whole point of the
# immutable-archive design is a repository that stays small for years, and this
# one file would have quietly undone it.
#
# Three is enough: the per-journal breakdown answers "what happened last night",
# and nobody debugs the 40th-most-recent harvest from this file. Trend data
# (counts, error totals) survives compaction for all 120.
FULL_DETAIL_RUNS = 3

_COMPACT_KEYS = ("timestamp", "command", "windowDays", "newCount")


def _compact_run(entry: dict) -> dict:
    """Reduce a run record to scalars, preserving what trend-spotting needs.

    Idempotent: compacting an already-compacted record returns it unchanged,
    which matters because every write re-compacts the tail of the log.
    """
    if "perJournal" not in entry and "errors" not in entry:
        return entry
    compact = {key: entry[key] for key in _COMPACT_KEYS if key in entry}
    per_journal = entry.get("perJournal")
    if isinstance(per_journal, dict):
        compact["journalCount"] = len(per_journal)
        # A journal returning nothing over the window is the signature of a
        # rotted MEDLINE abbreviation, so the count is worth keeping forever
        # even once the per-journal detail is gone.
        compact["zeroHitJournalCount"] = sum(
            1 for value in per_journal.values() if not _journal_hits(value)
        )
    errors = entry.get("errors")
    if isinstance(errors, list):
        compact["errorCount"] = len(errors)
    # Carry through any other scalar a caller added, so this never silently
    # drops a field someone relies on.
    for key, value in entry.items():
        if key not in compact and isinstance(value, (str, int, float, bool)):
            compact[key] = value
    return compact


def _journal_hits(value: object) -> int:
    """Per-journal values have been both a bare int and a (found, new) pair over
    time; tolerate either rather than crashing a harvest over bookkeeping."""
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, (list, tuple)) and value:
        first = value[0]
        return first if isinstance(first, int) else 0
    if isinstance(value, dict):
        for key in ("found", "total", "hits"):
            if isinstance(value.get(key), int):
                return value[key]
    return 0


def record_run(entry: dict, paths: Paths = PATHS) -> None:
    """Append one run entry to data/state/runs.json, keeping only the most
    recent MAX_RUNS_KEPT and full detail only for the newest FULL_DETAIL_RUNS.

    Order is preserved with the newest record last, which is what
    scripts/ci-harvest-report.py and `cli stats` both expect.
    """
    runs = read_runs(paths)
    runs.append(entry)
    runs = runs[-MAX_RUNS_KEPT:]

    # Compact everything except the newest FULL_DETAIL_RUNS. Done before the
    # write, so the file is never large even transiently.
    if len(runs) > FULL_DETAIL_RUNS:
        head, tail = runs[:-FULL_DETAIL_RUNS], runs[-FULL_DETAIL_RUNS:]
        runs = [_compact_run(record) for record in head] + tail

    paths.state_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = paths.runs_path.with_suffix(paths.runs_path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(runs, indent=2, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp_path.replace(paths.runs_path)


def read_runs(paths: Paths = PATHS) -> list[dict]:
    if not paths.runs_path.exists():
        return []
    try:
        data = json.loads(paths.runs_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def last_run(paths: Paths = PATHS) -> dict | None:
    runs = read_runs(paths)
    return runs[-1] if runs else None


# --------------------------------------------------------------------------- #
# misc stats
# --------------------------------------------------------------------------- #


def archive_day_coverage(paths: Paths = PATHS) -> list[str]:
    """Every entryDate-named archive file present, sorted ascending."""
    return _archive_dates(paths)


def archive_total_bytes(paths: Paths = PATHS) -> int:
    if not paths.archive_dir.is_dir():
        return 0
    return sum(p.stat().st_size for p in paths.archive_dir.glob("*.jsonl.gz"))
