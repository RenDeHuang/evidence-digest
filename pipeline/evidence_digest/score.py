"""Evidence-level detection and importance scoring. Both fully deterministic:
same record + same scoring.json always yields the same output, no model in
the loop anywhere.

Two separate concerns live here on purpose:

* `detect_evidence` answers "what kind of study design is this" - a
  classification problem with a fixed, small vocabulary
  (contract/study.schema.json's `evidence.level` enum). The *trigger* mapping
  (which pub types / MeSH / phrases imply which level) is domain knowledge,
  not an editorial ranking choice, so it is intentionally hardcoded here
  rather than pulled from scoring.json. What scoring.json DOES own is the
  points/label/rank attached to each level - that part is never hardcoded.

* `score_study` answers "how important is this" - journal tier + evidence
  points + recency decay + signal bonuses - noise penalties, clamped 0-100.
  Every number in that formula comes from scoring.json.
"""

from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass

from evidence_digest.config import Journal, ScoringConfig

# --------------------------------------------------------------------------- #
# evidence level detection
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class EvidenceGrade:
    level: str
    label: str
    rank: int


_PUBTYPE_TO_LEVEL: tuple[tuple[str, str], ...] = (
    ("Practice Guideline", "guideline"),
    ("Guideline", "guideline"),
    ("Consensus Development Conference", "guideline"),
    ("Meta-Analysis", "meta-analysis"),
    ("Systematic Review", "meta-analysis"),
    ("Randomized Controlled Trial", "rct"),
    ("Clinical Trial, Phase III", "rct"),
    ("Controlled Clinical Trial", "trial"),
    ("Clinical Trial, Phase I", "trial"),
    ("Clinical Trial, Phase II", "trial"),
    ("Clinical Trial, Phase IV", "trial"),
    ("Clinical Trial", "trial"),
    ("Case Reports", "case-report"),
    ("Review", "review"),
    ("Editorial", "other"),
    ("Comment", "other"),
    ("Letter", "other"),
    ("News", "other"),
    ("Published Erratum", "other"),
    ("Retraction of Publication", "other"),
)

# Order matters: earlier entries win when a record has multiple matching
# pub types (e.g. "Randomized Controlled Trial" beats a generic "Clinical Trial").
_PUBTYPE_PRIORITY = {name: idx for idx, (name, _level) in enumerate(_PUBTYPE_TO_LEVEL)}
_PUBTYPE_LEVEL_MAP = dict(_PUBTYPE_TO_LEVEL)

_IGNORABLE_PUBTYPES = {"Journal Article"}

_OBSERVATIONAL_MESH = {
    "cohort studies",
    "case-control studies",
    "cross-sectional studies",
    "prospective studies",
    "retrospective studies",
    "registries",
}
_BASIC_MESH = {"animals", "mice", "cell line, tumor", "in vitro techniques"}
_HUMAN_MESH = {"humans"}

# --------------------------------------------------------------------------
# Text-based design detection.
#
# This layer carries almost the entire load in practice, and the reason is
# empirical: records indexed within the last day or two carry NO MeSH terms at
# all (verified: 52 of 52 in a live sample) and usually only "Journal Article"
# as a publication type. Before this layer was built out, 250 of 339 substantive
# studies in a real 602-record harvest - 74% - were graded "other", which meant
# they scored zero evidence points, sank in the ranking, and showed the reader a
# meaningless "Other" badge. A flat ranking defeats the point of the product.
#
# Two design decisions keep precision acceptable:
#
# 1. SECTION SCOPING. A design phrase in a METHODS section describes THIS study;
#    the same phrase in a BACKGROUND section usually describes someone else's
#    ("several phase 2 trials have shown..."). Cues marked methods_only are
#    matched against the methods-ish sections plus the title, never against the
#    whole abstract. This is what makes the phase-1/2 cues safe to use at all.
# 2. PRIORITY ORDER. The list is evaluated top to bottom and the first hit wins,
#    so the most specific design claim takes precedence. A randomised trial that
#    also says "cohort" is still an RCT.
#
# When a case is genuinely ambiguous, prefer a close-but-imperfect bucket over
# "other": a reader is far better served by "Clinical trial" on an early-phase
# study than by "Other".
_METHODS_SECTION_KEYS = (
    "METHOD", "DESIGN", "PATIENT", "MATERIAL", "PARTICIPANT",
    "SETTING", "INTERVENTION", "POPULATION", "PROCEDURE",
)

