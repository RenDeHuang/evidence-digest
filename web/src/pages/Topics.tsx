import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useManifest, useTaxonomy } from '../hooks/useApi';
import { useTopicSelection } from '../hooks/useTopicSelection';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { ErrorState } from '../components/ErrorState';
import { Skeleton } from '../components/Skeleton';
import { pluralize } from '../lib/format';

export default function Topics() {
  useDocumentTitle(
    'Choose your topics',
    'Pick the medical topics you want to follow. No account needed — your selection is saved on this device and shareable via URL.',
  );

  const [taxonomyState, retryTaxonomy] = useTaxonomy();
  const [manifestState] = useManifest();
  const { selected, setSelected, toggleTopic } = useTopicSelection();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');

  // A `?t=` URL always wins over whatever was in localStorage — that's what makes a
  // shared link deterministic instead of merging into whoever clicked it already had.
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

  const topicCounts = manifestState.status === 'success' ? manifestState.data.topicCounts : {};

  const visibleSpecialties = useMemo(() => {
    if (taxonomyState.status !== 'success') return [];
    const q = query.trim().toLowerCase();
    if (!q) return taxonomyState.data.specialties;
    return taxonomyState.data.specialties
      .map((sp) => ({
        ...sp,
        topics: sp.topics.filter(
          (t) => t.name.toLowerCase().includes(q) || t.blurb.toLowerCase().includes(q),
        ),
      }))
      .filter((sp) => sp.topics.length > 0 || sp.name.toLowerCase().includes(q));
  }, [taxonomyState, query]);

  function toggleSpecialtyAll(topicSlugs: string[]) {
    const allSelected = topicSlugs.every((s) => selected.includes(s));
    setSelected(
      allSelected
        ? selected.filter((s) => !topicSlugs.includes(s))
        : Array.from(new Set([...selected, ...topicSlugs])),
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 pb-28 sm:px-6">
      <h1 className="text-3xl font-semibold">Choose your topics</h1>
      <p className="mt-3 text-ink-muted">
        Pick as many as you like. You can change this any time — it's saved on this device, and
        this page's URL updates as you go, so you can bookmark or share your selection.
      </p>

      <div className="mt-6">
        <label htmlFor="topic-search" className="text-xs font-medium text-ink-muted">
          Search topics
        </label>
        <input
          id="topic-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. lymphoma, sepsis, stroke…"
          className="mt-1 block w-full rounded-md border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink"
        />
      </div>

      <p className="mt-4 text-sm font-medium text-ink" aria-live="polite">
        {selected.length} {pluralize(selected.length, 'topic')} selected
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => setSelected([])}
            className="ml-3 text-accent hover:underline"
          >
            Clear all
          </button>
        )}
      </p>

      {taxonomyState.status === 'loading' && (
        <div className="mt-6 flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      )}

      {taxonomyState.status === 'error' && (
        <div className="mt-6">
          <ErrorState error={taxonomyState.error} onRetry={retryTaxonomy} />
        </div>
      )}

      {taxonomyState.status === 'success' && (
        <div className="mt-6 flex flex-col gap-3">
          {visibleSpecialties.map((sp) => {
            const slugs = sp.topics.map((t) => t.slug);
            const allSelected = slugs.length > 0 && slugs.every((s) => selected.includes(s));
            const someSelected = slugs.some((s) => selected.includes(s));
            return (
              <details
                key={sp.slug}
                open={query.trim().length > 0 || undefined}
                className="group rounded-lg border border-line bg-surface"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
                  <span className="flex items-center gap-2.5">
                    <span aria-hidden="true" className="text-xl">
                      {sp.icon}
                    </span>
                    <span>
                      <span className="block font-serif text-base font-semibold text-ink">{sp.name}</span>
                      <span className="hidden text-xs text-ink-faint sm:block">{sp.blurb}</span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2 sm:gap-3">
                    {someSelected && (
                      <span className="hidden text-xs text-ink-faint sm:inline">
                        {slugs.filter((s) => selected.includes(s)).length}/{slugs.length}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        toggleSpecialtyAll(slugs);
                      }}
                      className="flex min-h-11 items-center justify-center rounded-md border border-line-strong px-2.5 text-xs font-medium text-ink hover:bg-line"
                    >
                      {allSelected ? 'Deselect all' : 'Select all'}
                    </button>
                    <svg
                      aria-hidden="true"
                      viewBox="0 0 12 12"
                      width="11"
                      height="11"
                      className="shrink-0 text-ink-faint transition-transform group-open:rotate-180"
                    >
                      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </summary>

                <ul className="flex flex-col gap-0.5 border-t border-line px-2 py-2">
                  {sp.topics.map((t) => {
                    const inputId = `topic-${t.slug}`;
                    const count = topicCounts[t.slug] ?? 0;
                    return (
                      <li key={t.slug}>
                        <label
                          htmlFor={inputId}
                          className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md px-2 py-2 hover:bg-[var(--color-surface-raised)]"
                        >
                          <input
                            id={inputId}
                            type="checkbox"
                            checked={selected.includes(t.slug)}
                            onChange={() => toggleTopic(t.slug)}
                            className="mt-1 h-4 w-4 shrink-0 accent-[var(--ed-accent)]"
                          />
                          <span className="flex-1">
                            <span className="block text-sm font-medium text-ink">{t.name}</span>
                            <span className="block text-xs text-ink-muted">{t.blurb}</span>
                          </span>
                          <span className="mt-0.5 shrink-0 rounded-full border border-line-strong px-2 py-0.5 text-xs text-ink-faint">
                            {count}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </details>
            );
          })}

          {visibleSpecialties.length === 0 && (
            <p className="py-10 text-center text-sm text-ink-muted">
              No topics match "{query}".
            </p>
          )}
        </div>
      )}

      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-[var(--color-surface)]/97 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <p className="text-sm text-ink-muted">
            {selected.length} {pluralize(selected.length, 'topic')} selected
          </p>
          <Link
            to="/feed"
            className="flex min-h-11 items-center justify-center rounded-md px-5 py-2.5 text-sm font-semibold"
            style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
          >
            Show my evidence
          </Link>
        </div>
      </div>
    </div>
  );
}
