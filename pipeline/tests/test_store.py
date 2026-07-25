"""store.py tests against a scratch data/ tree (tempfile), never the repo's
real committed archive."""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_PIPELINE_DIR = str(_Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in _sys.path:
    _sys.path.insert(0, _PIPELINE_DIR)

import datetime as dt
import gzip
import tempfile
import unittest
from pathlib import Path

from evidence_digest import store
from evidence_digest.config import Paths


def _scratch_paths(root: Path) -> Paths:
    data_dir = root / "data"
    state_dir = data_dir / "state"
    return Paths(
        repo_root=root, pipeline_dir=root, config_dir=root / "config",
        taxonomy_dir=root / "config" / "taxonomy",
        journals_path=root / "config" / "journals.json",
        scoring_path=root / "config" / "scoring.json",
        contract_dir=root / "contract",
        data_dir=data_dir, archive_dir=data_dir / "archive",
        state_dir=state_dir, seen_dir=state_dir / "seen",
        runs_path=state_dir / "runs.json",
        api_dir=data_dir / "api", feeds_dir=data_dir / "feeds",
    )


def _study(pmid: str, entry_date: str, **overrides) -> dict:
    base = {"pmid": pmid, "entryDate": entry_date, "score": 50, "title": f"Study {pmid}"}
    base.update(overrides)
    return base


class ArchiveTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.paths = _scratch_paths(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_append_and_read_back(self) -> None:
        store.append_archive("2026-07-20", [_study("1", "2026-07-20"), _study("2", "2026-07-20")], self.paths)
        records = store.read_archive_day("2026-07-20", self.paths)
        self.assertEqual({r["pmid"] for r in records}, {"1", "2"})

    def test_merge_by_pmid_does_not_drop_existing(self) -> None:
        store.append_archive("2026-07-20", [_study("1", "2026-07-20", score=10)], self.paths)
        store.append_archive("2026-07-20", [_study("2", "2026-07-20", score=20)], self.paths)
        records = {r["pmid"]: r for r in store.read_archive_day("2026-07-20", self.paths)}
        self.assertEqual(set(records), {"1", "2"})
        self.assertEqual(records["1"]["score"], 10)

    def test_merge_overwrites_same_pmid_with_latest(self) -> None:
        store.append_archive("2026-07-20", [_study("1", "2026-07-20", score=10)], self.paths)
        store.append_archive("2026-07-20", [_study("1", "2026-07-20", score=99)], self.paths)
        records = store.read_archive_day("2026-07-20", self.paths)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["score"], 99)

    def test_gzip_output_is_valid_and_deterministic(self) -> None:
        store.append_archive("2026-07-20", [_study("1", "2026-07-20")], self.paths)
        raw1 = store.archive_path("2026-07-20", self.paths).read_bytes()
        # Rewriting the same logical content should produce byte-identical output.
        store.append_archive("2026-07-20", [_study("1", "2026-07-20")], self.paths)
        raw2 = store.archive_path("2026-07-20", self.paths).read_bytes()
        self.assertEqual(raw1, raw2)
        with gzip.open(store.archive_path("2026-07-20", self.paths)) as fh:
            fh.read()  # must not raise

    def test_read_archive_filters_by_entry_date_window(self) -> None:
        today = dt.date(2026, 7, 24)
        store.append_archive("2026-07-01", [_study("old", "2026-07-01")], self.paths)
        store.append_archive("2026-07-24", [_study("new", "2026-07-24")], self.paths)
        results = list(store.read_archive(window_days=7, today=today, paths=self.paths))
        pmids = {r["pmid"] for r in results}
        self.assertIn("new", pmids)
        self.assertNotIn("old", pmids)

    def test_read_archive_empty_when_no_files(self) -> None:
        results = list(store.read_archive(window_days=30, today=dt.date(2026, 7, 24), paths=self.paths))
        self.assertEqual(results, [])


class SeenStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.paths = _scratch_paths(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_write_and_load_seen(self) -> None:
        store.write_seen("2026-07-24", ["1", "2", "3"], self.paths)
        seen = store.load_seen(window_days=7, today=dt.date(2026, 7, 24), paths=self.paths)
        self.assertEqual(seen, {"1", "2", "3"})

    def test_write_seen_merges_same_day(self) -> None:
        store.write_seen("2026-07-24", ["1"], self.paths)
        store.write_seen("2026-07-24", ["2"], self.paths)
        seen = store.load_seen(window_days=7, today=dt.date(2026, 7, 24), paths=self.paths)
        self.assertEqual(seen, {"1", "2"})

    def test_load_seen_respects_window(self) -> None:
        store.write_seen("2026-01-01", ["old"], self.paths)
        store.write_seen("2026-07-24", ["new"], self.paths)
        seen = store.load_seen(window_days=10, today=dt.date(2026, 7, 24), paths=self.paths)
        self.assertEqual(seen, {"new"})

    def test_seen_count_ignores_window(self) -> None:
        store.write_seen("2026-01-01", ["old"], self.paths)
        store.write_seen("2026-07-24", ["new"], self.paths)
        self.assertEqual(store.seen_count(self.paths), 2)


class RunLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.paths = _scratch_paths(Path(self._tmp.name))

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_record_and_read_runs(self) -> None:
        store.record_run({"timestamp": "t1", "command": "harvest"}, self.paths)
        store.record_run({"timestamp": "t2", "command": "build"}, self.paths)
        runs = store.read_runs(self.paths)
        self.assertEqual(len(runs), 2)
        self.assertEqual(store.last_run(self.paths)["timestamp"], "t2")

    def test_keeps_only_last_120(self) -> None:
        for i in range(130):
            store.record_run({"timestamp": f"t{i}"}, self.paths)
        runs = store.read_runs(self.paths)
        self.assertEqual(len(runs), 120)
        self.assertEqual(runs[0]["timestamp"], "t10")
        self.assertEqual(runs[-1]["timestamp"], "t129")

    def test_last_run_none_when_empty(self) -> None:
        self.assertIsNone(store.last_run(self.paths))


if __name__ == "__main__":
    unittest.main()
