import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { EvidenceLevel } from '../../../shared/types';
import { useTaxonomy, useTopicFiles } from '../hooks/useApi';
import { useTopicSelection } from '../hooks/useTopicSelection';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { StudyCard } from '../components/StudyCard';
import { TopicChip } from '../components/TopicChip';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { EmptyState } from '../components/EmptyState';
import { ErrorState, describeApiError } from '../components/ErrorState';
import { StudyListSkeleton } from '../components/Skeleton';
import { daysSince, pluralize } from '../lib/format';
import { topicNameMap } from '../lib/taxonomy';
import { EVIDENCE_LEVELS, ALL_EVIDENCE_LEVELS } from '../lib/evidence';
import {
  initialIncludeNonAbstract,
  persistIncludeNonAbstract,
  withIncludeNonAbstractParam,
} from '../lib/abstractFilter';

const PAGE_SIZE = 25;

type SortMode = 'relevance' | 'newest';
type DateRange = 'today' | '7d' | '30d' | '120d';

const DATE_RANGE_DAYS: Record<DateRange, number> = { today: 0, '7d': 7, '30d': 30, '120d': 120 };
const DATE_RANGE_OPTIONS: { value: DateRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '120d', label: 'Last 120 days' },
];
const TIERS = [1, 2, 3] as const;