# Human-study signals. Used only to stop a clinical paper that merely mentions a
# cell line or a mouse cohort from being demoted to preclinical.
#
# Deliberately narrow. An earlier version matched any occurrence of "patients",
# which vetoed the preclinical branch for essentially every translational paper -
# they all say "patients with follicular lymphoma" in their first sentence while
# reporting entirely laboratory work. What distinguishes a clinical study is not
# mentioning patients but ENROLLING or FOLLOWING them, so match that instead.
_HUMAN_TEXT_RE = re.compile(
    r"\b(?:we enrolled|were enrolled|were randomi[sz]ed|were assigned|"
    r"consecutive patients|patients underwent|patients were (?:treated|followed|recruited)|"
    r"participants were|we recruited|we followed|median follow-up|"
    r"(?:cohort|study population) of \d)",
    re.IGNORECASE,
)

# (pattern, level, methods_only)
_TITLE_ABSTRACT_CUES: tuple[tuple[re.Pattern, str, bool], ...] = (
    # --- evidence synthesis -------------------------------------------------
    (re.compile(r"\bsystematic review and (?:network )?meta-analys[ei]s\b", re.IGNORECASE), "meta-analysis", False),
    (re.compile(r"\bnetwork meta-analys[ei]s\b", re.IGNORECASE), "meta-analysis", False),
    (re.compile(r"\bwe (?:conducted|performed|undertook) a systematic (?:review|search)\b", re.IGNORECASE), "meta-analysis", False),
    (re.compile(r"\brandom-effects (?:model|meta)", re.IGNORECASE), "meta-analysis", False),
    (re.compile(r"\bpooled (?:analysis|estimate|odds ratio|hazard ratio)\b", re.IGNORECASE), "meta-analysis", False),
    (re.compile(r"\bwe searched (?:PubMed|MEDLINE|Embase|the Cochrane)", re.IGNORECASE), "meta-analysis", False),
    (re.compile(r"\bPRISMA\b"), "meta-analysis", False),

    # --- randomised trials --------------------------------------------------
    (re.compile(r"\brandomly (?:assigned|allocated)\b", re.IGNORECASE), "rct", False),
    (re.compile(r"\brandomi[sz]ed(?:[,\s]+(?:double-blind|double-masked|placebo-controlled|controlled|open-label|phase\s*\S+))*[,\s]+(?:clinical\s+)?trial\b", re.IGNORECASE), "rct", False),
    (re.compile(r"\b(?:double|triple)-(?:blind|masked)\b", re.IGNORECASE), "rct", False),
    (re.compile(r"\bplacebo-controlled\b", re.IGNORECASE), "rct", False),
    (re.compile(r"\bassigned\s*\(?1:1\)?|\b1:1 (?:allocation|randomi[sz]ation)\b", re.IGNORECASE), "rct", False),
    (re.compile(r"\bcluster-randomi[sz]ed\b", re.IGNORECASE), "rct", False),

    # --- non-randomised / early-phase trials --------------------------------
    # methods_only for the phase cues: a BACKGROUND mention is somebody else's trial.
    (re.compile(r"\bsingle-arm\b", re.IGNORECASE), "trial", False),
    (re.compile(r"\bfirst-in-human\b", re.IGNORECASE), "trial", False),
    (re.compile(r"\bdose-(?:escalation|expansion|finding)\b", re.IGNORECASE), "trial", False),
    (re.compile(r"\bnon-?randomi[sz]ed (?:clinical )?trial\b", re.IGNORECASE), "trial", False),
    (re.compile(r"\bphase\s*(?:1|2|i|ii|1b|2a|2b|ib|iia)\b", re.IGNORECASE), "trial", True),
    (re.compile(r"\bopen-label\b", re.IGNORECASE), "trial", True),
    (re.compile(r"\b(?:patients|participants) (?:were enrolled|received)\b", re.IGNORECASE), "trial", True),

    # --- observational ------------------------------------------------------
    (re.compile(r"\b(?:retrospective|prospective|observational|longitudinal) cohort\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bcohort stud(?:y|ies)\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bcase-?control stud(?:y|ies)\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bcross-sectional\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bobservational stud(?:y|ies)\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bpopulation-based\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bnationwide (?:registry|cohort|study|sample)\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\btarget trial emulation\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bpropensity[-\s]score\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\b(?:claims data|administrative data|electronic health records?)\b", re.IGNORECASE), "observational", True),
    (re.compile(r"\bregistry-based\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bwe analy[sz]ed data from\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bsecondary analysis of\b", re.IGNORECASE), "observational", True),
    (re.compile(r"\b(?:mixed-methods|qualitative) stud(?:y|ies)\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\bsurvey of\b", re.IGNORECASE), "observational", True),
    (re.compile(r"\blongitudinal stud(?:y|ies)\b", re.IGNORECASE), "observational", False),
    (re.compile(r"\breal-world (?:data|evidence|cohort|outcomes)\b", re.IGNORECASE), "observational", False),
    # Bare "observational", methods-scoped only. Needed because the adjacent form
    # misses real titles like "Multicenter Observational Safety Study".
    (re.compile(r"\bobservational\b", re.IGNORECASE), "observational", True),
    (re.compile(r"\b(?:medical records|chart review) (?:of|were)\b", re.IGNORECASE), "observational", True),

    # --- reviews ------------------------------------------------------------
    # "How I Treat" is a Blood house format and is genuinely a review.
    (re.compile(r"^how i treat\b", re.IGNORECASE), "review", True),
    (re.compile(r"\bnarrative review\b", re.IGNORECASE), "review", False),
    (re.compile(r"\b(?:in this review|this review (?:summari[sz]es|describes)|we review)\b", re.IGNORECASE), "review", False),
    (re.compile(r"\bclinical practice (?:update|guideline review)\b", re.IGNORECASE), "review", False),
    (re.compile(r"\bstate of the art\b", re.IGNORECASE), "review", False),

    # --- case reports -------------------------------------------------------
    (re.compile(r"\bwe (?:report|describe) (?:a|the) case\b", re.IGNORECASE), "case-report", False),
    (re.compile(r"\bcase series\b", re.IGNORECASE), "case-report", False),

    # --- laboratory / methods-development -----------------------------------
    # Guarded by the human check in _evidence_from_text so a clinical validation
    # study is never demoted just for mentioning a cell line.
    (re.compile(r"\b(?:mouse|murine|rat) model\b", re.IGNORECASE), "basic", False),
    (re.compile(r"\bin vitro\b", re.IGNORECASE), "basic", False),
    (re.compile(r"\b(?:xenograft|knockout|knock-in|organoid|cell lines?)\b", re.IGNORECASE), "basic", False),
    (re.compile(r"\b(?:proteogenomic|proteomic|transcriptomic|single-cell (?:RNA|sequencing|atlas)|CRISPR|epitope engineering)\b", re.IGNORECASE), "basic", False),
    (re.compile(r"\b(?:preclinical|patient-derived xenograft|in situ vaccine|syngeneic)\b", re.IGNORECASE), "basic", False),
    # Methods-development papers, the dominant genre in the imaging/informatics
    # journals. These report a new algorithm rather than clinical evidence, so
    # they belong with laboratory work rather than in "other".
    (re.compile(r"\bwe (?:developed|trained|propose|present|introduce) (?:a|an|our) (?:novel |new )?(?:deep learning|machine learning|neural|transformer|segmentation|generative|predictive|multi-omics)\b", re.IGNORECASE), "basic", False),
    (re.compile(r"\b(?:this (?:paper|work|study) (?:proposes|presents|introduces)|we propose a novel)\b", re.IGNORECASE), "basic", False),
    (re.compile(r"\b(?:most|existing) methods (?:struggle|fail|are limited)\b", re.IGNORECASE), "basic", False),
)


