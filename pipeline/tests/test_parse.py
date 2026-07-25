"""Field-by-field tests of parse.py against three real PubMed XML fixtures,
plus synthetic-XML tests of the entryDate fallback chain and title flattening.
No network: fixtures were downloaded once during development (see
pipeline/tests/fixtures/) and are committed."""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_PIPELINE_DIR = str(_Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in _sys.path:
    _sys.path.insert(0, _PIPELINE_DIR)

import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from evidence_digest import parse

FIXTURES = Path(__file__).parent / "fixtures"


def _load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def _wrap(inner: str) -> bytes:
    """Wrap a minimal <PubmedArticle>...</PubmedArticle> body in the envelope
    parse_articles() expects, for synthetic edge-case tests."""
    return f"""<?xml version="1.0"?>
<PubmedArticleSet>
{inner}
</PubmedArticleSet>""".encode("utf-8")


class RctFixtureTests(unittest.TestCase):
    """rct_structured_abstract.xml: NEJM phase 3 RCT (PMID 42485627), a
    structured abstract, an NCT id, 28 real authors (capped to 12), no PMCID."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.records = parse.parse_articles(_load("rct_structured_abstract.xml"))
        cls.rec = cls.records["42485627"]

    def test_single_record_keyed_by_pmid(self) -> None:
        self.assertEqual(set(self.records), {"42485627"})

    def test_pmid_and_ids(self) -> None:
        self.assertEqual(self.rec["pmid"], "42485627")
        self.assertEqual(self.rec["doi"], "10.1056/NEJMoa2601486")
        self.assertIsNone(self.rec["pmcid"])

    def test_title(self) -> None:
        self.assertEqual(
            self.rec["title"],
            "Enfortumab Vedotin and Pembrolizumab in Cisplatin-Eligible Bladder Cancer.",
        )

    def test_structured_sections_and_joined_abstract(self) -> None:
        self.assertEqual(
            list(self.rec["sections"]), ["BACKGROUND", "METHODS", "RESULTS", "CONCLUSIONS"]
        )
        self.assertTrue(self.rec["abstract"].startswith("BACKGROUND: Neoadjuvant cisplatin"))
        self.assertIn("METHODS: We conducted a phase 3", self.rec["abstract"])
        self.assertIn("NCT04700124", self.rec["abstract"])

    def test_authors_capped_at_12_with_et_al_line(self) -> None:
        raw_author_count = ET.fromstring(_load("rct_structured_abstract.xml")).findall(
            ".//AuthorList/Author"
        )
        self.assertGreater(len(raw_author_count), 12, "fixture must genuinely exceed the cap")
        self.assertEqual(len(self.rec["authors"]), 12)
        self.assertEqual(self.rec["authors"][0], "Galsky MD")
        self.assertEqual(self.rec["authorLine"], "Galsky MD, Valderrama BP, Maruzzo M, et al")

    def test_journal_ta(self) -> None:
        self.assertEqual(self.rec["journalTA"], "N Engl J Med")

    def test_pub_types(self) -> None:
        self.assertIn("Randomized Controlled Trial", self.rec["pubTypes"])
        self.assertIn("Clinical Trial, Phase III", self.rec["pubTypes"])

    def test_mesh_present(self) -> None:
        self.assertIn("Urinary Bladder Neoplasms", self.rec["mesh"])
        self.assertLessEqual(len(self.rec["mesh"]), 25)

    def test_trial_ids(self) -> None:
        self.assertEqual(self.rec["trialIds"], ["NCT04700124"])

    def test_dates(self) -> None:
        self.assertEqual(self.rec["entryDate"], "2026-07-22")
        self.assertEqual(self.rec["pubdate"], "2026-07-23")


class EditorialNoAbstractFixtureTests(unittest.TestCase):
    """editorial_no_abstract.xml: an NEJM Editorial (PMID 42485632) with no
    <Abstract> element at all - the "no abstract" branch every downstream
    module (score, takeaway) must handle without raising."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.rec = parse.parse_articles(_load("editorial_no_abstract.xml"))["42485632"]

    def test_no_abstract_is_empty_not_missing(self) -> None:
        self.assertEqual(self.rec["abstract"], "")
        self.assertEqual(self.rec["sections"], {})

    def test_title_still_parses(self) -> None:
        self.assertEqual(
            self.rec["title"],
            "A New Standard in Muscle-Invasive Bladder Cancer - The End of the Cisplatin Era?",
        )

    def test_single_author(self) -> None:
        self.assertEqual(self.rec["authors"], ["Sridhar SS"])
        self.assertEqual(self.rec["authorLine"], "Sridhar SS")

    def test_pub_type_editorial(self) -> None:
        self.assertEqual(self.rec["pubTypes"], ["Editorial"])

    def test_no_mesh_no_keywords_no_trial_ids(self) -> None:
        self.assertEqual(self.rec["mesh"], [])
        self.assertEqual(self.rec["keywords"], [])
        self.assertEqual(self.rec["trialIds"], [])

    def test_no_doi_pmcid_still_defensive(self) -> None:
        # This record does have a DOI in real PubMed data; the point of this
        # test is simply that access never raises even when fields are absent.
        self.assertIn("doi", self.rec)
        self.assertIn("pmcid", self.rec)


class StructuredAbstractNctPmcidFixtureTests(unittest.TestCase):
    """structured_abstract_nct_pmcid.xml: a BMJ open-access RCT
    (PMID 42276557) with two trial registry ids and a PMCID."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.rec = parse.parse_articles(_load("structured_abstract_nct_pmcid.xml"))["42276557"]

    def test_pmcid_present(self) -> None:
        self.assertEqual(self.rec["pmcid"], "PMC13274572")

    def test_doi(self) -> None:
        self.assertEqual(self.rec["doi"], "10.1136/bmj-2025-086698")

    def test_multiple_trial_ids_deduplicated_ordered(self) -> None:
        self.assertEqual(self.rec["trialIds"], ["NCT03690089", "ISRCTN99883695"])

    def test_structured_sections(self) -> None:
        self.assertIn("CONCLUSIONS", self.rec["sections"])
        self.assertIn("TRIAL REGISTRATION", self.rec["sections"])

    def test_journal_ta(self) -> None:
        self.assertEqual(self.rec["journalTA"], "BMJ")

    def test_mesh(self) -> None:
        self.assertIn("Myopia", self.rec["mesh"])


class EntryDateFallbackChainTests(unittest.TestCase):
    """entryDate: PubMedPubDate[@PubStatus='entrez'], else 'pubmed', else
    'medline', else the article's own best date. Always YYYY-MM-DD."""

    def _record(self, history_xml: str, article_extra: str = "") -> dict:
        xml = _wrap(f"""
<PubmedArticle>
  <MedlineCitation>
    <PMID>1</PMID>
    <Article>
      <ArticleTitle>Title</ArticleTitle>
      {article_extra}
    </Article>
  </MedlineCitation>
  <PubmedData>
    <History>
      {history_xml}
    </History>
  </PubmedData>
</PubmedArticle>
""")
        return parse.parse_articles(xml)["1"]

    def test_prefers_entrez(self) -> None:
        rec = self._record(
            """
            <PubMedPubDate PubStatus="medline"><Year>2026</Year><Month>2</Month><Day>2</Day></PubMedPubDate>
            <PubMedPubDate PubStatus="pubmed"><Year>2026</Year><Month>1</Month><Day>2</Day></PubMedPubDate>
            <PubMedPubDate PubStatus="entrez"><Year>2026</Year><Month>1</Month><Day>1</Day></PubMedPubDate>
            """
        )
        self.assertEqual(rec["entryDate"], "2026-01-01")

    def test_falls_back_to_pubmed_when_no_entrez(self) -> None:
        rec = self._record(
            """
            <PubMedPubDate PubStatus="medline"><Year>2026</Year><Month>2</Month><Day>2</Day></PubMedPubDate>
            <PubMedPubDate PubStatus="pubmed"><Year>2026</Year><Month>1</Month><Day>5</Day></PubMedPubDate>
            """
        )
        self.assertEqual(rec["entryDate"], "2026-01-05")

    def test_falls_back_to_medline_when_only_medline(self) -> None:
        rec = self._record(
            """<PubMedPubDate PubStatus="medline"><Year>2026</Year><Month>3</Month><Day>9</Day></PubMedPubDate>"""
        )
        self.assertEqual(rec["entryDate"], "2026-03-09")

    def test_falls_back_to_article_date_when_history_empty(self) -> None:
        rec = self._record(
            history_xml="",
            article_extra="<ArticleDate DateType=\"Electronic\"><Year>2026</Year><Month>04</Month><Day>15</Day></ArticleDate>",
        )
        self.assertEqual(rec["entryDate"], "2026-04-15")

    def test_never_raises_and_pads_missing_day(self) -> None:
        rec = self._record(
            """<PubMedPubDate PubStatus="medline"><Year>2026</Year><Month>Jan</Month></PubMedPubDate>"""
        )
        self.assertEqual(rec["entryDate"], "2026-01-01")


class TitleFlatteningAndDefensivenessTests(unittest.TestCase):
    def test_embedded_markup_flattens_to_plain_text(self) -> None:
        xml = _wrap(
            """
<PubmedArticle>
  <MedlineCitation>
    <PMID>2</PMID>
    <Article>
      <ArticleTitle>Effect of <i>BRCA1</i> mutation on outcomes<sup>1</sup> in <i>vitro</i></ArticleTitle>
    </Article>
  </MedlineCitation>
  <PubmedData><History/></PubmedData>
</PubmedArticle>
"""
        )
        rec = parse.parse_articles(xml)["2"]
        self.assertEqual(rec["title"], "Effect of BRCA1 mutation on outcomes1 in vitro")

    def test_missing_optional_elements_never_raise(self) -> None:
        xml = _wrap(
            """
<PubmedArticle>
  <MedlineCitation>
    <PMID>3</PMID>
  </MedlineCitation>
</PubmedArticle>
"""
        )
        recs = parse.parse_articles(xml)
        self.assertIn("3", recs)
        rec = recs["3"]
        self.assertEqual(rec["title"], "")
        self.assertEqual(rec["abstract"], "")
        self.assertEqual(rec["authors"], [])
        self.assertEqual(rec["mesh"], [])
        self.assertIsNone(rec["doi"])
        self.assertIsNone(rec["pmcid"])

    def test_article_without_pmid_is_skipped_not_raised(self) -> None:
        xml = _wrap(
            """
<PubmedArticle>
  <MedlineCitation>
    <Article><ArticleTitle>No PMID here</ArticleTitle></Article>
  </MedlineCitation>
</PubmedArticle>
"""
        )
        recs = parse.parse_articles(xml)
        self.assertEqual(recs, {})

    def test_multiple_trial_id_formats_deduplicated(self) -> None:
        xml = _wrap(
            """
<PubmedArticle>
  <MedlineCitation>
    <PMID>4</PMID>
    <Article>
      <ArticleTitle>A trial (NCT01234567) and its ISRCTN12345678 sibling</ArticleTitle>
      <Abstract><AbstractText>Also registered as NCT01234567 and ChiCTR-IPR-15006209.</AbstractText></Abstract>
    </Article>
  </MedlineCitation>
  <PubmedData><History/></PubmedData>
</PubmedArticle>
"""
        )
        rec = parse.parse_articles(xml)["4"]
        self.assertEqual(rec["trialIds"], ["NCT01234567", "ISRCTN12345678", "ChiCTR-IPR-15006209"])


if __name__ == "__main__":
    unittest.main()
