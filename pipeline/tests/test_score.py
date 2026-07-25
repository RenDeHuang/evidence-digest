"""score.py tests. Evidence-level branch coverage uses hand-built records (no
network, no config needed for classify_evidence_level itself). Monotonicity
tests load the REAL pipeline/config/scoring.json - reading a local config
file is not network access, and it gives confidence the actual shipped
weights produce sane relative ordering, not just some hypothetical numbers."""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_PIPELINE_DIR = str(_Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in _sys.path:
    _sys.path.insert(0, _PIPELINE_DIR)

import datetime as dt
import unittest

from evidence_digest import score
from evidence_digest.config import Journal, load_scoring

TODAY = dt.date(2026, 7, 24)


def _record(**overrides) -> dict:
    base = {
        "title": "",
        "abstract": "",
        "pubTypes": [],
        "mesh": [],
        "sections": {},
        "trialIds": [],
        "pmcid": None,
        "entryDate": TODAY.isoformat(),
    }
    base.update(overrides)
    return base


class EvidenceLevelBranchTests(unittest.TestCase):
    def test_guideline_from_pubtype(self) -> None:
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Practice Guideline"])), "guideline"
        )
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Guideline"])), "guideline"
        )
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Consensus Development Conference"])),
            "guideline",
        )

    def test_meta_analysis_from_pubtype(self) -> None:
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Meta-Analysis"])), "meta-analysis"
        )
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Systematic Review"])), "meta-analysis"
        )

    def test_rct_from_pubtype(self) -> None:
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Randomized Controlled Trial"])), "rct"
        )
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Clinical Trial, Phase III"])), "rct"
        )

    def test_trial_from_pubtype(self) -> None:
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Clinical Trial"])), "trial"
        )
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Controlled Clinical Trial"])), "trial"
        )

    def test_case_report_from_pubtype(self) -> None:
        self.assertEqual(
            score.classify_evidence_level(_record(pubTypes=["Case Reports"])), "case-report"
        )

    def test_review_from_pubtype(self) -> None:
        self.assertEqual(score.classify_evidence_level(_record(pubTypes=["Review"])), "review")

    def test_other_from_editorial_comment_letter_news_correction(self) -> None:
        for pt in ("Editorial", "Comment", "Letter", "News", "Published Erratum", "Retraction of Publication"):
            with self.subTest(pt=pt):
                self.assertEqual(score.classify_evidence_level(_record(pubTypes=[pt])), "other")

    def test_journal_article_only_falls_through_to_mesh(self) -> None:
        rec = _record(pubTypes=["Journal Article"], mesh=["Cohort Studies"])
        self.assertEqual(score.classify_evidence_level(rec), "observational")

    def test_mesh_observational_variants(self) -> None:
        for mesh_term in ("Case-Control Studies", "Cross-Sectional Studies", "Prospective Studies",
                           "Retrospective Studies", "Registries"):
            with self.subTest(mesh=mesh_term):
                rec = _record(pubTypes=["Journal Article"], mesh=[mesh_term])
                self.assertEqual(score.classify_evidence_level(rec), "observational")

    def test_mesh_basic_science_without_human_mesh(self) -> None:
        rec = _record(pubTypes=[], mesh=["Mice", "Cell Line, Tumor"])
        self.assertEqual(score.classify_evidence_level(rec), "basic")

    def test_mesh_animals_with_humans_present_is_not_basic(self) -> None:
        rec = _record(pubTypes=[], mesh=["Mice", "Humans"])
        self.assertNotEqual(score.classify_evidence_level(rec), "basic")

    def test_title_abstract_cue_rct(self) -> None:
        rec = _record(title="Patients were randomly assigned to receive drug or placebo")
        self.assertEqual(score.classify_evidence_level(rec), "rct")

    def test_title_says_randomized_trial_without_randomly_assigned_phrase(self) -> None:
        # Regression: a freshly indexed record often carries no informative
        # pubType yet, and a title that plainly announces itself as "a
        # randomized trial" must not fall through to the "other" default.
        rec = _record(
            title="AI-based clinician decision support for diagnosis of inherited "
            "retinal diseases: a multicenter, randomized trial"
        )
        self.assertEqual(score.classify_evidence_level(rec), "rct")

    def test_title_says_randomised_clinical_trial_british_spelling(self) -> None:
        rec = _record(title="Low-dose therapy for X: a randomised clinical trial")
        self.assertEqual(score.classify_evidence_level(rec), "rct")

    def test_title_abstract_cue_meta_analysis(self) -> None:
        rec = _record(abstract="Here we conducted a systematic review of the literature.")
        self.assertEqual(score.classify_evidence_level(rec), "meta-analysis")

    def test_title_abstract_cue_observational(self) -> None:
        rec = _record(abstract="This retrospective cohort of 5000 patients found...")
        self.assertEqual(score.classify_evidence_level(rec), "observational")

    def test_default_other(self) -> None:
        self.assertEqual(score.classify_evidence_level(_record()), "other")


