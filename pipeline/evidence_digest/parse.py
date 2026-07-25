"""PubMed efetch XML -> plain-dict records.

A pure function of the XML bytes: no network, no config, no side effects.
Real PubMed records are wildly inconsistent about which optional elements are
present (a record fetched an hour after indexing may have no MeSH, no DOI, no
abstract at all), so every extraction here is defensive by construction:
missing data becomes "", None, or [], never an exception. One malformed
<PubmedArticle> must never take down the other 199 in the same efetch batch.

The dicts returned are intentionally NOT yet contract/study.schema.json shaped
- e.g. there is no `journal`, `specialties`, `topics`, `evidence`, `score`, or
`takeaway` key here. Those get added by classify.py, score.py, and takeaway.py
once this module's output is in hand, because none of that is derivable from
the XML alone.
"""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

# --------------------------------------------------------------------------- #
# small XML helpers
# --------------------------------------------------------------------------- #

_WS_RE = re.compile(r"\s+")


def _flatten(el: ET.Element | None) -> str:
    """Join all text in a subtree (so <i>/<sup>/<sub> markup inside a title or
    abstract collapses to plain text) and normalize whitespace."""
    if el is None:
        return ""
    text = "".join(el.itertext())
    return _WS_RE.sub(" ", text).strip()


def _text(parent: ET.Element | None, path: str) -> str:
    if parent is None:
        return ""
    return _flatten(parent.find(path))


_MONTHS = {
    "jan": "01", "feb": "02", "mar": "03", "apr": "04", "may": "05", "jun": "06",
    "jul": "07", "aug": "08", "sep": "09", "oct": "10", "nov": "11", "dec": "12",
}


def _normalize_month(raw: str) -> str:
    raw = raw.strip()
    if not raw:
        return ""
    if raw.isdigit():
        return raw.zfill(2)
    key = raw[:3].lower()
    return _MONTHS.get(key, "01")


def _normalize_day(raw: str) -> str:
    raw = raw.strip()
    if not raw or not raw.isdigit():
        return "01"
    return raw.zfill(2)


# --------------------------------------------------------------------------- #
# dates
# --------------------------------------------------------------------------- #


def _ymd_from_date_element(el: ET.Element) -> str | None:
    """Read Year/Month/Day children of a <PubDate>-shaped element into a full
    YYYY-MM-DD string, defaulting missing month/day to '01'. Returns None if
    there is no Year at all."""
    year = _text(el, "Year")
    if not year or not year.isdigit():
        return None
    month = _normalize_month(_text(el, "Month"))
    day = _normalize_day(_text(el, "Day"))
    return f"{year}-{month or '01'}-{day}"


def _extract_entry_date(pubmed_article: ET.Element, fallback: str) -> str:
    """entryDate: PubMedPubDate[@PubStatus='entrez'], else 'pubmed', else
    'medline', else the article's own best date. Always YYYY-MM-DD."""
    history = pubmed_article.find("./PubmedData/History")
    if history is not None:
        by_status: dict[str, ET.Element] = {}
        for pd in history.findall("./PubMedPubDate"):
            status = pd.get("PubStatus", "")
            if status and status not in by_status:
                by_status[status] = pd
        for status in ("entrez", "pubmed", "medline"):
            el = by_status.get(status)
            if el is not None:
                ymd = _ymd_from_date_element(el)
                if ymd:
                    return ymd
    return fallback


