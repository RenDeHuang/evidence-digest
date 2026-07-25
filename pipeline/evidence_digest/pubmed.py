"""The only module in this codebase allowed to touch the network.

Wraps NCBI's E-utilities (esearch, efetch) with the throttling, retry, and
identification etiquette NCBI asks API consumers to follow. Isolating all
network I/O here means `parse.py`, `classify.py`, `score.py`, and `build.py`
stay pure functions that unit tests can exercise with zero mocking.

Request patterns here are carried over from the working studies-fetch
prototype (esearch as GET/JSON, efetch as POST/XML with id lists that would
otherwise blow past URL length limits at ~200 PMIDs).
"""

from __future__ import annotations

import json
import os
import random
import time
import urllib.error
import urllib.parse
import urllib.request

EUTILS_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
TOOL = "evidence-digest"

REQUEST_TIMEOUT_SECONDS = 40
MAX_ATTEMPTS = 4
RETRY_BACKOFF_BASE_SECONDS = 1.5
RETRYABLE_HTTP_STATUSES = frozenset({429, 500, 502, 503, 504})

_NO_KEY_INTERVAL = 1.0 / 3.0  # NCBI: <=3 req/sec without an API key
_WITH_KEY_INTERVAL = 1.0 / 10.0  # NCBI: <=10 req/sec with an API key

# Module-level throttle state. A single pipeline run is single-threaded and
# sequential, so a simple "time of last request" gate is sufficient.
_last_request_at = 0.0


class PubMedError(Exception):
    """Raised when an E-utilities call fails after exhausting all retries."""


def _email() -> str:
    return os.environ.get("PUBMED_EMAIL") or os.environ.get("STUDIES_FETCH_EMAIL") or ""


def _api_key() -> str | None:
    return os.environ.get("NCBI_API_KEY") or None


def _common_params() -> dict[str, str]:
    params = {"tool": TOOL}
    email = _email()
    if email:
        params["email"] = email
    key = _api_key()
    if key:
        params["api_key"] = key
    return params


def _throttle() -> None:
    global _last_request_at
    interval = _WITH_KEY_INTERVAL if _api_key() else _NO_KEY_INTERVAL
    now = time.monotonic()
    wait = _last_request_at + interval - now
    if wait > 0:
        time.sleep(wait)
    _last_request_at = time.monotonic()


def _sleep_backoff(attempt: int) -> None:
    delay = RETRY_BACKOFF_BASE_SECONDS * (2**attempt) + random.uniform(0, 0.5)
    time.sleep(delay)


def _request(url: str, data: bytes | None = None) -> bytes:
    """GET (data=None) or POST (data=bytes) with retry/backoff/throttle."""
    last_error: Exception | None = None
    for attempt in range(MAX_ATTEMPTS):
        _throttle()
        req = urllib.request.Request(
            url,
            data=data,
            headers={"User-Agent": TOOL},
        )
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last_error = exc
            if exc.code in RETRYABLE_HTTP_STATUSES and attempt < MAX_ATTEMPTS - 1:
                _sleep_backoff(attempt)
                continue
            raise PubMedError(f"HTTP {exc.code} from {url}: {exc}") from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = exc
            if attempt < MAX_ATTEMPTS - 1:
                _sleep_backoff(attempt)
                continue
            raise PubMedError(
                f"request failed after {MAX_ATTEMPTS} attempts: {url}\n  {exc}"
            ) from exc
    # Unreachable in practice: the loop above always returns or raises.
    raise PubMedError(f"request failed: {url}\n  {last_error}")


def esearch(
    term: str,
    reldate: int | None = None,
    *,
    mindate: str | None = None,
    maxdate: str | None = None,
    datetype: str = "edat",
    retmax: int = 500,
) -> tuple[list[str], int, str]:
    """Search PubMed. Provide either `reldate` (days back from today — used by
    normal harvest runs) or `mindate`+`maxdate` (absolute YYYY/MM/DD or
    YYYY-MM-DD — used by backfill, since `reldate` is always relative to the
    real current date and cannot target a historical window).

    Returns (pmids, total_count, query_translation). `total_count` may exceed
    len(pmids) when the true hit count is larger than `retmax` — callers must
    check this and warn, since silently truncating would misreport coverage.
    """
    if (reldate is None) == (mindate is None and maxdate is None):
        raise ValueError("esearch: pass exactly one of reldate, or mindate+maxdate")

    params = _common_params()
    params.update(
        {
            "db": "pubmed",
            "term": term,
            "datetype": datetype,
            "retmax": str(retmax),
            "retmode": "json",
        }
    )
    if reldate is not None:
        params["reldate"] = str(reldate)
    else:
        if mindate is None or maxdate is None:
            raise ValueError("esearch: mindate and maxdate must both be provided")
        params["mindate"] = mindate
        params["maxdate"] = maxdate

    url = f"{EUTILS_BASE}/esearch.fcgi?" + urllib.parse.urlencode(params)
    raw = _request(url)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PubMedError(f"esearch: non-JSON response for term={term!r}: {raw[:200]!r}") from exc

    if "error" in data:
        raise PubMedError(f"esearch error for term={term!r}: {data['error']}")
    result = data.get("esearchresult", {})
    if "ERROR" in result:
        raise PubMedError(f"esearch error for term={term!r}: {result['ERROR']}")

    ids = result.get("idlist", [])
    count = int(result.get("count", 0))
    translation = result.get("querytranslation", "")
    return ids, count, translation


def efetch(pmids: list[str]) -> bytes:
    """Fetch full PubMed XML records for up to ~200 PMIDs via POST (a GET with
    200 ids can exceed URL length limits some proxies enforce)."""
    if not pmids:
        return b""
    params = _common_params()
    params.update({"db": "pubmed", "id": ",".join(pmids), "retmode": "xml"})
    url = f"{EUTILS_BASE}/efetch.fcgi"
    body = urllib.parse.urlencode(params).encode("utf-8")
    return _request(url, data=body)