class ScoreMonotonicityTests(unittest.TestCase):
    """Uses the real, shipped scoring.json."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.scoring = load_scoring()

    def test_higher_journal_tier_scores_higher(self) -> None:
        rec = _record(pubTypes=["Randomized Controlled Trial"], abstract="x" * 50)
        tier1 = Journal(name="A", ta="A", specialty="x", tier=1, scope="all")
        tier3 = Journal(name="B", ta="B", specialty="x", tier=3, scope="all")
        s1 = score.score_study(rec, tier1, self.scoring, TODAY)
        s3 = score.score_study(rec, tier3, self.scoring, TODAY)
        self.assertGreater(s1, s3)

    def test_rct_scores_higher_than_editorial_same_journal(self) -> None:
        journal = Journal(name="A", ta="A", specialty="x", tier=1, scope="all")
        rct = _record(pubTypes=["Randomized Controlled Trial"], abstract="x" * 50, sections={"RESULTS": "x"})
        editorial = _record(pubTypes=["Editorial"], abstract="")
        s_rct = score.score_study(rct, journal, self.scoring, TODAY)
        s_ed = score.score_study(editorial, journal, self.scoring, TODAY)
        self.assertGreater(s_rct, s_ed)

    def test_score_is_clamped_0_100(self) -> None:
        journal = Journal(name="A", ta="A", specialty="x", tier=1, scope="all")
        guideline = _record(pubTypes=["Practice Guideline"], abstract="x" * 50, sections={"S": "x"},
                             trialIds=["NCT00000000"], pmcid="PMC1")
        s = score.score_study(guideline, journal, self.scoring, TODAY)
        self.assertGreaterEqual(s, 0)
        self.assertLessEqual(s, 100)

        heavily_penalized = _record(pubTypes=["Retraction of Publication"], abstract="")
        s2 = score.score_study(heavily_penalized, journal, self.scoring, TODAY)
        self.assertGreaterEqual(s2, 0)
        self.assertLessEqual(s2, 100)

    def test_recency_decays_with_age(self) -> None:
        journal = Journal(name="A", ta="A", specialty="x", tier=1, scope="all")
        fresh = _record(pubTypes=["Review"], entryDate=TODAY.isoformat())
        old = _record(pubTypes=["Review"], entryDate=(TODAY - dt.timedelta(days=60)).isoformat())
        s_fresh = score.score_study(fresh, journal, self.scoring, TODAY)
        s_old = score.score_study(old, journal, self.scoring, TODAY)
        self.assertGreater(s_fresh, s_old)

    def test_missing_entry_date_does_not_raise(self) -> None:
        journal = Journal(name="A", ta="A", specialty="x", tier=1, scope="all")
        rec = _record(entryDate="")
        s = score.score_study(rec, journal, self.scoring, TODAY)
        self.assertIsInstance(s, int)

    def test_comment_on_title_marker_is_penalized_even_without_pubtype(self) -> None:
        # Regression: PubMed sometimes tags a commentary piece as plain
        # "Journal Article" with no "Comment" pubType, but the title itself
        # carries "Comment on: <other paper>" - a reliable enough signal to
        # apply the comment penalty from title text alone.
        journal = Journal(name="A", ta="A", specialty="x", tier=2, scope="all")
        commentary = _record(
            title="Connecting asciminib tolerability to long-term persistence. "
            "Comment on: 'Favorable tolerability of asciminib'",
            pubTypes=["Journal Article"],
            abstract="x" * 30,
        )
        plain = _record(title="An unrelated original research title", pubTypes=["Journal Article"],
                          abstract="x" * 30)
        s_comment = score.score_study(commentary, journal, self.scoring, TODAY)
        s_plain = score.score_study(plain, journal, self.scoring, TODAY)
        self.assertLess(s_comment, s_plain)

    def test_correction_penalty_sinks_score_but_stays_nonnegative(self) -> None:
        journal = Journal(name="A", ta="A", specialty="x", tier=3, scope="all")
        correction = _record(pubTypes=["Published Erratum"], abstract="", entryDate=(TODAY - dt.timedelta(days=90)).isoformat())
        s = score.score_study(correction, journal, self.scoring, TODAY)
        self.assertGreaterEqual(s, 0)
        self.assertLess(s, 30)


if __name__ == "__main__":
    unittest.main()