def _extract_pubdate(article: ET.Element | None) -> str:
    """pubdate: prefer Article/ArticleDate (electronic), else
    Journal/JournalIssue/PubDate, handling free-text MedlineDate. Precision
    varies: YYYY-MM-DD, YYYY-MM, or YYYY."""
    if article is None:
        return ""

    article_date = article.find("./ArticleDate")
    if article_date is not None:
        year = _text(article_date, "Year")
        if year and year.isdigit():
            month = _text(article_date, "Month")
            day = _text(article_date, "Day")
            parts = [year]
            if month:
                parts.append(_normalize_month(month))
                if day:
                    parts.append(_normalize_day(day))
            return "-".join(parts)

    pub_date = article.find("./Journal/JournalIssue/PubDate")
    if pub_date is not None:
        medline_date = _text(pub_date, "MedlineDate")
        if medline_date:
            m = re.match(r"(\d{4})", medline_date)
            return m.group(1) if m else medline_date
        year = _text(pub_date, "Year")
        if year and year.isdigit():
            month = _text(pub_date, "Month")
            day = _text(pub_date, "Day")
            parts = [year]
            if month:
                parts.append(_normalize_month(month))
                if day:
                    parts.append(_normalize_day(day))
            return "-".join(parts)

    return ""


def _fallback_entry_date(article: ET.Element | None) -> str:
    """Best-effort YYYY-MM-DD to use when History has no usable date at all
    (rare, but must never raise). Pads to day precision."""
    pubdate = _extract_pubdate(article)
    if not pubdate:
        return ""
    pieces = pubdate.split("-")
    while len(pieces) < 3:
        pieces.append("01")
    return "-".join(pieces[:3])


# --------------------------------------------------------------------------- #
# trial registry IDs
# --------------------------------------------------------------------------- #

_TRIAL_ID_PATTERNS = [
    re.compile(r"\bNCT\d{8}\b"),
    re.compile(r"\bISRCTN\d+\b"),
    re.compile(r"\bEudraCT(?:\s*(?:No\.?|Number)?\s*[:#]?\s*)?\d{4}-\d{6}-\d{2}\b", re.IGNORECASE),
    re.compile(r"\bChiCTR[-\w]+\b"),
    re.compile(r"\bjRCT[-\w]+\b", re.IGNORECASE),
    re.compile(r"\bACTRN\d+\b"),
]


def _extract_trial_ids(article: ET.Element | None, title: str, abstract: str) -> list[str]:
    ids: list[str] = []
    seen: set[str] = set()

    if article is not None:
        for accession in article.findall(
            "./DataBankList/DataBank/AccessionNumberList/AccessionNumber"
        ):
            value = _flatten(accession)
            if value and value not in seen:
                seen.add(value)
                ids.append(value)

    haystack = f"{title} {abstract}"
    for pattern in _TRIAL_ID_PATTERNS:
        for match in pattern.finditer(haystack):
            value = _WS_RE.sub(" ", match.group(0)).strip()
            if value and value not in seen:
                seen.add(value)
                ids.append(value)

    return ids


# --------------------------------------------------------------------------- #
# per-article extraction
# --------------------------------------------------------------------------- #


def _extract_abstract(article: ET.Element | None) -> tuple[dict[str, str], str]:
    """Returns (sections, joined_abstract). `sections` is keyed by uppercased
    Label (falling back to NlmCategory, then 'ABSTRACT'), preserving order."""
    if article is None:
        return {}, ""

    sections: dict[str, str] = {}
    for ab in article.findall("./Abstract/AbstractText"):
        label = ab.get("Label") or ab.get("NlmCategory") or "ABSTRACT"
        label = label.strip().upper() or "ABSTRACT"
        text = _flatten(ab)
        if not text:
            continue
        if label in sections:
            sections[label] = f"{sections[label]} {text}"
        else:
            sections[label] = text

    if not sections:
        return {}, ""

    if len(sections) == 1 and "ABSTRACT" in sections:
        joined = sections["ABSTRACT"]
    else:
        joined = " ".join(f"{label}: {text}" for label, text in sections.items())

    return sections, joined


def _extract_authors(article: ET.Element | None) -> tuple[list[str], str]:
    if article is None:
        return [], ""

    authors: list[str] = []
    for author in article.findall("./AuthorList/Author"):
        last_name = _text(author, "LastName")
        if last_name:
            initials = _text(author, "Initials")
            authors.append(f"{last_name} {initials}".strip())
            continue
        collective = _text(author, "CollectiveName")
        if collective:
            authors.append(collective)

    capped = authors[:12]
    if len(capped) > 3:
        author_line = ", ".join(capped[:3]) + ", et al"
    else:
        author_line = ", ".join(capped)
    return capped, author_line


