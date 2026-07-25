import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { Frequency } from '../../../shared/types';
import * as api from '../lib/api';
import { useTaxonomy } from '../hooks/useApi';
import { useTopicSelection } from '../hooks/useTopicSelection';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { TopicChip } from '../components/TopicChip';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { EmptyState } from '../components/EmptyState';
import { describeApiError } from '../components/ErrorState';
import { flattenTopics, topicNameMap } from '../lib/taxonomy';

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

export default function Subscribe() {
  useDocumentTitle('Subscribe', 'Get your selected topics delivered by email — daily, weekly, or monthly.');

  const workerConfigured = api.isWorkerConfigured();
  const [taxonomyState] = useTaxonomy();
  const { selected, toggleTopic, removeTopic } = useTopicSelection();

  const [email, setEmail] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [thresholdEnabled, setThresholdEnabled] = useState(false);
  const [minScore, setMinScore] = useState(60);
  const [consent, setConsent] = useState(false);
  const [honeypot, setHoneypot] = useState('');
  const [topicQuery, setTopicQuery] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [emailError, setEmailError] = useState('');

  const topicNames = taxonomyState.status === 'success' ? topicNameMap(taxonomyState.data) : {};
  const allTopics = useMemo(
    () => (taxonomyState.status === 'success' ? flattenTopics(taxonomyState.data) : []),
    [taxonomyState],
  );
  const topicSuggestions = useMemo(() => {
    const q = topicQuery.trim().toLowerCase();
    if (!q) return [];
    return allTopics.filter((t) => !selected.includes(t.slug) && t.name.toLowerCase().includes(q)).slice(0, 6);
  }, [allTopics, selected, topicQuery]);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setEmailError('');

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setEmailError('Enter a valid email address.');
      return;
    }
    if (selected.length === 0) {
      setErrorMessage('Choose at least one topic before subscribing.');
      setStatus('error');
      return;
    }
    if (!consent) {
      setErrorMessage('Please check the consent box to continue.');
      setStatus('error');
      return;
    }

    setStatus('submitting');
    const result = await api.subscribeToDigest({
      email,
      topics: selected,
      frequency,
      minScore: thresholdEnabled ? minScore : undefined,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      honeypot,
    });

    if (result.ok) {
      setStatus('success');
    } else {
      setStatus('error');
      setErrorMessage(describeApiError(result.error));
    }
  }

  if (!workerConfigured) {
    const feedsBase = `${import.meta.env.BASE_URL}feeds`;
    return (
      <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-semibold">Subscribe</h1>
        <div className="mt-6">
          <EmptyState
            icon="✉️"
            title="Email digests aren't switched on for this deployment yet"
            description="You can still get updates with zero setup: subscribe to an Atom feed for any topic in your own reader."
          />
        </div>

        <div className="mt-6 rounded-lg border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">
            {selected.length > 0 ? 'Feeds for your selected topics' : 'All-topics feed'}
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {selected.length > 0 ? (
              selected.map((slug) => (
                <li key={slug} className="flex items-center justify-between gap-3 text-sm">
                  <span className="text-ink">{topicNames[slug] ?? slug}</span>
                  <code className="truncate rounded bg-[var(--color-surface-raised)] px-2 py-1 text-xs text-ink-muted">
                    {`${feedsBase}/${slug}.xml`}
                  </code>
                </li>
              ))
            ) : (
              <li className="flex items-center justify-between gap-3 text-sm">
                <span className="text-ink">Every topic</span>
                <code className="truncate rounded bg-[var(--color-surface-raised)] px-2 py-1 text-xs text-ink-muted">
                  {`${feedsBase}/all.xml`}
                </code>
              </li>
            )}
          </ul>
          {selected.length === 0 && (
            <p className="mt-3 text-sm text-ink-muted">
              <Link to="/topics" className="text-accent hover:underline">
                Choose topics
              </Link>{' '}
              to get a feed link per topic instead of everything.
            </p>
          )}
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center sm:px-6">
        <h1 className="text-3xl font-semibold">Check your email</h1>
        <p className="mt-3 text-ink-muted">
          We've sent a confirmation link to <strong>{email}</strong>. Nothing will be sent until
          you click it.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold">Subscribe</h1>
      <p className="mt-3 text-ink-muted">
        We'll email you a confirmation link — nothing is sent until you click it. Your address is
        used for nothing else. See the{' '}
        <Link to="/privacy" className="text-accent hover:underline">
          privacy page
        </Link>
        .
      </p>

      <form onSubmit={handleSubmit} noValidate className="mt-8 flex flex-col gap-6">
        <div>
          <label htmlFor="subscribe-email" className="text-sm font-medium text-ink">
            Email address
          </label>
          <input
            id="subscribe-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={emailError ? 'subscribe-email-error' : undefined}
            aria-invalid={emailError ? true : undefined}
            className="mt-1.5 block w-full rounded-md border border-line-strong bg-surface px-3 py-2.5 text-sm text-ink"
          />
          {emailError && (
            <p id="subscribe-email-error" role="alert" className="mt-1.5 text-sm" style={{ color: 'var(--ed-warn)' }}>
              {emailError}
            </p>
          )}
        </div>

        {/* Honeypot: real people never see this field (visually hidden + off tab order). */}
        <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
          <label htmlFor="subscribe-website">Leave this field blank</label>
          <input
            id="subscribe-website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </div>

        <div>
          <p className="text-sm font-medium text-ink">Topics</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {selected.length === 0 && <li className="text-sm text-ink-faint">None selected yet.</li>}
            {selected.map((slug) => (
              <li key={slug}>
                <TopicChip label={topicNames[slug] ?? slug} onRemove={() => removeTopic(slug)} />
              </li>
            ))}
          </ul>
          <div className="relative mt-2">
            <label htmlFor="subscribe-add-topic" className="sr-only">
              Add a topic
            </label>
            <input
              id="subscribe-add-topic"
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
                        toggleTopic(t.slug);
                        setTopicQuery('');
                      }}
                      className="block min-h-11 w-full px-3 py-2 text-left text-sm text-ink hover:bg-[var(--color-surface-raised)]"
                    >
                      {t.name}
                      <span className="block text-xs text-ink-faint">{t.specialtyName}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="mt-1.5 text-xs text-ink-faint">
            <Link to="/topics" className="text-accent hover:underline">
              Open the full topic picker
            </Link>{' '}
            for browsing by specialty.
          </p>
        </div>

        <Select
          id="subscribe-frequency"
          label="Frequency"
          value={frequency}
          onChange={(v) => setFrequency(v as Frequency)}
          options={FREQUENCIES}
        />

        <div>
          <Toggle
            id="subscribe-threshold-toggle"
            checked={thresholdEnabled}
            onChange={setThresholdEnabled}
            label="Only send studies scoring at or above a threshold"
            description="Off by default — you'll get everything matched to your topics."
          />
          {thresholdEnabled && (
            <div className="mt-2">
              <label htmlFor="subscribe-threshold" className="text-xs font-medium text-ink-muted">
                Minimum score: {minScore}
              </label>
              <input
                id="subscribe-threshold"
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

        <label className="flex items-start gap-3 text-sm text-ink">
          <input
            type="checkbox"
            required
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--ed-accent)]"
          />
          <span>
            I understand Evidence Digest will email me a confirmation link, and that nothing is
            sent until I click it. I can unsubscribe any time.
          </span>
        </label>

        {status === 'error' && (
          <p role="alert" className="text-sm" style={{ color: 'var(--ed-warn)' }}>
            {errorMessage}
          </p>
        )}

        <button
          type="submit"
          disabled={status === 'submitting'}
          className="min-h-11 rounded-md px-5 text-sm font-semibold disabled:opacity-60"
          style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
        >
          {status === 'submitting' ? 'Sending…' : 'Subscribe'}
        </button>
      </form>
    </div>
  );
}