export default function Feed() {
  useDocumentTitle(
    'My evidence',
    'Newly published studies across the topics you follow, ranked transparently.',
  );

  const { selected, setSelected, removeTopic } = useTopicSelection();
  const [taxonomyState] = useTaxonomy();
  const { studies, perTopic, loading, retry } = useTopicFiles(selected);
  const [searchParams, setSearchParams] = useSearchParams();

  const [sortMode, setSortMode] = useState<SortMode>('relevance');
  const [dateRange, setDateRange] = useState<DateRange>('120d');
  const [levels, setLevels] = useState<Set<EvidenceLevel>>(new Set(ALL_EVIDENCE_LEVELS));
  const [tiers, setTiers] = useState<Set<number>>(new Set(TIERS));
  const [minScore, setMinScore] = useState(0);
  const [openAccessOnly, setOpenAccessOnly] = useState(false);
  const [textFilter, setTextFilter] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // See lib/abstractFilter.ts: hides letters/replies/editorials/errata/news (records
  // with no abstract) by default. `?all=` wins over localStorage on first read.
  const [includeNonAbstract, setIncludeNonAbstractState] = useState(() =>
    initialIncludeNonAbstract(searchParams),
  );

  function setIncludeNonAbstract(next: boolean) {
    setIncludeNonAbstractState(next);
    persistIncludeNonAbstract(next);
    setSearchParams(withIncludeNonAbstractParam(searchParams, next), { replace: true });
  }

  // A `?t=` URL always wins over whatever was in localStorage — mirrors Topics.tsx,
  // so a shared /feed link reproduces exactly what the sender saw.
  useEffect(() => {
    const param = searchParams.get('t');
    if (param !== null) {
      setSelected(param.split(',').map((s) => s.trim()).filter(Boolean));
    }
    // Intentionally mount-only: after this, the selection is the source of truth
    // and pushes back out to the URL, not the other way round.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const next = selected.slice().sort().join(',');
    const current = searchParams.get('t') ?? '';
    if (next !== current) {
      const params = new URLSearchParams(searchParams);
      if (next) params.set('t', next);
      else params.delete('t');
      setSearchParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const topicNames = useMemo(
    () => (taxonomyState.status === 'success' ? topicNameMap(taxonomyState.data) : {}),
    [taxonomyState],
  );

  function toggleLevel(level: EvidenceLevel) {
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  function toggleTier(tier: number) {
    setTiers((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) next.delete(tier);
      else next.add(tier);
      return next;
    });
  }

  function resetFilters() {
    setSortMode('relevance');
    setDateRange('120d');
    setLevels(new Set(ALL_EVIDENCE_LEVELS));
    setTiers(new Set(TIERS));
    setMinScore(0);
    setOpenAccessOnly(false);
    setTextFilter('');
    setIncludeNonAbstract(false);
  }

  const filtersActive =
    dateRange !== '120d' ||
    levels.size !== ALL_EVIDENCE_LEVELS.length ||
    tiers.size !== TIERS.length ||
    minScore > 0 ||
    openAccessOnly ||
    textFilter.trim().length > 0 ||
    includeNonAbstract;

  // Every filter except the abstract toggle, so the hidden-count below reflects only
  // what that one control is doing — not a conflation with date range/level/etc.
  const filteredBeforeAbstract = useMemo(() => {
    const maxDays = DATE_RANGE_DAYS[dateRange];
    const q = textFilter.trim().toLowerCase();
    return studies.filter((s) => {
      if (daysSince(s.entryDate) > maxDays) return false;
      if (!levels.has(s.evidence.level)) return false;
      if (!tiers.has(s.journal.tier)) return false;
      if (s.score < minScore) return false;
      if (openAccessOnly && !s.openAccess) return false;
      if (q) {
        const haystack = `${s.title} ${s.journal.name} ${s.authorLine}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [studies, dateRange, levels, tiers, minScore, openAccessOnly, textFilter]);

  // Correspondence, replies, editorials, errata, and news items PubMed types as a
  // plain "Journal Article" all share one trait: no abstract. See lib/abstractFilter.ts.
  const hiddenNonAbstractCount = useMemo(
    () => filteredBeforeAbstract.reduce((n, s) => (s.hasAbstract ? n : n + 1), 0),
    [filteredBeforeAbstract],
  );

  const filteredSorted = useMemo(() => {
    const result = includeNonAbstract
      ? filteredBeforeAbstract.slice()
      : filteredBeforeAbstract.filter((s) => s.hasAbstract);

    result.sort((a, b) => {
      if (sortMode === 'newest') {
        if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? 1 : -1;
        if (a.score !== b.score) return b.score - a.score;
      } else {
        if (a.score !== b.score) return b.score - a.score;
        if (a.entryDate !== b.entryDate) return a.entryDate < b.entryDate ? 1 : -1;
      }
      return a.pmid.localeCompare(b.pmid);
    });

    return result;
  }, [filteredBeforeAbstract, includeNonAbstract, sortMode]);

  // Any filter/sort/topic change re-starts pagination at the first page.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [
    selected.join(','),
    dateRange,
    levels,
    tiers,
    minScore,
    openAccessOnly,
    textFilter,
    sortMode,
    includeNonAbstract,
  ]);

  const page = filteredSorted.slice(0, visibleCount);
  const hasErrors = Object.values(perTopic).some((t) => t.status === 'error');

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold">My evidence</h1>
          <p className="mt-2 text-ink-muted">Ranked by relevance across the topics you follow.</p>
        </div>
        <button
          type="button"
          onClick={() => setFiltersOpen(true)}
          className="flex min-h-11 items-center gap-2 rounded-md border border-line-strong px-4 text-sm font-medium text-ink md:hidden"
        >
          Filters
          {filtersActive && (
            <span
              aria-hidden="true"
              className="h-2 w-2 rounded-full"
              style={{ backgroundColor: 'var(--ed-accent)' }}
            />
          )}
        </button>
      </div>

      {selected.length === 0 ? (
        <div className="mt-8">
          <EmptyState
            icon="🔎"
            title="You haven't chosen any topics yet"
            description="Pick a few topics you care about and they'll show up here, ranked and merged into one feed."
            action={
              <Link
                to="/topics"
                className="mt-2 inline-flex min-h-11 items-center rounded-md px-4 text-sm font-semibold"
                style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
              >
                Choose your topics
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <ul className="mt-5 flex flex-wrap gap-1.5" aria-label="Topics contributing to this feed">
            {selected.map((slug) => (
              <li key={slug}>
                <TopicChip
                  label={topicNames[slug] ?? slug}
                  onRemove={() => removeTopic(slug)}
                  removeLabel={`Remove ${topicNames[slug] ?? slug} from your feed`}
                />
              </li>
            ))}
          </ul>

          <div className="mt-6 grid gap-6 md:grid-cols-[15rem_1fr]">
            <div
              className={`${
                filtersOpen
                  ? 'fixed inset-0 z-40 flex items-end bg-black/40 md:static md:z-auto md:block md:bg-transparent'
                  : 'hidden md:block'
              }`}
            >
              <div className="max-h-[85vh] w-full overflow-y-auto rounded-t-xl border-t border-line bg-surface p-4 md:sticky md:top-20 md:max-h-none md:rounded-lg md:border md:p-4">
                <div className="mb-3 flex items-center justify-between md:hidden">
                  <p className="text-base font-semibold">Filters</p>
                  <button
                    type="button"
                    onClick={() => setFiltersOpen(false)}
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-line-strong"
                    aria-label="Close filters"
                  >
                    ✕
                  </button>
                </div>

                <div className="flex flex-col gap-5">
                  <Select
                    id="feed-sort"
                    label="Sort"
                    value={sortMode}
                    onChange={(v) => setSortMode(v as SortMode)}
                    options={[
                      { value: 'relevance', label: 'Most relevant' },
                      { value: 'newest', label: 'Newest first' },
                    ]}
                  />

                  <Select
                    id="feed-date-range"
                    label="Date range"
                    value={dateRange}
                    onChange={(v) => setDateRange(v as DateRange)}
                    options={DATE_RANGE_OPTIONS}
                  />

                  <fieldset>
                    <legend className="text-xs font-medium text-ink-muted">Evidence level</legend>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {EVIDENCE_LEVELS.map((l) => (
                        <label
                          key={l.level}
                          className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink"
                        >
                          <input
                            type="checkbox"
                            checked={levels.has(l.level)}
                            onChange={() => toggleLevel(l.level)}
                            className="h-4 w-4 accent-[var(--ed-accent)]"
                          />
                          {l.label}
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <div>
                    <Toggle
                      id="feed-include-non-abstract"
                      checked={includeNonAbstract}
                      onChange={setIncludeNonAbstract}
                      label="Include correspondence, editorials & news"
                      description="Letters, replies, editorials, errata and news items. These have no abstract, so there is no summary to show."
                    />
                  </div>

                  <fieldset>
                    <legend className="text-xs font-medium text-ink-muted">Journal tier</legend>
                    <div className="mt-1.5 flex flex-col gap-1">
                      {TIERS.map((t) => (
                        <label key={t} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
                          <input
                            type="checkbox"
                            checked={tiers.has(t)}
                            onChange={() => toggleTier(t)}
                            className="h-4 w-4 accent-[var(--ed-accent)]"
                          />
                          Tier {t}
                        </label>
                      ))}
                    </div>
                  </fieldset>

                  <div>
                    <label htmlFor="feed-min-score" className="text-xs font-medium text-ink-muted">
                      Minimum relevance score: {minScore}
                    </label>
                    <input
                      id="feed-min-score"
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={minScore}
                      onChange={(e) => setMinScore(Number(e.target.value))}
                      className="mt-2 w-full accent-[var(--ed-accent)]"
                    />
                  </div>

                  <Toggle
                    id="feed-open-access"
                    checked={openAccessOnly}
                    onChange={setOpenAccessOnly}
                    label="Open access only"
                  />

                  <div>
                    <label htmlFor="feed-text-filter" className="text-xs font-medium text-ink-muted">
                      Filter loaded studies
                    </label>
                    <input
                      id="feed-text-filter"
                      type="search"
                      value={textFilter}
                      onChange={(e) => setTextFilter(e.target.value)}
                      placeholder="Title, journal, author…"
                      className="mt-1 block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
                    />
                  </div>

                  {filtersActive && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="min-h-11 rounded-md border border-line-strong px-3 text-sm font-medium text-ink hover:bg-line"
                    >
                      Reset filters
                    </button>
                  )}

                  <button
                    type="button"
                    onClick={() => setFiltersOpen(false)}
                    className="min-h-11 rounded-md text-sm font-semibold md:hidden"
                    style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
                  >
                    Show results
                  </button>
                </div>
              </div>
            </div>

            <div>
              <p className="text-sm text-ink-muted" aria-live="polite">
                {loading && studies.length === 0
                  ? 'Loading…'
                  : `Showing ${Math.min(page.length, filteredSorted.length)} of ${filteredSorted.length} ${pluralize(filteredSorted.length, 'study', 'studies')}` +
                    (!includeNonAbstract && hiddenNonAbstractCount > 0
                      ? ` · ${hiddenNonAbstractCount} correspondence and news hidden`
                      : '')}
              </p>
              {/* Never filter silently: an explicit, one-click way to see exactly what
                  the abstract-only default is hiding — same transparency principle as
                  the /sources page. */}
              {!includeNonAbstract && hiddenNonAbstractCount > 0 && (
                <button
                  type="button"
                  onClick={() => setIncludeNonAbstract(true)}
                  className="mt-1 text-sm font-medium text-accent hover:underline"
                >
                  Show them
                </button>
              )}

              {hasErrors && (
                <div className="mt-3">
                  <ErrorState
                    compact
                    message={`Some topics couldn't be loaded: ${Object.entries(perTopic)
                      .filter(([, v]) => v.status === 'error')
                      .map(([slug, v]) => `${topicNames[slug] ?? slug} (${describeApiError(v.error)})`)
                      .join('; ')}`}
                    onRetry={retry}
                  />
                </div>
              )}

              {loading && studies.length === 0 && (
                <div className="mt-4">
                  <StudyListSkeleton count={5} />
                </div>
              )}

              {!loading && filteredSorted.length === 0 && (
                <div className="mt-4">
                  <EmptyState
                    icon="🗂️"
                    title={studies.length === 0 ? 'No studies yet for these topics' : 'No studies match your filters'}
                    description={
                      studies.length === 0
                        ? 'Nothing has been indexed for this selection in the served window yet. Try adding more topics.'
                        : 'Try widening the date range, loosening the evidence-level or tier filters, or clearing the text filter.'
                    }
                    action={
                      studies.length === 0 ? (
                        <Link
                          to="/topics"
                          className="mt-2 inline-flex min-h-11 items-center rounded-md px-4 text-sm font-semibold"
                          style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
                        >
                          Add more topics
                        </Link>
                      ) : (
                        <button
                          type="button"
                          onClick={resetFilters}
                          className="mt-2 min-h-11 rounded-md border border-line-strong px-4 text-sm font-medium text-ink hover:bg-line"
                        >
                          Reset filters
                        </button>
                      )
                    }
                  />
                </div>
              )}

              <div className="mt-4 flex flex-col gap-3">
                {page.map((study) => (
                  <StudyCard
                    key={study.pmid}
                    study={study}
                    topicNames={topicNames}
                    onRemoveTopic={removeTopic}
                  />
                ))}
              </div>

              {visibleCount < filteredSorted.length && (
                <div className="mt-6 flex justify-center">
                  <button
                    type="button"
                    onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}
                    className="min-h-11 rounded-md border border-line-strong px-5 text-sm font-medium text-ink hover:bg-line"
                  >
                    Load more ({filteredSorted.length - visibleCount} remaining)
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