def _extract_mesh(citation: ET.Element) -> list[str]:
    majors: list[str] = []
    minors: list[str] = []
    for heading in citation.findall("./MeshHeadingList/MeshHeading"):
        descriptor = heading.find("./DescriptorName")
        if descriptor is None:
            continue
        name = _flatten(descriptor)
        if not name:
            continue
        if descriptor.get("MajorTopicYN") == "Y":
            majors.append(name)
        else:
            minors.append(name)
    return (majors + minors)[:25]


def _extract_keywords(article: ET.Element | None) -> list[str]:
    if article is None:
        return []
    keywords: list[str] = []
    citation_parent = article  # KeywordList lives under MedlineCitation, not Article
    for kw in citation_parent.findall(".//KeywordList/Keyword"):
        text = _flatten(kw)
        if text:
            keywords.append(text)
    return keywords[:15]


def _extract_ids(pubmed_article: ET.Element) -> tuple[str | None, str | None]:
    doi: str | None = None
    pmcid: str | None = None
    for article_id in pubmed_article.findall("./PubmedData/ArticleIdList/ArticleId"):
        id_type = article_id.get("IdType", "")
        value = _flatten(article_id)
        if not value:
            continue
        if id_type == "doi" and doi is None:
            doi = value
        elif id_type == "pmc" and pmcid is None:
            pmcid = value if value.upper().startswith("PMC") else f"PMC{value}"
    return doi, pmcid


def _extract_pub_types(article: ET.Element | None) -> list[str]:
    if article is None:
        return []
    out = []
    for pt in article.findall("./PublicationTypeList/PublicationType"):
        text = _flatten(pt)
        if text:
            out.append(text)
    return out


def _parse_one(pubmed_article: ET.Element) -> dict | None:
    citation = pubmed_article.find("./MedlineCitation")
    if citation is None:
        return None
    pmid = _text(citation, "./PMID")
    if not pmid:
        return None

    article = citation.find("./Article")
    title = _text(article, "./ArticleTitle") if article is not None else ""

    sections, abstract = _extract_abstract(article)
    authors, author_line = _extract_authors(article)
    journal_ta = _text(citation, "./MedlineJournalInfo/MedlineTA")
    pub_types = _extract_pub_types(article)
    mesh = _extract_mesh(citation)
    keywords = _extract_keywords(citation)
    doi, pmcid = _extract_ids(pubmed_article)
    trial_ids = _extract_trial_ids(article, title, abstract)
    pubdate = _extract_pubdate(article)
    fallback_entry = _extract_entry_date(pubmed_article, fallback="") or _fallback_entry_date(article)
    entry_date = fallback_entry

    return {
        "pmid": pmid,
        "doi": doi,
        "pmcid": pmcid,
        "title": title,
        "sections": sections,
        "abstract": abstract,
        "authors": authors,
        "authorLine": author_line,
        "journalTA": journal_ta,
        "pubTypes": pub_types,
        "mesh": mesh,
        "keywords": keywords,
        "trialIds": trial_ids,
        "pubdate": pubdate,
        "entryDate": entry_date,
    }


def parse_articles(xml: bytes) -> dict[str, dict]:
    """Parse an efetch XML payload (one or many <PubmedArticle> elements) into
    a dict keyed by PMID. Malformed individual articles are skipped rather
    than raised; a fully malformed document raises xml.etree.ElementTree.ParseError,
    which is the caller's decision to handle (e.g. retry the batch, or drop it
    and keep going with other journals)."""
    root = ET.fromstring(xml)
    out: dict[str, dict] = {}
    for pubmed_article in root.findall(".//PubmedArticle"):
        try:
            record = _parse_one(pubmed_article)
        except Exception:  # noqa: BLE001 - one bad article must never sink a batch
            continue
        if record is not None:
            out[record["pmid"]] = record
    return out
