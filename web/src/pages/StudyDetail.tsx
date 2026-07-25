import { useCallback, useEffect, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import type { Study } from '../../../shared/types';
import * as api from '../lib/api';
import type { ApiError } from '../lib/api';
import { useTaxonomy } from '../hooks/useApi';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { EvidenceBadge } from '../components/EvidenceBadge';
import { TopicChip } from '../components/TopicChip';
import { ErrorState } from '../components/ErrorState';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { formatDate, scoreDescription, vancouverCitation, isCorrectionOrRetraction } from '../lib/format';
import { topicNameMap } from '../lib/taxonomy';

type ResolveState =
  | { phase: 'resolving' }
  | { phase: 'found'; study: Study }
  | { phase: 'not-found' }
  | { phase: 'error'; error: ApiError };

const BATCH_SIZE = 6;

/**
 * Locates the full Study record for `pmid`. Internal links carry the entryDate as
 * router state, which resolves instantly; a direct/shared link has to work harder:
 * the compact search index, then a bounded scan of the served day-file window.
 */
async function resolveStudy(
  pmid: string,
  hintEntryDate: string | undefined,
  isCancelled: () => boolean,
): Promise<ResolveState> {
  async function tryDay(date: string): Promise<Study | null> {
    const res = await api.getDay(date);
    if (!res.ok) return null;
    return res.data.studies.find((s) => s.pmid === pmid) ?? null;
  }

  if (hintEntryDate) {
    const found = await tryDay(hintEntryDate);
    if (isCancelled()) return { phase: 'resolving' };
    if (found) return { phase: 'found', study: found };
  }

  const indexRes = await api.getSearchIndex();
  if (isCancelled()) return { phase: 'resolving' };
  if (indexRes.ok) {
    const entry = indexRes.data.entries.find((e) => e.p === pmid);
    if (entry) {
      const found = await tryDay(entry.d);
      if (isCancelled()) return { phase: 'resolving' };
      if (found) return { phase: 'found', study: found };
    }
  }

  const manifestRes = await api.getManifest();
  if (isCancelled()) return { phase: 'resolving' };
  if (!manifestRes.ok) return { phase: 'error', error: manifestRes.error };

  const days = manifestRes.data.days;
  for (let i = 0; i < days.length; i += BATCH_SIZE) {
    if (isCancelled()) return { phase: 'resolving' };
    const batch = days.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((d) => tryDay(d)));
    const found = results.find((r): r is Study => r !== null);
    if (found) return { phase: 'found', study: found };
  }

  return { phase: 'not-found' };
}

