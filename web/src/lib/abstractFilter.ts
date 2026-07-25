import { readJSON, writeJSON, STORAGE_KEYS } from './storage';

/**
 * The "include correspondence, editorials & news" toggle used on /feed and /archive.
 *
 * `Study.hasAbstract` (shared/types.ts) is the only reliable signal that separates
 * substantive research from a letter, reply, editorial, erratum, or a news item that
 * PubMed happens to type as a plain "Journal Article" — no publication-type rule
 * catches that last case. Both pages default to hiding `hasAbstract === false`
 * records and let the reader opt back in explicitly; see Feed.tsx / Archive.tsx.
 *
 * State lives in three places, in priority order:
 *   1. `?all=1` in the URL — wins on first read, so a shared link reproduces
 *      exactly what the sender saw (same precedence rule useTopicSelection's `?t=`
 *      uses for topic selection).
 *   2. localStorage — this reader's last choice, persisted across visits.
 *   3. `false` — the safe default: hide records with no summary to show.
 */
const PARAM = 'all';

export function initialIncludeNonAbstract(searchParams: URLSearchParams): boolean {
  const param = searchParams.get(PARAM);
  if (param !== null) return param === '1';
  return readJSON(STORAGE_KEYS.includeNonAbstract, false);
}

export function persistIncludeNonAbstract(value: boolean): void {
  writeJSON(STORAGE_KEYS.includeNonAbstract, value);
}

/** Sets/clears `?all=1` on an existing URLSearchParams without touching any other param. */
export function withIncludeNonAbstractParam(
  searchParams: URLSearchParams,
  value: boolean,
): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  if (value) next.set(PARAM, '1');
  else next.delete(PARAM);
  return next;
}
