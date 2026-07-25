"""takeaway.py tests: real structured/unstructured/absent abstracts from the
parse.py fixtures, plus synthetic edge cases for the RESULTS/FINDINGS
fallback, trimming, and cruft-stripping rules that the fixtures don't happen
to exercise."""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_PIPELINE_DIR = str(_Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in _sys.path:
    _sys.path.insert(0, _PIPELINE_DIR)

import unittest
from pathlib import Path

from evidence_digest import parse, takeaway

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


class RealFixtureTakeawayTests(unittest.TestCase):
    def test_structured_long_conclusion_trimmed_on_word_boundary(self) -> None:
        rec = parse.parse_articles(_load("rct_structured_abstract.xml"))["42485627"]
        result = takeaway.build_takeaway(rec)
        self.assertTrue(result.startswith("Among participants with muscle-invasive bladder cancer"))
        self.assertLessEqual(len(result), 320)
        # Must never end mid-word: the last "real" character before any
        # ellipsis must be followed only by the ellipsis, never a stray
        # partial token.
        stripped = result.rstrip("…").rstrip()
        self.assertFalse(stripped.endswith("-"))
        self.assertTrue(stripped[-1].isalnum() or stripped[-1] in ".,;")
        # The funding/registration parenthetical must not survive truncation.
        self.assertNotIn("ClinicalTrials.gov", result)
        self.assertNotIn("Funded by", result)

    def test_structured_short_conclusion_used_verbatim(self) -> None:
        rec = parse.parse_articles(_load("structured_abstract_nct_pmcid.xml"))["42276557"]
        result = takeaway.build_takeaway(rec)
        self.assertEqual(
            result,
            "Low concentration atropine (0.01%) eye drops significantly reduced progression "
            "of myopia and were well tolerated compared with placebo in children in the UK.",
        )

    def test_absent_abstract_yields_empty_string(self) -> None:
        rec = parse.parse_articles(_load("editorial_no_abstract.xml"))["42485632"]
        self.assertEqual(takeaway.build_takeaway(rec), "")


class SyntheticTakeawayTests(unittest.TestCase):
    def test_results_fallback_uses_last_two_sentences(self) -> None:
        rec = {
            "abstract": "placeholder so the abstract is not empty",
            "sections": {
                "BACKGROUND": "Some background.",
                "RESULTS": "First finding happened. Second finding happened. Third and final finding happened.",
            },
        }
        result = takeaway.build_takeaway(rec)
        self.assertEqual(result, "Second finding happened. Third and final finding happened.")

    def test_findings_fallback_when_no_results_key(self) -> None:
        rec = {
            "abstract": "placeholder",
            "sections": {"FINDINGS": "Alpha happened. Beta happened. Gamma happened."},
        }
        result = takeaway.build_takeaway(rec)
        self.assertEqual(result, "Beta happened. Gamma happened.")

    def test_unstructured_abstract_uses_first_two_sentences(self) -> None:
        rec = {
            "abstract": "First sentence here. Second sentence here. Third sentence should be dropped.",
            "sections": {},
        }
        result = takeaway.build_takeaway(rec)
        self.assertEqual(result, "First sentence here. Second sentence here.")

    def test_conclusion_preferred_over_results(self) -> None:
        rec = {
            "abstract": "placeholder",
            "sections": {
                "RESULTS": "Results sentence one. Results sentence two.",
                "CONCLUSIONS": "The real takeaway sentence.",
            },
        }
        self.assertEqual(takeaway.build_takeaway(rec), "The real takeaway sentence.")

    def test_interpretation_and_discussion_also_preferred(self) -> None:
        rec1 = {"abstract": "x", "sections": {"INTERPRETATION": "Interpretation sentence."}}
        rec2 = {"abstract": "x", "sections": {"DISCUSSION": "Discussion sentence."}}
        self.assertEqual(takeaway.build_takeaway(rec1), "Interpretation sentence.")
        self.assertEqual(takeaway.build_takeaway(rec2), "Discussion sentence.")

    def test_empty_abstract_string_returns_empty(self) -> None:
        self.assertEqual(takeaway.build_takeaway({"abstract": "", "sections": {}}), "")

    def test_missing_abstract_key_returns_empty(self) -> None:
        self.assertEqual(takeaway.build_takeaway({}), "")

    def test_trailing_registration_cruft_is_stripped(self) -> None:
        rec = {
            "abstract": "x",
            "sections": {
                "CONCLUSIONS": "The drug worked well in this population. "
                "(Funded by Example Corp; ClinicalTrials.gov number, NCT01234567.)"
            },
        }
        result = takeaway.build_takeaway(rec)
        self.assertEqual(result, "The drug worked well in this population.")

    def test_leading_label_residue_is_stripped(self) -> None:
        rec = {"abstract": "x", "sections": {"CONCLUSIONS": "IN SUMMARY: The treatment was effective."}}
        result = takeaway.build_takeaway(rec)
        self.assertEqual(result, "The treatment was effective.")

    def test_very_long_single_sentence_hard_cuts_at_word_boundary(self) -> None:
        long_word_salad = "word " * 200  # one giant "sentence", no punctuation
        rec = {"abstract": "x", "sections": {"CONCLUSIONS": long_word_salad.strip() + "."}}
        result = takeaway.build_takeaway(rec)
        self.assertLessEqual(len(result), 321)  # 320 + ellipsis char
        self.assertFalse(result[: -1].endswith(" "))
        self.assertNotIn("  ", result)

    def test_collapses_internal_whitespace(self) -> None:
        rec = {"abstract": "x", "sections": {"CONCLUSIONS": "Too   many     spaces   here."}}
        result = takeaway.build_takeaway(rec)
        self.assertEqual(result, "Too many spaces here.")


if __name__ == "__main__":
    unittest.main()
