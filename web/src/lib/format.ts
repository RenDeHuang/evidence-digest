import type { Study, StudyCard } from '../../../shared/types';

type CitableStudy = Pick<Study, 'authors' | 'title' | 'journal' | 'pubdate' | 'pmid' | 'doi'>;

/** Parses a YYYY-MM-DD (or YYYY-MM, or YYYY) date string as a local calendar date, not UTC. */
export function parseLooseDate(value: string): Date | null {
  const parts = value.split('-').map((p) => Number.parseInt(p, 10));
  const [y, m, d] = parts;
  if (!y || Number.isNaN(y)) return null;
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

export function formatDate(value: string, opts: Intl.DateTimeFormatOptions = {}): string {
  const date = parseLooseDate(value);
  if (!date) return value;
  const hasDay = value.split('-').length >= 3;
  const hasMonth = value.split('-').length >= 2;
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: hasMonth ? 'short' : undefined,
    day: hasDay ? 'numeric' : undefined,
    ...opts,
  });
}

export function daysSince(entryDate: string, from: Date = new Date()): number {
  const date = parseLooseDate(entryDate);
  if (!date) return 0;
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

export function relativeDay(entryDate: string, from: Date = new Date()): string {
  const days = daysSince(entryDate, from);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

const TIER_WORD: Record<number, string> = {
  1: 'a flagship',
  2: 'a leading subspecialty',
  3: 'a specialty',
};

/**
 * Plain-language explanation of the 0-100 relevance score, meant to sit behind a
 * tooltip / aria-label so the number is never presented bare. This is a description
 * of the visible signals (evidence design, journal reach, recency) — it does not
 * re-derive the exact arithmetic in pipeline/config/scoring.json.
 */
export function scoreDescription(study: StudyCard | Study): string {
  const days = daysSince(study.entryDate);
  const recency = days <= 0 ? 'indexed today' : days === 1 ? 'indexed yesterday' : `indexed ${days} days ago`;
  const tierWord = TIER_WORD[study.journal.tier] ?? 'a';
  return `Relevance ${study.score} of 100: ${study.evidence.label.toLowerCase()} in ${tierWord} journal, ${recency}.`;
}

export function scoreBand(score: number): 'high' | 'medium' | 'low' {
  if (score >= 65) return 'high';
  if (score >= 35) return 'medium';
  return 'low';
}

/** Best-effort Vancouver-style plain-text citation from the fields the API provides. */
export function vancouverCitation(study: CitableStudy): string {
  const authors =
    study.authors.length > 6 ? [...study.authors.slice(0, 6), 'et al'] : study.authors;
  const authorsPart = authors.length > 0 ? `${authors.join(', ')}.` : '';
  const title = study.title.trim().endsWith('.') ? study.title.trim() : `${study.title.trim()}.`;
  const year = study.pubdate.slice(0, 4) || 'n.d.';

  const pieces = [authorsPart, title, `${study.journal.ta}.`, `${year}.`, `PMID: ${study.pmid}.`];
  if (study.doi) pieces.push(`doi:${study.doi}.`);
  return pieces.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function isCorrectionOrRetraction(pubTypes: string[]): boolean {
  return pubTypes.some((t) =>
    /correction|retract|erratum|expression of concern/i.test(t),
  );
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
