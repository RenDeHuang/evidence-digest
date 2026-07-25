"""The extractive "why this matters" line. No model, ever.

Pulls a 1-2 sentence summary straight out of the abstract text PubMed already
supplied, in order of preference: a CONCLUSIONS-flavoured section, then the
tail of a RESULTS-flavoured section, then the lead of an unstructured
abstract. Everything here is string manipulation over `parse.py`'s output -
no network, no config, no randomness, so the same record always produces the
same takeaway.
"""

from __future__ import annotations

import re

_CONCLUSION_KEYS = ("CONCLUSIONS", "CONCLUSION", "INTERPRETATION", "DISCUSSION")
_RESULTS_KEYS = ("RESULTS", "FINDINGS")

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9(])")
_WS_RE = re.compile(r"\s+")
_LEADING_LABEL_RE = re.compile(r"^[A-Z][A-Z0-9 ,/&\-]{1,40}:\s*")
_TRAILING_CRUFT_RE = re.compile(
    r"\s*\((?:funded by|clinicaltrials\.gov|trial registration|registered at|"
    r"chictr|eudract|isrctn)[^)]*\)\.?\s*$",
    re.IGNORECASE,
)

TARGET_LENGTH = 320


def _split_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    return [s.strip() for s in _SENTENCE_SPLIT_RE.split(text) if s.strip()]


def _last_sentences(text: str, n: int) -> str:
    sentences = _split_sentences(text)
    if not sentences:
        return text.strip()
    return " ".join(sentences[-n:])


def _first_sentences(text: str, n: int) -> str:
    sentences = _split_sentences(text)
    if not sentences:
        return text.strip()
    return " ".join(sentences[:n])


def _collapse_whitespace(text: str) -> str:
    return _WS_RE.sub(" ", text).strip()


def _strip_label_residue(text: str) -> str:
    return _LEADING_LABEL_RE.sub("", text, count=1)


def _strip_trailing_cruft(text: str) -> str:
    return _TRAILING_CRUFT_RE.sub("", text)


def _trim(text: str, limit: int = TARGET_LENGTH) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text

    sentences = _split_sentences(text)
    kept = ""
    for sentence in sentences:
        candidate = f"{kept} {sentence}".strip() if kept else sentence
        if len(candidate) > limit:
            break
        kept = candidate
    if kept:
        return kept

    # Not even one sentence fits: hard-cut at the last whitespace within the
    # limit so we never end mid-word, and mark the cut with an ellipsis.
    cut = text[:limit]
    last_space = cut.rfind(" ")
    if last_space > 0:
        cut = cut[:last_space]
    return cut.rstrip(" ,;:-") + "…"


def build_takeaway(record: dict) -> str:
    """Empty string when the record has no abstract at all."""
    abstract = (record.get("abstract") or "").strip()
    if not abstract:
        return ""

    sections = record.get("sections") or {}

    text: str | None = None
    for key in _CONCLUSION_KEYS:
        value = sections.get(key)
        if value and value.strip():
            text = value
            break

    if text is None:
        for key in _RESULTS_KEYS:
            value = sections.get(key)
            if value and value.strip():
                text = _last_sentences(value, 2)
                break

    if text is None:
        text = _first_sentences(abstract, 2)

    text = _strip_label_residue(text)
    text = _strip_trailing_cruft(text)
    text = _collapse_whitespace(text)
    text = _trim(text, TARGET_LENGTH)
    text = _collapse_whitespace(text)
    return text