export default function StudyDetail() {
  const { pmid = '' } = useParams<{ pmid: string }>();
  const location = useLocation();
  const [taxonomyState] = useTaxonomy();
  const [state, setState] = useState<ResolveState>({ phase: 'resolving' });
  const [retryNonce, setRetryNonce] = useState(0);
  const [copied, setCopied] = useState(false);

  const hintEntryDate = (location.state as { entryDate?: string } | null)?.entryDate;

  useEffect(() => {
    let cancelled = false;
    setState({ phase: 'resolving' });
    resolveStudy(pmid, hintEntryDate, () => cancelled).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
    // hintEntryDate only matters on the first resolution attempt for a given pmid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pmid, retryNonce]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  const topicNames =
    taxonomyState.status === 'success' ? topicNameMap(taxonomyState.data) : {};

  const study = state.phase === 'found' ? state.study : null;
  useDocumentTitle(
    study ? study.title : 'Study',
    study ? study.takeaway || study.title : 'Study detail.',
  );

  async function copyCitation() {
    if (!study) return;
    const text = vancouverCitation(study);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard API can be unavailable (insecure context, permissions). Fall back
      // to a manual-select workaround so the reader can still copy the citation.
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.focus();
      el.select();
      try {
        document.execCommand('copy');
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      } catch {
        // Nothing more we can do — the citation text is still visible on the page.
      }
      document.body.removeChild(el);
    }
  }

  if (state.phase === 'resolving') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6" aria-live="polite" aria-busy="true">
        <span className="sr-only">Looking up this study…</span>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="mt-3 h-4 w-1/2" />
        <Skeleton className="mt-6 h-32 w-full" />
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <ErrorState error={state.error} onRetry={retry} />
      </div>
    );
  }

  if (state.phase === 'not-found') {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <EmptyState
          icon="📄"
          title="Outside the served window"
          description={`PMID ${pmid} isn't in Evidence Digest's last-120-days window (or doesn't exist). You can still read it directly on PubMed.`}
          action={
            <a
              href={`https://pubmed.ncbi.nlm.nih.gov/${pmid}/`}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-flex min-h-11 items-center rounded-md px-4 text-sm font-semibold"
              style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
            >
              Read it on PubMed ↗
            </a>
          }
        />
      </div>
    );
  }

  if (!study) return null;
  const flagged = isCorrectionOrRetraction(study.pubTypes);

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      {flagged && (
        <p
          className="mb-4 flex items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold"
          style={{ backgroundColor: 'var(--ed-warn)', color: 'var(--ed-warn-ink)', borderColor: 'var(--ed-warn)' }}
        >
          <span aria-hidden="true">⚠</span>
          This record includes a correction or retraction notice — verify before relying on it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <EvidenceBadge level={study.evidence.level} label={study.evidence.label} />
        <span
          className="inline-flex items-center gap-1 rounded-md border border-line-strong px-2 py-0.5 text-xs font-medium text-ink-muted"
          title={scoreDescription(study)}
          aria-label={scoreDescription(study)}
          tabIndex={0}
        >
          <span aria-hidden="true">Relevance</span>
          <span aria-hidden="true" className="font-semibold text-ink">
            {study.score}
          </span>
        </span>
        {study.openAccess && (
          <span className="inline-flex items-center gap-1 rounded-md border border-teal/40 bg-[var(--lvl-trial-bg)] px-2 py-0.5 text-xs font-medium text-[var(--lvl-trial-fg)]">
            Open access
          </span>
        )}
      </div>

      <h1 className="mt-3 text-2xl leading-tight font-semibold sm:text-3xl">{study.title}</h1>

      <p className="mt-2 text-sm text-ink-muted">
        {study.authorLine && <span>{study.authorLine} · </span>}
        <span className="italic">{study.journal.name}</span>
        <span> · {formatDate(study.pubdate)}</span>
        <span className="text-ink-faint"> · indexed {formatDate(study.entryDate)}</span>
      </p>

      {study.topics.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Topics">
          {study.topics.map((slug) => (
            <li key={slug}>
              <TopicChip label={topicNames[slug] ?? slug} />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <a href={study.url} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
          PubMed ↗
        </a>
        {study.doiUrl && (
          <a href={study.doiUrl} target="_blank" rel="noreferrer noopener" className="font-medium text-accent hover:underline">
            DOI ↗
          </a>
        )}
        {study.pmcid && (
          <a
            href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${study.pmcid}/`}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-accent hover:underline"
          >
            Free full text (PMC) ↗
          </a>
        )}
      </div>

      {study.takeaway && (
        <div className="mt-6 rounded-lg border border-line bg-surface p-4">
          <p className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Why this matters</p>
          <p className="mt-1.5 text-ink">{study.takeaway}</p>
        </div>
      )}

      <section className="mt-6">
        <h2 className="text-lg font-semibold">Abstract</h2>
        {study.hasAbstract ? (
          Object.keys(study.sections).length > 0 ? (
            <dl className="mt-2 flex flex-col gap-3">
              {Object.entries(study.sections).map(([label, text]) => (
                <div key={label}>
                  <dt className="text-xs font-semibold tracking-wide text-ink-faint uppercase">{label}</dt>
                  <dd className="mt-1 text-ink">{text}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="mt-2 whitespace-pre-line text-ink">{study.abstract}</p>
          )
        ) : (
          <p className="mt-2 text-sm text-ink-muted">No abstract is available for this record.</p>
        )}
      </section>

      {study.mesh.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold text-ink-muted">MeSH terms</h2>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {study.mesh.map((m) => (
              <li key={m} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted">
                {m}
              </li>
            ))}
          </ul>
        </section>
      )}

      {study.keywords.length > 0 && (
        <section className="mt-4">
          <h2 className="text-sm font-semibold text-ink-muted">Keywords</h2>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {study.keywords.map((k) => (
              <li key={k} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted">
                {k}
              </li>
            ))}
          </ul>
        </section>
      )}

      {study.trialIds.length > 0 && (
        <section className="mt-4">
          <h2 className="text-sm font-semibold text-ink-muted">Trial registration</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {study.trialIds.map((id) =>
              id.startsWith('NCT') ? (
                <li key={id}>
                  <a
                    href={`https://clinicaltrials.gov/study/${id}`}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="rounded-full border border-line-strong px-2.5 py-0.5 text-xs font-medium text-accent hover:underline"
                  >
                    {id} ↗
                  </a>
                </li>
              ) : (
                <li key={id} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-ink-muted">
                  {id}
                </li>
              ),
            )}
          </ul>
        </section>
      )}

      <section className="mt-8 rounded-lg border border-line bg-surface p-4">
        <h2 className="text-sm font-semibold text-ink-muted">Cite this study</h2>
        <p className="mt-2 text-sm text-ink">{vancouverCitation(study)}</p>
        <button
          type="button"
          onClick={copyCitation}
          className="mt-3 min-h-11 rounded-md border border-line-strong px-3 text-sm font-medium text-ink hover:bg-line"
        >
          {copied ? 'Copied!' : 'Copy citation'}
        </button>
        <span className="sr-only" aria-live="polite">
          {copied ? 'Citation copied to clipboard' : ''}
        </span>
      </section>
    </article>
  );
}
