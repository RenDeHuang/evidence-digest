"""Regression tests for section-scoped evidence detection and runs.json compaction.

Both behaviours here were added in response to measurements against a real
602-record harvest rather than to hypotheticals, so the tests encode the actual
failure modes that were observed:

* 74% of substantive studies were graded "other" because freshly indexed PubMed
  records carry no MeSH and usually only a "Journal Article" publication type,
  leaving the title/abstract cue layer to do all the work.
* Design phrases are only trustworthy in context. "several phase 2 trials have
  shown" in a BACKGROUND section describes somebody else's work; the same words
  in METHODS describe this study. Hence methods-scoped cues.
* runs.json retained per-journal detail for 120 runs at ~14.3 KB each, which
  would have added roughly 612 MB of git objects a year.
"""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_PIPELINE_DIR = str(_Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in _sys.path:
    _sys.path.insert(0, _PIPELINE_DIR)

import json
import tempfile
import unittest

from evidence_digest import store
from evidence_digest.score import classify_evidence_level
from test_store import _scratch_paths  # same temp-Paths helper the other store tests use


def record(title: str = "", abstract: str = "", sections: dict | None = None,
           pub_types: list[str] | None = None, mesh: list[str] | None = None) -> dict:
    """Minimal record with only the keys evidence detection reads."""
    return {
        "title": title,
        "abstract": abstract or " ".join((sections or {}).values()),
        "sections": sections or {},
        "pubTypes": pub_types if pub_types is not None else ["Journal Article"],
        "mesh": mesh or [],
    }


class SectionScopingTests(unittest.TestCase):
    def test_phase_cue_in_background_does_not_make_it_a_trial(self):
        """The exact false positive section scoping exists to prevent: a review
        whose BACKGROUND cites other people's phase 2 trials."""
        rec = record(
            title="Emerging therapies for myelofibrosis",
            sections={
                "BACKGROUND": "Several phase 2 trials have shown activity for novel JAK inhibitors.",
                "CONCLUSIONS": "Further study is warranted.",
            },
        )
        self.assertNotEqual(classify_evidence_level(rec), "trial")

    def test_phase_cue_in_methods_is_a_trial(self):
        rec = record(
            title="Novel agent in relapsed disease",
            sections={
                "METHODS": "In this phase 2, open-label study, patients received the study drug.",
                "RESULTS": "The response rate was 41%.",
            },
        )
        self.assertEqual(classify_evidence_level(rec), "trial")

    def test_methods_cue_falls_back_to_title_when_abstract_unstructured(self):
        """With no structured sections there is no METHODS to scope to, so a
        methods-only cue must still fire from the title rather than silently
        never matching."""
        rec = record(title="A Multicenter Observational Safety Study of Faricimab")
        self.assertEqual(classify_evidence_level(rec), "observational")

    def test_priority_order_rct_beats_observational(self):
        """A randomised trial that also uses the word cohort is still an RCT."""
        rec = record(
            title="Trial of an intervention",
            sections={"METHODS": "Patients were randomly assigned within this cohort study framework."},
        )
        self.assertEqual(classify_evidence_level(rec), "rct")

    def test_explicit_pub_type_still_wins_over_text(self):
        rec = record(
            title="Something",
            sections={"METHODS": "cross-sectional survey of clinicians"},
            pub_types=["Journal Article", "Meta-Analysis"],
        )
        self.assertEqual(classify_evidence_level(rec), "meta-analysis")


class PreclinicalGuardTests(unittest.TestCase):
    def test_translational_paper_mentioning_patients_is_still_lab_work(self):
        """The blunt earlier guard matched any occurrence of "patients", which
        vetoed the lab branch for essentially every translational paper - they
        all name a patient population in their first sentence while reporting
        entirely laboratory work."""
        rec = record(
            title="CD70 overexpression at diagnosis predicts relapse in follicular lymphoma",
            abstract=(
                "Although first-line immunotherapy achieves remission in most patients with "
                "follicular lymphoma, better biomarkers are required. We performed proteomic "
                "profiling of cell lines and xenograft models."
            ),
        )
        self.assertEqual(classify_evidence_level(rec), "basic")

    def test_clinical_study_is_not_demoted_for_mentioning_a_cell_line(self):
        rec = record(
            title="Outcomes after treatment",
            sections={
                "METHODS": (
                    "Consecutive patients underwent treatment and were followed prospectively. "
                    "Correlative in vitro assays used a cell line."
                ),
            },
        )
        self.assertNotEqual(classify_evidence_level(rec), "basic")

    def test_methods_development_paper_is_lab_and_methods(self):
        """The dominant genre in imaging/informatics journals: a new algorithm,
        not clinical evidence. Previously fell to "other"."""
        rec = record(
            title="Alzheimer's disease risk prediction via deformable attention networks",
            abstract=(
                "Predicting risk is fundamental for early intervention. However, most methods "
                "struggle to extract multi-omics associative patterns."
            ),
        )
        self.assertEqual(classify_evidence_level(rec), "basic")


class RunsCompactionTests(unittest.TestCase):
    def test_compaction_keeps_full_detail_for_newest_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = _scratch_paths(_Path(tmp))
            for i in range(10):
                store.record_run(
                    {
                        "timestamp": f"2026-07-{i + 1:02d}T07:00:00",
                        "command": "harvest",
                        "windowDays": 3,
                        "newCount": 100 + i,
                        "perJournal": {f"J{n}": (n % 4) for n in range(152)},
                        "errors": [],
                    },
                    paths=paths,
                )
            runs = json.loads(paths.runs_path.read_text(encoding="utf-8"))

            self.assertEqual(len(runs), 10)
            detailed = [r for r in runs if "perJournal" in r]
            self.assertEqual(len(detailed), store.FULL_DETAIL_RUNS)
            # Newest last, and the detailed ones are the tail.
            self.assertEqual(runs[-1]["newCount"], 109)
            self.assertTrue(all("perJournal" in r for r in runs[-store.FULL_DETAIL_RUNS:]))

            # Compacted records keep the scalars trend-spotting needs.
            oldest = runs[0]
            self.assertEqual(oldest["newCount"], 100)
            self.assertEqual(oldest["journalCount"], 152)
            self.assertEqual(oldest["errorCount"], 0)
            self.assertIn("zeroHitJournalCount", oldest)

    def test_compaction_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = _scratch_paths(_Path(tmp))
            for i in range(6):
                store.record_run(
                    {
                        "timestamp": f"2026-07-{i + 1:02d}T07:00:00",
                        "command": "harvest",
                        "windowDays": 3,
                        "newCount": i,
                        "perJournal": {"A": 1},
                        "errors": ["boom"],
                    },
                    paths=paths,
                )
            first = paths.runs_path.read_text(encoding="utf-8")
            before = json.loads(first)
            # Re-appending must not re-expand or duplicate the already-compacted tail.
            store.record_run(
                {"timestamp": "2026-08-01T07:00:00", "command": "harvest",
                 "windowDays": 3, "newCount": 99, "perJournal": {"A": 1}, "errors": []},
                paths=paths,
            )
            after = json.loads(paths.runs_path.read_text(encoding="utf-8"))
            self.assertEqual(len(after), len(before) + 1)
            self.assertEqual(len([r for r in after if "perJournal" in r]), store.FULL_DETAIL_RUNS)
            # The oldest record is byte-identical to its already-compacted form.
            self.assertEqual(after[0], before[0])

    def test_file_stays_small(self):
        """The whole point: 120 retained runs must not produce a multi-megabyte file."""
        with tempfile.TemporaryDirectory() as tmp:
            paths = _scratch_paths(_Path(tmp))
            for i in range(30):
                store.record_run(
                    {
                        "timestamp": f"2026-07-{(i % 28) + 1:02d}T07:00:00",
                        "command": "harvest",
                        "windowDays": 3,
                        "newCount": i,
                        "perJournal": {f"Journal Abbrev {n}": (n % 5) for n in range(152)},
                        "errors": [],
                    },
                    paths=paths,
                )
            size = paths.runs_path.stat().st_size
            # 30 uncompacted records would be ~430 KB; compacted should be far less.
            self.assertLess(size, 60_000, f"runs.json grew to {size} bytes")



if __name__ == "__main__":
    unittest.main()
