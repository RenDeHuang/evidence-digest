"""The guard that keeps the web app and the email worker honest: walk
contract/study.schema.json and assert every record this pipeline actually
emits has exactly the required key set - no missing keys, no extras.

Builds full Study records end-to-end (parse -> classify -> score -> takeaway
-> assemble) from the real, committed fixture XML and the real, committed
config, entirely offline. This is deliberately an integration test: it is
the one place that would catch a module silently drifting from the shape its
siblings, and the contract, expect."""

from __future__ import annotations

import sys as _sys
from pathlib import Path as _Path

_PIPELINE_DIR = str(_Path(__file__).resolve().parent.parent)
if _PIPELINE_DIR not in _sys.path:
    _sys.path.insert(0, _PIPELINE_DIR)

import datetime as dt
import json
import unittest
from pathlib import Path

from evidence_digest import classify as classify_mod
from evidence_digest import parse as parse_mod
from evidence_digest import score as score_mod
from evidence_digest import takeaway as takeaway_mod
from evidence_digest.cli import _assemble_study
from evidence_digest.config import PATHS, Journal, load_all

FIXTURES = Path(__file__).parent / "fixtures"


def _schema() -> dict:
    schema_path = PATHS.contract_dir / "study.schema.json"
    return json.loads(schema_path.read_text(encoding="utf-8"))


class ContractShapeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = _schema()
        cls.required_keys = set(cls.schema["required"])
        cls.property_keys = set(cls.schema["properties"])
        journals_cfg, taxonomy, scoring = load_all()
        cls.scoring = scoring
        cls.classifier = classify_mod.build_classifier(taxonomy, scoring)
        # NEJM is general-medicine in the real journals.json; use that as a
        # safe, always-resolvable specialty regardless of what these two
        # bladder-cancer fixtures happen to classify as.
        cls.journal = Journal(name="New England Journal of Medicine", ta="N Engl J Med",
                               specialty="general-medicine", tier=1, scope="all")
        cls.today = dt.date(2026, 7, 24)

    def test_schema_requires_every_declared_property(self) -> None:
        # additionalProperties: false + required == properties is the
        # invariant this whole test suite leans on.
        self.assertEqual(self.required_keys, self.property_keys)
        self.assertEqual(len(self.required_keys), 24)

    def _assemble(self, fixture_name: str, pmid: str) -> dict:
        xml = (FIXTURES / fixture_name).read_bytes()
        parsed = parse_mod.parse_articles(xml)[pmid]
        return _assemble_study(parsed, self.journal, self.classifier, self.scoring, self.today)

    def test_rct_with_abstract_has_exact_key_set(self) -> None:
        study = self._assemble("rct_structured_abstract.xml", "42485627")
        self.assertEqual(set(study.keys()), self.required_keys)
        self.assertTrue(study["hasAbstract"])
        self.assertNotEqual(study["takeaway"], "")
        self.assertTrue(study["topics"])
        self.assertTrue(study["specialties"])

    def test_editorial_with_no_abstract_has_exact_key_set(self) -> None:
        study = self._assemble("editorial_no_abstract.xml", "42485632")
        self.assertEqual(set(study.keys()), self.required_keys)
        self.assertFalse(study["hasAbstract"])
        self.assertEqual(study["abstract"], "")
        self.assertEqual(study["sections"], {})
        self.assertEqual(study["takeaway"], "")

    def test_open_access_record_has_exact_key_set_and_open_access_true(self) -> None:
        study = self._assemble("structured_abstract_nct_pmcid.xml", "42276557")
        self.assertEqual(set(study.keys()), self.required_keys)
        self.assertTrue(study["openAccess"])
        self.assertEqual(study["pmcid"], "PMC13274572")

    def test_pmid_pattern(self) -> None:
        study = self._assemble("rct_structured_abstract.xml", "42485627")
        self.assertRegex(study["pmid"], r"^[0-9]+$")

    def test_entry_date_pattern(self) -> None:
        study = self._assemble("rct_structured_abstract.xml", "42485627")
        self.assertRegex(study["entryDate"], r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")

    def test_score_in_range(self) -> None:
        study = self._assemble("rct_structured_abstract.xml", "42485627")
        self.assertGreaterEqual(study["score"], 0)
        self.assertLessEqual(study["score"], 100)

    def test_evidence_shape(self) -> None:
        study = self._assemble("rct_structured_abstract.xml", "42485627")
        self.assertEqual(set(study["evidence"].keys()), {"level", "label", "rank"})
        self.assertEqual(study["evidence"]["level"], "rct")

    def test_journal_shape(self) -> None:
        study = self._assemble("rct_structured_abstract.xml", "42485627")
        self.assertEqual(set(study["journal"].keys()), {"name", "ta", "tier"})

    def test_doi_url_null_when_no_doi(self) -> None:
        record = {"pmid": "999", "doi": None, "title": "t", "abstract": "", "sections": {},
                   "authors": [], "authorLine": "", "pubTypes": [], "mesh": [], "keywords": [],
                   "trialIds": [], "pubdate": "", "entryDate": "2026-07-24", "pmcid": None}
        study = _assemble_study(record, self.journal, self.classifier, self.scoring, self.today)
        self.assertIsNone(study["doiUrl"])
        self.assertEqual(set(study.keys()), self.required_keys)


if __name__ == "__main__":
    unittest.main()
