import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../lib/api';
import type { ApiError } from '../lib/api';
import type {
  Manifest,
  PublicTaxonomy,
  PublicJournalsFile,
  HighlightsFile,
  DayFile,
  SearchIndexFile,
  StudyCard,
} from '../../../shared/types';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'success'; data: T };

/** Generic "fetch once, expose loading/error/success, offer a retry" hook. */
function useAsync<T>(
  fetcher: () => Promise<api.ApiResult<T>>,
  deps: unknown[],
): [AsyncState<T>, () => void] {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetcherRef.current().then((res) => {
      if (cancelled) return;
      setState(res.ok ? { status: 'success', data: res.data } : { status: 'error', error: res.error });
    });
    return () => {
      cancelled = true;
    };
    // deps intentionally drive refetching; fetcherRef sidesteps identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return [state, retry];
}

export function useManifest(): [AsyncState<Manifest>, () => void] {
  return useAsync(api.getManifest, []);
}

export function useTaxonomy(): [AsyncState<PublicTaxonomy>, () => void] {
  return useAsync(api.getTaxonomy, []);
}

export function useJournals(): [AsyncState<PublicJournalsFile>, () => void] {
  return useAsync(api.getJournals, []);
}

export function useHighlights(): [AsyncState<HighlightsFile>, () => void] {
  return useAsync(api.getHighlights, []);
}

export function useSearchIndex(): [AsyncState<SearchIndexFile>, () => void] {
  return useAsync(api.getSearchIndex, []);
}

export function useDay(date: string | null): [AsyncState<DayFile>, () => void] {
  return useAsync(
    () =>
      date
        ? api.getDay(date)
        : Promise.resolve<api.ApiResult<DayFile>>({
            ok: false,
            error: { kind: 'not-found', message: 'No date selected.' },
          }),
    [date],
  );
}

export interface TopicLoadState {
  status: 'loading' | 'success' | 'error';
  total: number;
  returned: number;
  error?: ApiError;
}

export interface TopicFilesResult {
  /** Merged, de-duplicated (by pmid) studies across every requested topic. */
  studies: StudyCard[];
  perTopic: Record<string, TopicLoadState>;
  /** True while at least one requested topic is still in flight. */
  loading: boolean;
}

/**
 * Fetches every selected topic's file in parallel, merges the results by pmid, and
 * keeps per-topic status so the UI can say which topics contributed and surface a
 * per-topic error without one flaky topic file blocking the whole feed.
 */
export function useTopicFiles(slugs: string[]): TopicFilesResult & { retry: () => void } {
  const key = useMemo(() => Array.from(new Set(slugs)).sort().join(','), [slugs]);
  const [nonce, setNonce] = useState(0);
  const [perTopic, setPerTopic] = useState<Record<string, TopicLoadState>>({});
  const [studies, setStudies] = useState<StudyCard[]>([]);

  useEffect(() => {
    const currentSlugs = key ? key.split(',') : [];
    let cancelled = false;

    setStudies([]);
    setPerTopic(
      Object.fromEntries(currentSlugs.map((s) => [s, { status: 'loading' as const, total: 0, returned: 0 }])),
    );

    if (currentSlugs.length === 0) return;

    const seen = new Map<string, StudyCard>();

    currentSlugs.forEach((slug) => {
      api.getTopic(slug).then((res) => {
        if (cancelled) return;
        if (res.ok) {
          for (const study of res.data.studies) {
            if (!seen.has(study.pmid)) seen.set(study.pmid, study);
          }
          setStudies(Array.from(seen.values()));
          setPerTopic((prev) => ({
            ...prev,
            [slug]: { status: 'success', total: res.data.total, returned: res.data.returned },
          }));
        } else {
          setPerTopic((prev) => ({
            ...prev,
            [slug]: { status: 'error', total: 0, returned: 0, error: res.error },
          }));
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [key, nonce]);

  const loading = Object.values(perTopic).some((t) => t.status === 'loading');
  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { studies, perTopic, loading, retry };
}
