import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useManifest, useDay, useTaxonomy } from '../hooks/useApi';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { StudyCard } from '../components/StudyCard';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { Skeleton, StudyListSkeleton } from '../components/Skeleton';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { formatDate, pluralize } from '../lib/format';
import { topicNameMap, specialtyNameMap, specialtyIconMap } from '../lib/taxonomy';
import {
  initialIncludeNonAbstract,
  persistIncludeNonAbstract,
  withIncludeNonAbstractParam,
} from '../lib/abstractFilter';

function humanize(slug: string): string {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function Archive() {
  useDocumentTitle('Archive', 'Browse any day in the served window, grouped by specialty.');

  const [manifestState] = useManifest();
  const [taxonomyState] = useTaxonomy();
  const [searchParams, setSearchParams] = useSearchParams();
  const [date, setDate] = useState<string | null>(searchParams.get('date'));
  // Same default + persistence + URL-shareability as /feed — see lib/abstractFilter.ts.
  const [includeNonAbstract, setIncludeNonAbstractState] = useState(() =>
    initialIncludeNonAbstract(searchParams),
  );

  function setIncludeNonAbstract(next: boolean) {
    setIncludeNonAbstractState(next);
    persistIncludeNonAbstract(next);
    setSearchParams(withIncludeNonAbstractParam(searchParams, next), { replace: true });
  }

  useEffect(() => {
    if (manifestState.status !== 'success') return;
    // Snap to the latest day if nothing is selected yet, or if a bookmarked/typed
    // `?date=` isn't actually in the served window.
    if (!date || !manifestState.data.days.includes(date)) {
      setDate(manifestState.data.latestDay);
    }
  }, [date, manifestState]);

  const [dayState, retryDay] = useDay(date);

  function changeDate(next: string) {
    setDate(next);
    const params = new URLSearchParams(searchParams);
    params.set('date', next);
    setSearchParams(params, { replace: true });
  }

  const topicNames = taxonomyState.status === 'success' ? topicNameMap(taxonomyState.data) : {};
  const specialtyNames = taxonomyState.status === 'success' ? specialtyNameMap(taxonomyState.data) : {};
  const specialtyIcons = taxonomyState.status === 'success' ? specialtyIconMap(taxonomyState.data) : {};

  // Same abstract-only default as /feed (see lib/abstractFilter.ts): letters, replies,
  // editorials, errata and PubMed-mistyped news items have no abstract, so they're
  // hidden here unless the reader opts in.
  const visibleStudies = useMemo(() => {
    if (dayState.status !== 'success') return [];
    return includeNonAbstract
      ? dayState.data.studies
      : dayState.data.studies.filter((s) => s.hasAbstract);
  }, [dayState, includeNonAbstract]);

  const hiddenNonAbstractCount = useMemo(() => {
    if (dayState.status !== 'success' || includeNonAbstract) return 0;
    return dayState.data.studies.reduce((n, s) => (s.hasAbstract ? n : n + 1), 0);
  }, [dayState, includeNonAbstract]);

  const groups = useMemo(() => {
    const bySpecialty = new Map<string, typeof visibleStudies>();
    for (const study of visibleStudies) {
      for (const specialty of study.specialties) {
        const list = bySpecialty.get(specialty) ?? [];
        list.push(study);
        bySpecialty.set(specialty, list);
      }
    }
    return Array.from(bySpecialty.entries())
      .map(([specialty, studies]) => ({
        specialty,
        studies: studies.slice().sort((a, b) => b.score - a.score),
      }))
      .sort((a, b) => b.studies.length - a.studies.length);
  }, [visibleStudies]);

  const days = manifestState.status === 'success' ? manifestState.data.days : [];
  const currentIndex = date ? days.indexOf(date) : -1;
  const olderDate = currentIndex >= 0 && currentIndex < days.length - 1 ? days[currentIndex + 1] : null;
  const newerDate = currentIndex > 0 ? days[currentIndex - 1] : null;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">Archive</h1>
      <p className="mt-3 text-ink-muted">
        Every study indexed on a given day, grouped by specialty. The served window covers the
        last {manifestState.status === 'success' ? manifestState.data.windowDays : '120'} days.
      </p>

      {manifestState.status === 'loading' && <Skeleton className="mt-6 h-10 w-64" />}
      {manifestState.status === 'error' && (
        <div className="mt-6">
          <ErrorState error={manifestState.error} />
        </div>
      )}

      {manifestState.status === 'success' && date && (
        <div className="mt-6 flex flex-wrap items-end gap-3">
          <Select
            id="archive-date"
            label="Date"
            value={date}
            onChange={changeDate}
            options={days.map((d) => ({ value: d, label: formatDate(d) }))}
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!olderDate}
              onClick={() => olderDate && changeDate(olderDate)}
              className="min-h-11 rounded-md border border-line-strong px-3 text-sm font-medium text-ink disabled:opacity-40 hover:enabled:bg-line"
            >
              ← Older
            </button>
            <button
              type="button"
              disabled={!newerDate}
              onClick={() => newerDate && changeDate(newerDate)}
              className="min-h-11 rounded-md border border-line-strong px-3 text-sm font-medium text-ink disabled:opacity-40 hover:enabled:bg-line"
            >
              Newer →
            </button>
          </div>
        </div>
      )}

      {manifestState.status === 'success' && date && (
        <div className="mt-4 max-w-sm">
          <Toggle
            id="archive-include-non-abstract"
            checked={includeNonAbstract}
            onChange={setIncludeNonAbstract}
            label="Include correspondence, editorials & news"
            description="Letters, replies, editorials, errata and news items. These have no abstract, so there is no summary to show."
          />
        </div>
      )}

      {dayState.status === 'loading' && (
        <div className="mt-6">
          <StudyListSkeleton count={4} />
        </div>
      )}

      {dayState.status === 'error' && (
        <div className="mt-6">
          <ErrorState error={dayState.error} onRetry={retryDay} />
        </div>
      )}

      {dayState.status === 'success' && (
        <>
          <p className="mt-6 text-sm text-ink-muted" aria-live="polite">
            {visibleStudies.length} {pluralize(visibleStudies.length, 'study', 'studies')} indexed on{' '}
            {formatDate(dayState.data.date)}
            {!includeNonAbstract && hiddenNonAbstractCount > 0 &&
              ` · ${hiddenNonAbstractCount} correspondence and news hidden`}
          </p>
          {/* Never filter silently — same transparency principle as /feed and /sources. */}
          {!includeNonAbstract && hiddenNonAbstractCount > 0 && (
            <button
              type="button"
              onClick={() => setIncludeNonAbstract(true)}
              className="mt-1 text-sm font-medium text-accent hover:underline"
            >
              Show them
            </button>
          )}

          {dayState.data.studies.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                icon="🗓️"
                title="Nothing indexed this day"
                description="Try an adjacent date — coverage varies day to day, especially on weekends."
              />
            </div>
          ) : visibleStudies.length === 0 ? (
            <div className="mt-4">
              <EmptyState
                icon="🗓️"
                title="Only correspondence, editorials & news indexed this day"
                description={`Every one of the ${dayState.data.studies.length} ${pluralize(dayState.data.studies.length, 'record', 'records')} indexed on ${formatDate(dayState.data.date)} was a letter, reply, editorial, erratum, or news item — none had an abstract to summarize.`}
                action={
                  <button
                    type="button"
                    onClick={() => setIncludeNonAbstract(true)}
                    className="mt-2 min-h-11 rounded-md border border-line-strong px-4 text-sm font-medium text-ink hover:bg-line"
                  >
                    Show them anyway
                  </button>
                }
              />
            </div>
          ) : (
            <div className="mt-4 flex flex-col gap-8">
              {groups.map((g) => (
                <section key={g.specialty}>
                  <h2 className="flex items-center gap-2 text-xl font-semibold">
                    <span aria-hidden="true">{specialtyIcons[g.specialty] ?? '📚'}</span>
                    {specialtyNames[g.specialty] ?? humanize(g.specialty)}
                    <span className="text-sm font-normal text-ink-faint">({g.studies.length})</span>
                  </h2>
                  <div className="mt-3 flex flex-col gap-3">
                    {g.studies.map((study) => (
                      <StudyCard key={`${g.specialty}-${study.pmid}`} study={study} topicNames={topicNames} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
