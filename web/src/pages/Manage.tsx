import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Frequency } from '../../../shared/types';
import * as api from '../lib/api';
import { useTaxonomy } from '../hooks/useApi';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { TopicChip } from '../components/TopicChip';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { EmptyState } from '../components/EmptyState';
import { describeApiError } from '../components/ErrorState';
import { PageLoading } from '../components/PageLoading';
import { flattenTopics, topicNameMap } from '../lib/taxonomy';

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; error: api.ApiError }
  | { phase: 'ready'; email: string };

export default function Manage() {
  useDocumentTitle('Manage subscription', 'Update your email digest topics, frequency, or unsubscribe.');

  const workerConfigured = api.isWorkerConfigured();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [taxonomyState] = useTaxonomy();

  const [load, setLoad] = useState<LoadState>({ phase: 'loading' });
  const [topics, setTopics] = useState<string[]>([]);
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [thresholdEnabled, setThresholdEnabled] = useState(false);
  const [minScore, setMinScore] = useState(60);
  const [topicQuery, setTopicQuery] = useState('');
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [saveError, setSaveError] = useState('');
  const [confirmingUnsub, setConfirmingUnsub] = useState(false);
  const [unsubStatus, setUnsubStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');

  useEffect(() => {
    if (!workerConfigured || !token) return;
    let cancelled = false;
    setLoad({ phase: 'loading' });
    api.getPreferences(token).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setTopics(res.data.topics);
        setFrequency(res.data.frequency);
        if (typeof res.data.minScore === 'number' && res.data.minScore > 0) {
          setThresholdEnabled(true);
          setMinScore(res.data.minScore);
        }
        setLoad({ phase: 'ready', email: res.data.email });
      } else {
        setLoad({ phase: 'error', error: res.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [token, workerConfigured]);

  const topicNames = taxonomyState.status === 'success' ? topicNameMap(taxonomyState.data) : {};
  const allTopics = useMemo(
    () => (taxonomyState.status === 'success' ? flattenTopics(taxonomyState.data) : []),
    [taxonomyState],
  );
  const topicSuggestions = useMemo(() => {
    const q = topicQuery.trim().toLowerCase();
    if (!q) return [];
    return allTopics.filter((t) => !topics.includes(t.slug) && t.name.toLowerCase().includes(q)).slice(0, 6);
  }, [allTopics, topics, topicQuery]);

  async function handleSave() {
    setSaveStatus('saving');
    const result = await api.updatePreferences(token, {
      topics,
      frequency,
      minScore: thresholdEnabled ? minScore : undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (result.ok) {
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2500);
    } else {
      setSaveStatus('error');
      setSaveError(describeApiError(result.error));
    }
  }

  async function handleUnsubscribe() {
    setUnsubStatus('working');
    const result = await api.unsubscribe(token);
    setUnsubStatus(result.ok ? 'done' : 'error');
  }

  if (!workerConfigured) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-semibold">Manage subscription</h1>
        <div className="mt-6">
          <EmptyState
            icon="✉️"
            title="Email digests aren't switched on for this deployment"
            description="There's no subscription to manage here yet."
          />
        </div>
      </div>
    );
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 sm:px-6">
        <h1 className="text-3xl font-semibold">Manage subscription</h1>
        <div className="mt-6">
          <EmptyState
            icon="🔑"
            title="No token in the link"
            description="Use the link from your subscription confirmation or a digest email — it includes a token that identifies your subscription."
          />
        </div>
      </div>
    );
  }

  if (unsubStatus === 'done') {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-3xl font-semibold">Unsubscribed</h1>
        <p className="mt-3 text-ink-muted">
          Your email address and preferences have been removed. You won't receive any more
          digests.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold">Manage subscription</h1>

      {load.phase === 'loading' && <PageLoading />}

      {load.phase === 'error' && (
        <div className="mt-6">
          <EmptyState
            icon="⚠️"
            title={load.error.kind === 'not-found' ? 'This link is invalid or has expired' : 'Something went wrong'}
            description={
              load.error.kind === 'not-found'
                ? 'Use the most recent link from a digest or confirmation email, or subscribe again.'
                : describeApiError(load.error)
            }
          />
        </div>
      )}

      {load.phase === 'ready' && (
        <div className="mt-6 flex flex-col gap-6">
          <p className="text-sm text-ink-muted">
            Managing preferences for <strong className="text-ink">{load.email}</strong>
          </p>

          <div>
            <p className="text-sm font-medium text-ink">Topics</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {topics.length === 0 && <li className="text-sm text-ink-faint">None selected.</li>}
              {topics.map((slug) => (
                <li key={slug}>
                  <TopicChip
                    label={topicNames[slug] ?? slug}
                    onRemove={() => setTopics((prev) => prev.filter((s) => s !== slug))}
                  />
                </li>
              ))}
            </ul>
            <div className="relative mt-2">
              <label htmlFor="manage-add-topic" className="sr-only">
                Add a topic
              </label>
              <input
                id="manage-add-topic"
                type="text"
                value={topicQuery}
                onChange={(e) => setTopicQuery(e.target.value)}
                placeholder="Add another topic…"
                className="block w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink"
              />
              {topicSuggestions.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded-md border border-line bg-surface shadow-md">
                  {topicSuggestions.map((t) => (
                    <li key={t.slug}>
                      <button
                        type="button"
                        onClick={() => {
                          setTopics((prev) => [...prev, t.slug]);
                          setTopicQuery('');
                        }}
                        className="block min-h-11 w-full px-3 py-2 text-left text-sm text-ink hover:bg-[var(--color-surface-raised)]"
                      >
                        {t.name}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <Select
            id="manage-frequency"
            label="Frequency"
            value={frequency}
            onChange={(v) => setFrequency(v as Frequency)}
            options={FREQUENCIES}
          />

          <div>
            <Toggle
              id="manage-threshold-toggle"
              checked={thresholdEnabled}
              onChange={setThresholdEnabled}
              label="Only send studies scoring at or above a threshold"
            />
            {thresholdEnabled && (
              <div className="mt-2">
                <label htmlFor="manage-threshold" className="text-xs font-medium text-ink-muted">
                  Minimum score: {minScore}
                </label>
                <input
                  id="manage-threshold"
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={minScore}
                  onChange={(e) => setMinScore(Number(e.target.value))}
                  className="mt-2 w-full accent-[var(--ed-accent)]"
                />
              </div>
            )}
          </div>

          {saveStatus === 'error' && (
            <p role="alert" className="text-sm" style={{ color: 'var(--ed-warn)' }}>
              {saveError}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saveStatus === 'saving'}
              className="min-h-11 rounded-md px-5 text-sm font-semibold disabled:opacity-60"
              style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
            >
              {saveStatus === 'saving' ? 'Saving…' : 'Save changes'}
            </button>
            {saveStatus === 'saved' && (
              <span role="status" className="text-sm text-ink-muted">
                Saved.
              </span>
            )}
          </div>

          <div className="mt-4 border-t border-line pt-6">
            {!confirmingUnsub ? (
              <button
                type="button"
                onClick={() => setConfirmingUnsub(true)}
                className="min-h-11 rounded-md border border-line-strong px-4 text-sm font-medium text-ink hover:bg-line"
              >
                Unsubscribe
              </button>
            ) : (
              <div className="rounded-md border border-line-strong p-4">
                <p className="text-sm text-ink">
                  This removes your email address and preferences entirely. Are you sure?
                </p>
                {unsubStatus === 'error' && (
                  <p role="alert" className="mt-2 text-sm" style={{ color: 'var(--ed-warn)' }}>
                    Couldn't unsubscribe — please try again.
                  </p>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={handleUnsubscribe}
                    disabled={unsubStatus === 'working'}
                    className="min-h-11 rounded-md px-4 text-sm font-semibold disabled:opacity-60"
                    style={{ backgroundColor: 'var(--ed-warn)', color: 'var(--ed-warn-ink)' }}
                  >
                    {unsubStatus === 'working' ? 'Working…' : 'Yes, unsubscribe'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmingUnsub(false)}
                    className="min-h-11 rounded-md border border-line-strong px-4 text-sm font-medium text-ink hover:bg-line"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
