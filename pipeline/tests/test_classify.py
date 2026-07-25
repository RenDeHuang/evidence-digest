"""classify.py tests against a small synthetic taxonomy (not the real, ever-
growing pipeline/config/taxonomy/*.json) so these tests are stable regardless
of what other agents add there, and so veto behaviour - which the real
taxonomy files don't yet exercise - is actually tested."""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_PIPELINE_DIR = str(_Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in _sys.path:
    _sys.path.insert(0, _PIPELINE_DIR)

import unittest

from evidence_digest import classify
from evidence_digest.config import (
    EvidenceLevelInfo,
    Journal,
    ScoringConfig,
    Specialty,
    Taxonomy,
    Topic,
)


def _topic(
    slug: str,
    specialty_slug: str,
    specialty_order: int,
    order_in_specialty: int,
    *,
    mesh: tuple[str, ...] = (),
    phrases: tuple[str, ...] = (),
    acronyms: tuple[str, ...] = (),
    veto: tuple[str, ...] = (),
    catch_all: bool = False,
) -> Topic:
    return Topic(
        slug=slug,
        name=slug,
        blurb="",
        catch_all=catch_all,
        mesh=mesh,
        phrases=phrases,
        acronyms=acronyms,
        veto=veto,
        specialty_slug=specialty_slug,
        specialty_order=specialty_order,
        order_in_specialty=order_in_specialty,
    )


def _make_taxonomy() -> Taxonomy:
    heme_aml = _topic(
        "heme-aml", "hematology", 10, 0,
        mesh=("Leukemia",), phrases=("acute myeloid leukemia",), acronyms=("AML",),
        veto=("pediatric",),
    )
    # A 2-char acronym alongside a corroborating phrase, mirroring the real
    # taxonomy's heme-mpn topic (acronym "AA" for aplastic anemia, phrase
    # "eltrombopag") - used to test the SHORT_ACRONYM_MAXLEN cap in isolation,
    # independent of whatever other agents add to the real taxonomy files.
    heme_anemia = _topic(
        "heme-anemia", "hematology", 10, 1,
        mesh=(), phrases=("eltrombopag",), acronyms=("AA",),
    )
    heme_other = _topic("heme-other", "hematology", 10, 2, catch_all=True)
    onc_lung = _topic(
        "onc-lung", "oncology", 20, 0,
        mesh=("Lung Neoplasms",), phrases=("lung cancer",), acronyms=("NSCLC",),
    )
    onc_other = _topic("onc-other", "oncology", 20, 1, catch_all=True)

    hematology = Specialty(
        slug="hematology", order=10, name="Hematology", icon="x", blurb="",
        topics=(heme_aml, heme_anemia, heme_other),
    )
    oncology = Specialty(
        slug="oncology", order=20, name="Oncology", icon="x", blurb="",
        topics=(onc_lung, onc_other),
    )
    return Taxonomy(specialties=(hematology, oncology))


def _make_scoring(assign_threshold: int = 3) -> ScoringConfig:
    return ScoringConfig(
        version=1,
        assign_threshold=assign_threshold,
        weights={"mesh": 3, "title": 3, "keywords": 2, "abstract": 1},
        journal_tier={1: 26, 2: 16, 3: 9},
        evidence_levels={
            "other": EvidenceLevelInfo(rank=9, label="Other", points=0),
        },
        bonuses={},
        penalties={},
        recency_max_points=18,
        recency_half_life_days=10,
        limits={},
    )


def _record(**overrides) -> dict:
    base = {"title": "", "abstract": "", "keywords": [], "mesh": []}
    base.update(overrides)
    return base


HEME_JOURNAL = Journal(name="Blood", ta="Blood", specialty="hematology", tier=1, scope="all")
ONC_JOURNAL = Journal(name="JCO", ta="J Clin Oncol", specialty="oncology", tier=1, scope="all")


class ClassifierTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.classifier = classify.Classifier.build(_make_taxonomy(), _make_scoring())

    def test_mesh_alone_reaches_threshold(self) -> None:
        record = _record(mesh=["Leukemia, Myeloid, Acute"])
        topics, specialties = self.classifier.classify(record, HEME_JOURNAL)
        self.assertEqual(topics, ["heme-aml"])
        self.assertEqual(specialties, ["hematology"])

    def test_no_mesh_still_classifies_from_title(self) -> None:
        record = _record(title="New data on acute myeloid leukemia induction therapy")
        topics, _specialties = self.classifier.classify(record, HEME_JOURNAL)
        self.assertEqual(topics, ["heme-aml"])

    def test_plural_form_of_singular_phrase_still_matches(self) -> None:
        # Regression: a trailing \b right after "...leukemia" does not match
        # inside "...leukemias" (no word/non-word transition between 'a' and
        # 's'), so a plain \b-anchored phrase silently missed plural titles.
        record = _record(title="Outcomes across several acute myeloid leukemias subtypes")
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertEqual(topics, ["heme-aml"])

    def test_case_sensitive_acronym_hit_in_title(self) -> None:
        record = _record(title="Outcomes after AML induction")
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertEqual(topics, ["heme-aml"])

    def test_lowercase_acronym_does_not_match(self) -> None:
        # "aml" lowercase should NOT satisfy the case-sensitive acronym rule.
        record = _record(title="a report on aml-like symptoms in a general sense")
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertEqual(topics, ["heme-other"])  # falls through to catchAll

    def test_abstract_only_mention_does_not_assign(self) -> None:
        record = _record(
            title="Unrelated hematology findings",
            abstract="In an aside, we note that acute myeloid leukemia was not the focus of this study.",
        )
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertNotIn("heme-aml", topics)
        self.assertEqual(topics, ["heme-other"])

    def test_keywords_alone_below_threshold_does_not_assign(self) -> None:
        # weights.keywords=2 < assignThreshold=3: a keyword-only hit, with no
        # mesh/title/abstract corroboration, must not be enough on its own.
        record = _record(keywords=["acute myeloid leukemia"])
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertNotIn("heme-aml", topics)

    def test_veto_in_title_blocks_assignment(self) -> None:
        record = _record(title="Acute myeloid leukemia in pediatric patients: a case series")
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertNotIn("heme-aml", topics)
        self.assertEqual(topics, ["heme-other"])

    def test_veto_in_mesh_blocks_assignment(self) -> None:
        record = _record(
            title="acute myeloid leukemia outcomes",
            mesh=["Leukemia, Myeloid, Acute", "Pediatrics"],
        )
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertNotIn("heme-aml", topics)

    def test_catch_all_fires_when_nothing_matches(self) -> None:
        record = _record(title="A completely unrelated topic about nothing in particular")
        topics, specialties = self.classifier.classify(record, HEME_JOURNAL)
        self.assertEqual(topics, ["heme-other"])
        self.assertEqual(specialties, ["hematology"])

    def test_catch_all_uses_journals_own_specialty(self) -> None:
        record = _record(title="A completely unrelated topic about nothing in particular")
        topics, specialties = self.classifier.classify(record, ONC_JOURNAL)
        self.assertEqual(topics, ["onc-other"])
        self.assertEqual(specialties, ["oncology"])

    def test_cross_specialty_assignment_and_ordering(self) -> None:
        # Matches a hematology topic (mesh) AND an oncology topic (title
        # phrase) at once; output must be ordered by specialty order (heme=10
        # before onc=20), and specialties must be deduplicated and ordered.
        record = _record(
            title="lung cancer outcomes in a cohort",
            mesh=["Leukemia"],
        )
        topics, specialties = self.classifier.classify(record, HEME_JOURNAL)
        self.assertEqual(topics, ["heme-aml", "onc-lung"])
        self.assertEqual(specialties, ["hematology", "oncology"])

    def test_output_ordering_is_stable_across_repeated_calls(self) -> None:
        record = _record(title="lung cancer outcomes in a cohort", mesh=["Leukemia"])
        first = self.classifier.classify(record, HEME_JOURNAL)
        second = self.classifier.classify(dict(record), HEME_JOURNAL)
        self.assertEqual(first, second)

    def test_never_empty(self) -> None:
        record = _record()
        topics, specialties = self.classifier.classify(record, HEME_JOURNAL)
        self.assertTrue(topics)
        self.assertTrue(specialties)

    # -- SHORT_ACRONYM_MAXLEN: a bare 2-char acronym must not assign alone -- #

    def test_short_acronym_alone_does_not_assign(self) -> None:
        # "AA" (len 2) hits the title, scoring at most weights.keywords=2,
        # which is below assignThreshold=3 on its own.
        record = _record(title="A large cohort of AA veterans")
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertNotIn("heme-anemia", topics)
        self.assertEqual(topics, ["heme-other"])  # falls through to catchAll

    def test_short_acronym_plus_corroborating_phrase_still_assigns(self) -> None:
        # "AA" (capped at 2) + "eltrombopag" phrase hit in the SAME title
        # field: the phrase alone already scores weights.title=3, so the
        # field score is 3 regardless of the acronym being present too.
        record = _record(title="Eltrombopag in patients with AA")
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertIn("heme-anemia", topics)

    def test_short_acronym_in_title_plus_unrelated_abstract_phrase_does_not_sum_across_fields(self) -> None:
        # The phrase/acronym rule group takes the SINGLE highest-scoring
        # field, never the sum across fields (that invariant predates this
        # change and is what stops abstract-only mentions from piling up -
        # see the module docstring). So a capped short-acronym hit in the
        # title (2) plus an unrelated phrase hit only in the abstract (1)
        # is max(2, 1) = 2, not 2 + 1 = 3: it must NOT assign. Corroboration
        # has to land in the field that needs to clear the threshold (see
        # test_short_acronym_plus_corroborating_phrase_still_assigns above),
        # or come from the independent MeSH group, which is added on top.
        record = _record(
            title="A large cohort of AA veterans",
            abstract="This study enrolled patients treated with eltrombopag over five years.",
        )
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertNotIn("heme-anemia", topics)

    def test_mesh_hit_assigns_regardless_of_any_acronym_cap(self) -> None:
        # The MeSH group is scored independently of, and summed with, the
        # phrase/acronym group (mesh weight 3 alone already clears
        # assignThreshold=3). This just confirms the short-acronym cap
        # introduced above doesn't leak into, or interfere with, MeSH
        # scoring for an unrelated topic.
        record = _record(title="A retrospective series in AML", mesh=["Leukemia"])
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertIn("heme-aml", topics)

    def test_long_acronym_alone_still_assigns_unaffected_by_cap(self) -> None:
        # "AML" (len 3) is unaffected: full title weight, unchanged from
        # before this change.
        record = _record(title="A retrospective review of AML outcomes")
        topics, _ = self.classifier.classify(record, HEME_JOURNAL)
        self.assertIn("heme-aml", topics)


class RealTaxonomyShortAcronymTests(unittest.TestCase):
    """The three scenarios the coordinator asked to be checked directly
    against the real, committed pipeline/config/taxonomy/hematology.json -
    not the synthetic taxonomy above - because the point is proving the cap
    works on the actual shipped acronym list (heme-mpn's "AA", heme-
    leukemia's "CLL"), not just a controlled fixture.

    Scenario 1's title was adjusted from the coordinator's original
    ("...AA patients with hypertension") to drop "hypertension": that word
    independently matches the real cardiology topic cardio-hypertension-
    lipids (a correct, orthogonal cross-specialty match, unrelated to
    acronyms), which meant the overall assigned-topics list was never empty
    and the hematology catchAll fallback correctly did not fire. That is
    real taxonomy content interacting as designed, not a bug in this cap -
    swapping in neutral filler isolates the acronym behavior being tested
    here. See the harvest report for the verbatim-title behavior.
    """

    @classmethod
    def setUpClass(cls) -> None:
        from evidence_digest.config import load_all

        journals_cfg, taxonomy, scoring = load_all()
        cls.taxonomy = taxonomy
        cls.classifier = classify.build_classifier(taxonomy, scoring)
        cls.heme_journal = Journal(name="Blood", ta="Blood", specialty="hematology", tier=1, scope="all")

    def test_bare_short_acronym_falls_to_catch_all(self) -> None:
        record = {
            "title": "Outcomes among AA patients in a general medicine clinic",
            "abstract": "", "keywords": [], "mesh": [],
        }
        topics, _specialties = self.classifier.classify(record, self.heme_journal)
        self.assertNotIn("heme-mpn", topics)
        catch_all = self.taxonomy.specialty_by_slug["hematology"].catch_all_topic.slug
        self.assertEqual(topics, [catch_all])

    def test_short_acronym_corroborated_by_phrase_assigns_heme_mpn(self) -> None:
        record = {"title": "Eltrombopag in severe AA", "abstract": "", "keywords": [], "mesh": []}
        topics, _specialties = self.classifier.classify(record, self.heme_journal)
        self.assertIn("heme-mpn", topics)

    def test_three_char_acronym_alone_still_assigns_heme_leukemia(self) -> None:
        record = {"title": "Ibrutinib for relapsed CLL", "abstract": "", "keywords": [], "mesh": []}
        topics, _specialties = self.classifier.classify(record, self.heme_journal)
        self.assertIn("heme-leukemia", topics)


if __name__ == "__main__":
    unittest.main()
