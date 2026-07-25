import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useHighlights, useManifest, useSearchIndex, useTaxonomy } from '../hooks/useApi';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { StudyCard } from '../components/StudyCard';
import { ErrorState } from '../components/ErrorState';
import { StudyListSkeleton } from '../components/Skeleton';
import { topicNameMap } from '../lib/taxonomy';
import { pluralize } from '../lib/format';

const HOW_IT_WORKS = [
  {
    step: '1',
    title: 'Pick your topics',
    body: 'Choose from specialties and subspecialties — as broad or as narrow as you want.',
  },
  {
    step: '2',
    title: 'Browse your evidence',
    body: 'One ranked feed, merged and de-duplicated across everything you picked. Filter by design, date, or journal tier.',
  },
  {
    step: '3',
    title: 'Optionally, get it by email',
    body: 'Daily, weekly, or monthly — double opt-in, and easy to change or cancel any time.',
  },
];

export default function Home() {
  useDocumentTitle(
    '',
    'Pick the medical topics you care about and see newly published peer-reviewed evidence, ranked transparently. Free, no account, no tracking.',
  );

  const [highlightsState] = useHighlights();
  const [manifestState] = useManifest();
  const [taxonomyState] = useTaxonomy();
  const [searchIndexState] = useSearchIndex();
  const [query, setQuery] = useState('');

  const topicNames = taxonomyState.status === 'success' ? topicNameMap(taxonomyState.data) : {};

  const searchResults = useMemo(() => {
    if (searchIndexState.status !== 'success') return [];
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return searchIndexState.data.entries.filter((e) => e.t.toLowerCase().includes(q)).slice(0, 8);
  }, [searchIndexState, query]);

  return (
    <div>
      <section className="mx-auto max-w-3xl px-4 pt-14 pb-10 text-center sm:px-6 sm:pt-20">
        <h1 className="text-4xl leading-tight font-semibold sm:text-5xl">
          The newest peer-reviewed evidence, sorted into what you actually follow.
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-ink-muted">
          Evidence Digest watches leading medical journals and lets you follow only the topics
          you care about — ranked transparently, never by an algorithm you can't inspect.
        </p>

        <div className="mt-8 flex flex-col items-center gap-3">
          <Link
            to="/topics"
            className="flex min-h-11 items-center justify-center rounded-md px-6 py-3 text-base font-semibold"
            style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
          >
            Choose your topics
          </Link>
          <Link to="/feed" className="text-sm text-ink-muted hover:text-ink hover:underline">
            Browse without signing up — there is no sign-up
          </Link>
        </div>

        <p className="mt-6 text-sm text-ink-faint" aria-live="polite">
          {manifestState.status === 'success' &&
            `Watching ${manifestState.data.journalCount} journals · ${manifestState.data.totalStudies.toLocaleString()} studies indexed in the last ${manifestState.data.windowDays} days`}
          {manifestState.status === 'loading' && 'Loading current coverage…'}
        </p>

        <div className="mx-auto mt-8 max-w-sm text-left">
          <label htmlFor="home-search" className="text-xs font-medium text-ink-muted">
            Quick search a study by title
          </label>
          <input
            id="home-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. venetoclax, sepsis bundle…"
            className="mt-1 block w-full rounded-md border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink"
          />
          {searchResults.length > 0 && (
            <ul className="mt-2 divide-y divide-line rounded-md border border-line bg-surface text-left">
              {searchResults.map((r) => (
                <li key={r.p}>
                  <Link
                    to={`/study/${r.p}`}
                    state={{ entryDate: r.d }}
                    className="block px-3 py-2 text-sm text-ink hover:bg-[var(--color-surface-raised)]"
                  >
                    {r.t}
                    <span className="block text-xs text-ink-faint">{r.j}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {query.trim().length >= 2 && searchResults.length === 0 && searchIndexState.status === 'success' && (
            <p className="mt-2 text-xs text-ink-faint">
              No high-signal matches. Try the full feed for a broader search.
            </p>
          )}
        </div>
      </section>

      <section className="border-y border-line bg-[var(--color-surface-raised)] py-10">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <h2 className="text-center text-2xl font-semibold">How it works</h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            {HOW_IT_WORKS.map((s) => (
              <div key={s.step} className="text-center">
                <div
                  className="mx-auto flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold"
                  style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
                  aria-hidden="true"
                >
                  {s.step}
                </div>
                <h3 className="mt-3 font-serif text-lg font-semibold">{s.title}</h3>
                <p className="mt-1.5 text-sm text-ink-muted">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-4 py-12 sm:px-6">
        <div className="flex items-baseline justify-between">
          <h2 className="text-2xl font-semibold">What matters this week</h2>
          {highlightsState.status === 'success' && (
            <span className="text-sm text-ink-faint">
              {highlightsState.data.studies.length}{' '}
              {pluralize(highlightsState.data.studies.length, 'study', 'studies')}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-ink-muted">
          Top-scoring studies across every specialty, from the last week.
        </p>

        {highlightsState.status === 'loading' && (
          <div className="mt-6">
            <StudyListSkeleton count={4} />
          </div>
        )}
        {highlightsState.status === 'error' && (
          <div className="mt-6">
            <ErrorState error={highlightsState.error} />
          </div>
        )}
        {highlightsState.status === 'success' && (
          <div className="mt-6 flex flex-col gap-3">
            {highlightsState.data.studies.slice(0, 12).map((study) => (
              <StudyCard key={study.pmid} study={study} topicNames={topicNames} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