def _evidence_from_pub_types(pub_types: list[str]) -> str | None:
    candidates = [(name, _PUBTYPE_PRIORITY[name]) for name in pub_types if name in _PUBTYPE_LEVEL_MAP]
    if not candidates:
        return None
    best_name = min(candidates, key=lambda pair: pair[1])[0]
    return _PUBTYPE_LEVEL_MAP[best_name]


def _evidence_from_mesh(mesh: list[str]) -> str | None:
    mesh_lower = {m.lower() for m in mesh}
    if mesh_lower & _OBSERVATIONAL_MESH:
        return "observational"
    if mesh_lower & _BASIC_MESH and not (mesh_lower & _HUMAN_MESH):
        return "basic"
    return None


def _methods_text(record: dict) -> str:
    """Concatenate the methods-ish sections of a structured abstract.

    A design phrase found here describes THIS study, which is what makes the
    otherwise-dangerous cues (phase 1/2, open-label, 'survey of') usable.
    Returns '' for unstructured or absent abstracts, in which case methods_only
    cues fall back to matching the title alone.
    """
    sections = record.get("sections") or {}
    parts = [
        text
        for label, text in sections.items()
        if any(key in label.upper() for key in _METHODS_SECTION_KEYS)
    ]
    return " ".join(parts)


