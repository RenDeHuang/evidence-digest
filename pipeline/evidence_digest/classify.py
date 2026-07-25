"""The deterministic topic/specialty rule engine. No language model, ever.

Design: every topic across every specialty is compiled once into a small set
of precompiled matchers (mesh terms lowercased for substring matching; phrases
and acronyms each folded into a single combined regex per topic; veto phrases
likewise). This runs over roughly 1500 freshly indexed records a day across
what will eventually be ~20 specialties' worth of topics, so per-record work
must stay O(topics) with cheap regex searches, never O(topics * phrases).

Scoring model (see scoring.json.classifier): a topic accumulates points from
two independent "rule groups" which are summed:

  1. the MeSH group: a flat hit worth `weights.mesh` if ANY of the topic's
     MeSH substrings appears in ANY of the record's MeSH descriptors, else 0.
  2. the phrase/acronym group: a phrase or acronym can hit in the title,
     author keywords, or abstract. We take the SINGLE highest-weighted field
     that had a hit (title > keywords > abstract) - never the sum across
     fields, and never multiplied by how many times it matched. This is what
     stops a topic from accumulating "abstract mentions it a dozen times"
     points that would outrank a genuine title hit elsewhere.

A veto ("not") hit in the title or in any MeSH descriptor disqualifies the
topic outright, before any scoring happens.

Short acronyms are a special case within the phrase/acronym group. Two-letter
initialisms are rampant in medicine and routinely collide across specialties
- "AA" is aplastic anemia, African American, amino acid, or ascending aorta
depending on context; "ET" is essential thrombocythemia or embryo transfer;
"PV" is polycythemia vera or portal vein; "MM" is multiple myeloma or
malignant melanoma; "AI" is artificial intelligence or aortic insufficiency;
"RA" is rheumatoid arthritis or right atrial/room air; "PE" is pulmonary
embolism or pre-eclampsia; "DR" is diabetic retinopathy or HLA-DR; "VF" is
ventricular fibrillation or visual field; "OA" is osteoarthritis or open
access. A bare title hit on one of these must not be enough, by itself, to
assign a topic - see SHORT_ACRONYM_MAXLEN below.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from evidence_digest.config import Journal, ScoringConfig, Taxonomy, Topic

# Acronyms of this length or shorter are "short" - too ambiguous in medical
# text to assign a topic on their own (see examples in the module docstring:
# AA, ET, PV, MM, AI, RA, PE, DR, VF, OA, ...). Their contribution is capped
# at scoring.json's `keywords` weight, in every field including the title, so
# a topic can only be reached by combining a short acronym with a genuine
# corroborating signal (a phrase, a MeSH hit, or even just an abstract
# mention of the spelled-out term). Acronyms longer than this (AML, NSCLC,
# COPD, HFpEF, ...) are unambiguous enough to score at full field weight, as
# before. Vetoes help but cannot cover the full combinatorics of medical
# initialism collisions, so this cap lives in the matcher itself.
SHORT_ACRONYM_MAXLEN = 2


@dataclass(frozen=True)
class CompiledTopic:
    slug: str
    specialty_slug: str
    specialty_order: int
    order_in_specialty: int
    catch_all: bool
    mesh_terms: tuple[str, ...]  # already lowercased
    phrase_re: re.Pattern | None
    acronym_re: re.Pattern | None  # length > SHORT_ACRONYM_MAXLEN: full field weight
    short_acronym_re: re.Pattern | None  # length <= SHORT_ACRONYM_MAXLEN: capped at `keywords` weight
    veto_re: re.Pattern | None  # \b-anchored, checked against the title
    veto_terms: tuple[str, ...]  # already lowercased, checked as MeSH substrings


def _combine_phrases(phrases: tuple[str, ...], flags: int, *, allow_plural: bool = False) -> re.Pattern | None:
    if not phrases:
        return None
    alternation = "|".join(re.escape(p) for p in phrases)
    # allow_plural: a trailing \b after e.g. "...model" fails to match inside
    # "...models", because there is no word/non-word transition between "l"
    # and "s" - both are word characters. A bare optional "s" before the
    # boundary catches the common English plural (title phrase "large
    # language model" must still match "large language models" in a title)
    # without loosening the match anywhere but the very end of the phrase.
    suffix = "s?" if allow_plural else ""
    return re.compile(rf"\b(?:{alternation}){suffix}\b", flags)


def _compile_topic(topic: Topic) -> CompiledTopic:
    long_acronyms = tuple(a for a in topic.acronyms if len(a) > SHORT_ACRONYM_MAXLEN)
    short_acronyms = tuple(a for a in topic.acronyms if len(a) <= SHORT_ACRONYM_MAXLEN)
    return CompiledTopic(
        slug=topic.slug,
        specialty_slug=topic.specialty_slug,
        specialty_order=topic.specialty_order,
        order_in_specialty=topic.order_in_specialty,
        catch_all=topic.catch_all,
        mesh_terms=tuple(m.lower() for m in topic.mesh),
        phrase_re=_combine_phrases(topic.phrases, re.IGNORECASE, allow_plural=True),
        # Acronyms are case-SENSITIVE and never get the plural allowance
        # (allow_plural=False, the default) - plurals are curated explicitly
        # where they matter (e.g. "LLMs" is its own acronym entry), and an
        # automatic "s?" on a short acronym like "AA" would reintroduce
        # exactly the noise SHORT_ACRONYM_MAXLEN exists to remove ("AAs").
        acronym_re=_combine_phrases(long_acronyms, 0),
        short_acronym_re=_combine_phrases(short_acronyms, 0),
        # The title check uses \b-anchored whole-phrase matching, consistent
        # with how phrases are matched elsewhere. The MeSH check uses
        # substring matching instead, consistent with the `mesh` rule group -
        # MeSH's inverted naming ("Pediatrics", "Neoplasms, Second Primary")
        # means a word-boundary match against a veto term like "pediatric"
        # would silently fail to fire.
        veto_re=_combine_phrases(topic.veto, re.IGNORECASE),
        veto_terms=tuple(v.lower() for v in topic.veto),
    )


class Classifier:
    """Precompiled matcher over an entire taxonomy. Build once, reuse for
    every record in a harvest run."""

    def __init__(self, topics: list[CompiledTopic], scoring: ScoringConfig) -> None:
        self._topics = topics
        self._weights = scoring.weights
        self._threshold = scoring.assign_threshold
        self._catch_all_by_specialty: dict[str, str] = {
            t.specialty_slug: t.slug for t in topics if t.catch_all
        }
        self._specialty_order: dict[str, int] = {
            t.specialty_slug: t.specialty_order for t in topics
        }

    @classmethod
    def build(cls, taxonomy: Taxonomy, scoring: ScoringConfig) -> "Classifier":
        return cls([_compile_topic(t) for t in taxonomy.all_topics], scoring)

    def _topic_score(
        self,
        topic: CompiledTopic,
        title: str,
        keywords_text: str,
        abstract: str,
        mesh_lower: list[str],
    ) -> int:
        mesh_score = 0
        if topic.mesh_terms and mesh_lower:
            if any(term in descriptor for descriptor in mesh_lower for term in topic.mesh_terms):
                mesh_score = self._weights["mesh"]

        keywords_weight = self._weights["keywords"]

        def field_score(text: str, field_weight: int) -> int:
            if not text:
                return 0
            # A phrase or a long (unambiguous) acronym hit scores this
            # field's full weight, exactly like before.
            if topic.phrase_re is not None and topic.phrase_re.search(text):
                return field_weight
            if topic.acronym_re is not None and topic.acronym_re.search(text):
                return field_weight
            # A short acronym hit alone is capped at the `keywords` weight,
            # in every field including the title (SHORT_ACRONYM_MAXLEN) - it
            # can still combine with a corroborating hit in another field via
            # the max() below, but cannot single-handedly reach a high field
            # weight on ambiguity alone.
            if topic.short_acronym_re is not None and topic.short_acronym_re.search(text):
                return min(field_weight, keywords_weight)
            return 0

        best_field_score = max(
            field_score(title, self._weights["title"]),
            field_score(keywords_text, keywords_weight),
            field_score(abstract, self._weights["abstract"]),
        )

        return mesh_score + best_field_score

    def classify(self, record: dict, journal: Journal) -> tuple[list[str], list[str]]:
        """Returns (topic_slugs, specialty_slugs), both sorted deterministically
        by specialty order then topic order, so output is byte-stable across
        runs. Never empty: falls back to the journal specialty's catchAll."""
        title = record.get("title") or ""
        abstract = record.get("abstract") or ""
        keywords_text = " ".join(record.get("keywords") or [])
        raw_mesh = record.get("mesh") or []
        mesh_lower = [m.lower() for m in raw_mesh]

        assigned: list[CompiledTopic] = []
        for topic in self._topics:
            if topic.veto_re is not None and topic.veto_re.search(title):
                continue
            if topic.veto_terms and any(
                term in descriptor for descriptor in mesh_lower for term in topic.veto_terms
            ):
                continue
            score = self._topic_score(topic, title, keywords_text, abstract, mesh_lower)
            if score >= self._threshold:
                assigned.append(topic)

        if not assigned:
            catch_all_slug = self._catch_all_by_specialty.get(journal.specialty)
            if catch_all_slug is None:
                raise KeyError(
                    f"no catchAll topic registered for specialty '{journal.specialty}' "
                    "(journal specialty does not resolve against the loaded taxonomy)"
                )
            catch_all_topic = next(t for t in self._topics if t.slug == catch_all_slug)
            assigned = [catch_all_topic]

        assigned.sort(key=lambda t: (t.specialty_order, t.order_in_specialty))

        topic_slugs = [t.slug for t in assigned]
        specialty_slugs: list[str] = []
        seen_specialties: set[str] = set()
        for t in assigned:
            if t.specialty_slug not in seen_specialties:
                seen_specialties.add(t.specialty_slug)
                specialty_slugs.append(t.specialty_slug)
        # specialty_slugs is already implicitly ordered by specialty_order
        # because `assigned` was sorted that way above.

        return topic_slugs, specialty_slugs


def build_classifier(taxonomy: Taxonomy, scoring: ScoringConfig) -> Classifier:
    return Classifier.build(taxonomy, scoring)