def _evidence_from_text(record: dict) -> str | None:
    title = record.get("title") or ""
    abstract = record.get("abstract") or ""
    full = f"{title} {abstract}"
    scoped = f"{title} {_methods_text(record)}"

    for pattern, level, methods_only in _TITLE_ABSTRACT_CUES:
        haystack = scoped if methods_only else full
        if not pattern.search(haystack):
            continue
        # A paper that studies people is not preclinical, however many cell
        # lines or mouse cohorts it happens to mention. Without this guard a
        # clinical validation study citing an in-vitro assay gets demoted to
        # "Preclinical" and loses most of its evidence points.
        if level == "basic" and _HUMAN_TEXT_RE.search(full):
            continue
        return level
    return None


def classify_evidence_level(record: dict) -> str:
    """Pure classification into the fixed evidence-level vocabulary. Publication
    types are checked first; when they are absent or uninformative (very common
    for records indexed within hours, which often carry only 'Journal Article'),
    fall back to MeSH, then to conservative title/abstract cues. Defaults to
    'other'."""
    pub_types = record.get("pubTypes") or []
    informative_types = [p for p in pub_types if p not in _IGNORABLE_PUBTYPES]

    level = _evidence_from_pub_types(informative_types)
    if level is not None:
        return level

    mesh = record.get("mesh") or []
    level = _evidence_from_mesh(mesh)
    if level is not None:
        return level

    level = _evidence_from_text(record)
    if level is not None:
        return level

    return "other"


def detect_evidence(record: dict, scoring: ScoringConfig) -> EvidenceGrade:
    level = classify_evidence_level(record)
    info = scoring.evidence_levels[level]
    return EvidenceGrade(level=level, label=info.label, rank=info.rank)


# --------------------------------------------------------------------------- #
# bonus / penalty signal detection
# --------------------------------------------------------------------------- #

_PHASE3_RE = re.compile(r"\bphase\s*(?:iii|3)\b", re.IGNORECASE)
_PHASE2_RE = re.compile(r"\bphase\s*(?:ii|2)\b", re.IGNORECASE)
_MULTICENTRE_RE = re.compile(r"\bmulti-?cent(?:er|re)\b", re.IGNORECASE)
_PROTOCOL_RE = re.compile(
    r"\bstudy protocol\b|\bprotocol for a randomi[sz]ed\b", re.IGNORECASE
)
# Large-cohort participant counts: "n = 12,345", "12,345 patients", "12 345 participants".
_COHORT_SIZE_RE = re.compile(
    r"\b(?:n\s*=\s*|)(\d{1,3}(?:[,\s]\d{3})+|\d{4,})\s*"
    r"(?:patients|participants|subjects|individuals|adults|children)?\b",
    re.IGNORECASE,
)


def _has_phase3(record: dict, title_abstract: str) -> bool:
    if "Clinical Trial, Phase III" in (record.get("pubTypes") or []):
        return True
    return bool(_PHASE3_RE.search(title_abstract))


def _has_phase2(record: dict, title_abstract: str) -> bool:
    if "Clinical Trial, Phase II" in (record.get("pubTypes") or []):
        return True
    return bool(_PHASE2_RE.search(title_abstract))


def _has_multicentre(record: dict, title_abstract: str) -> bool:
    if "Multicenter Study" in (record.get("pubTypes") or []):
        return True
    mesh_lower = {m.lower() for m in (record.get("mesh") or [])}
    if "multicenter study" in mesh_lower:
        return True
    return bool(_MULTICENTRE_RE.search(title_abstract))


def _has_large_cohort(record: dict) -> bool:
    abstract = record.get("abstract") or ""
    for match in _COHORT_SIZE_RE.finditer(abstract):
        digits = re.sub(r"[,\s]", "", match.group(1))
        if digits.isdigit() and int(digits) > 1000:
            return True
    return False


def _has_trial_id(record: dict) -> bool:
    return bool(record.get("trialIds"))


def _is_open_access(record: dict) -> bool:
    return bool(record.get("pmcid"))


def _has_structured_abstract(record: dict) -> bool:
    sections = record.get("sections") or {}
    return bool(sections)


def _is_correction(record: dict) -> bool:
    pub_types = set(record.get("pubTypes") or [])
    if pub_types & {"Published Erratum", "Retraction of Publication"}:
        return True
    title = (record.get("title") or "").lower()
    return "retraction" in title or title.startswith("correction") or title.startswith("erratum")


_COMMENT_ON_RE = re.compile(r"\bcomment on:", re.IGNORECASE)


def _is_comment(record: dict) -> bool:
    if "Comment" in (record.get("pubTypes") or []):
        return True
    # PubMed's pubType metadata often lags for commentary pieces (a fresh
    # record may carry only "Journal Article"), and the "Comment on: <title>"
    # marker can appear anywhere in ArticleTitle, not only as a prefix - e.g.
    # "Connecting asciminib tolerability to treatment persistence. Comment
    # on: 'Favorable tolerability of asciminib...'". Requiring the colon
    # keeps this conservative (won't fire on an ordinary headline like
    # "Physicians Comment on New Guidelines").
    return bool(_COMMENT_ON_RE.search(record.get("title") or ""))


def _is_editorial(record: dict) -> bool:
    return "Editorial" in (record.get("pubTypes") or [])


def _is_letter(record: dict) -> bool:
    return "Letter" in (record.get("pubTypes") or [])


def _is_news(record: dict) -> bool:
    return "News" in (record.get("pubTypes") or [])


def _is_preclinical_only(evidence_level: str) -> bool:
    return evidence_level == "basic"


def _is_protocol_only(title_abstract: str) -> bool:
    return bool(_PROTOCOL_RE.search(title_abstract))


def _is_practice_changing(record: dict, journal: Journal, evidence_level: str, phase3: bool) -> bool:
    if evidence_level == "guideline":
        return True
    return phase3 and journal.tier == 1


# --------------------------------------------------------------------------- #
# score
# --------------------------------------------------------------------------- #


def score_study(
    record: dict,
    journal: Journal,
    scoring: ScoringConfig,
    today: dt.date,
    evidence: EvidenceGrade | None = None,
) -> int:
    """journal tier points + evidence points + recency decay + bonuses -
    penalties, clamped to [0, 100]."""
    if evidence is None:
        evidence = detect_evidence(record, scoring)

    title_abstract = f"{record.get('title') or ''} {record.get('abstract') or ''}"

    total = 0.0
    total += scoring.journal_tier.get(journal.tier, 0)
    total += scoring.evidence_levels[evidence.level].points

    entry_date_str = record.get("entryDate") or ""
    try:
        entry_date = dt.date.fromisoformat(entry_date_str)
        age_days = max(0, (today - entry_date).days)
        total += scoring.recency_max_points * (0.5 ** (age_days / scoring.recency_half_life_days))
    except ValueError:
        pass  # missing/malformed entryDate: no recency contribution, never crash

    phase3 = _has_phase3(record, title_abstract)
    phase2 = _has_phase2(record, title_abstract)
    bonuses = scoring.bonuses
    if phase3:
        total += bonuses.get("phase3", 0)
    if phase2:
        total += bonuses.get("phase2", 0)
    if _has_multicentre(record, title_abstract):
        total += bonuses.get("multicentre", 0)
    if _has_large_cohort(record):
        total += bonuses.get("largeCohort", 0)
    if _has_trial_id(record):
        total += bonuses.get("hasTrialId", 0)
    if _is_open_access(record):
        total += bonuses.get("openAccess", 0)
    if _has_structured_abstract(record):
        total += bonuses.get("structuredAbstract", 0)
    if _is_practice_changing(record, journal, evidence.level, phase3):
        total += bonuses.get("practiceChanging", 0)

    penalties = scoring.penalties
    if not (record.get("abstract") or ""):
        total -= penalties.get("noAbstract", 0)
    if _is_correction(record):
        total -= penalties.get("correction", 0)
    if _is_comment(record):
        total -= penalties.get("comment", 0)
    if _is_editorial(record):
        total -= penalties.get("editorial", 0)
    if _is_letter(record):
        total -= penalties.get("letter", 0)
    if _is_news(record):
        total -= penalties.get("news", 0)
    if _is_preclinical_only(evidence.level):
        total -= penalties.get("preclinicalOnly", 0)
    if _is_protocol_only(title_abstract):
        total -= penalties.get("protocolOnly", 0)

    return max(0, min(100, round(total)))
