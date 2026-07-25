/**
 * The ONLY place in this app that calls fetch(). Every page/component goes through the
 * hooks in `hooks/useApi.ts`, which in turn call the functions below.
 *
 * The API is a set of immutable-ish static files (contract/api.schema.json), not a
 * server, so "error handling" here mostly means: distinguish "you're offline",
 * "this file doesn't exist yet" (fine — treat as empty), "the file didn't parse"
 * (something is actually wrong), and "the server responded but not with 2xx".
 */
import type {
  Manifest,
  PublicTaxonomy,
  PublicJournalsFile,
  HighlightsFile,
  TopicFile,
  DayFile,
  SearchIndexFile,
  SubscriptionPrefs,
} from '../../../shared/types';

/** The newest `dataVersion` this build of the app knows how to render. */
export const CURRENT_DATA_VERSION = 1;

export function isSupportedVersion(manifest: Manifest): boolean {
  return manifest.dataVersion <= CURRENT_DATA_VERSION;
}

export type ApiErrorKind = 'offline' | 'not-found' | 'http' | 'parse';

export interface ApiError {
  kind: ApiErrorKind;
  message: string;
  status?: number;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const API_BASE = (import.meta.env.VITE_API_BASE ?? `${import.meta.env.BASE_URL}api`).replace(
  /\/$/,
  '',
);

function url(path: string): string {
  return `${API_BASE}/${path.replace(/^\//, '')}`;
}

/** In-memory cache of in-flight/settled requests, shared across every component in the tab. */
const memoCache = new Map<string, Promise<ApiResult<unknown>>>();

async function fetchJson<T>(path: string): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(url(path), { headers: { accept: 'application/json' } });
  } catch {
    // fetch() rejects (rather than resolving with a bad status) on network failure,
    // DNS failure, or being offline entirely.
    return {
      ok: false,
      error: { kind: 'offline', message: "Couldn't reach the server. Check your connection." },
    };
  }

  if (response.status === 404) {
    return {
      ok: false,
      error: { kind: 'not-found', message: 'Not found.', status: 404 },
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      error: {
        kind: 'http',
        message: `The server returned an unexpected response (${response.status}).`,
        status: response.status,
      },
    };
  }

  try {
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      error: { kind: 'parse', message: 'The response was not valid data.' },
    };
  }
}

/**
 * Fetch `path` once and remember the answer for the rest of the session. A failed
 * request is NOT cached — the next call (e.g. a reader pressing "Retry") tries again.
 */
function memoized<T>(cacheKey: string, path: string): Promise<ApiResult<T>> {
  const existing = memoCache.get(cacheKey);
  if (existing) return existing as Promise<ApiResult<T>>;

  const promise = fetchJson<T>(path).then((result) => {
    if (!result.ok) memoCache.delete(cacheKey);
    return result;
  });
  memoCache.set(cacheKey, promise);
  return promise;
}

/** Drop every cached response so the next read re-fetches from the network. */
export function clearApiCache(): void {
  memoCache.clear();
  try {
    Object.keys(sessionStorage)
      .filter((k) => k.startsWith(DAY_STORAGE_PREFIX))
      .forEach((k) => sessionStorage.removeItem(k));
  } catch {
    // sessionStorage can throw in locked-down/private contexts; nothing to clean up then.
  }
}

export function getManifest(): Promise<ApiResult<Manifest>> {
  return memoized('manifest', 'manifest.json');
}

export function getTaxonomy(): Promise<ApiResult<PublicTaxonomy>> {
  return memoized('taxonomy', 'taxonomy.json');
}

export function getJournals(): Promise<ApiResult<PublicJournalsFile>> {
  return memoized('journals', 'journals.json');
}

export function getHighlights(): Promise<ApiResult<HighlightsFile>> {
  return memoized('highlights', 'highlights.json');
}

export function getSearchIndex(): Promise<ApiResult<SearchIndexFile>> {
  return memoized('search-index', 'search-index.json');
}

const emptyTopicFile = (slug: string): TopicFile => ({
  topic: slug,
  specialty: '',
  generatedAt: '',
  total: 0,
  returned: 0,
  studies: [],
});

/**
 * A topic with nothing indexed yet has no file at all — that is a normal, expected
 * state (a brand-new or very quiet topic), not an error, so 404 resolves to an empty
 * TopicFile instead of propagating as `ok: false`.
 */
export async function getTopic(slug: string): Promise<ApiResult<TopicFile>> {
  const result = await memoized<TopicFile>(`topic:${slug}`, `topics/${slug}.json`);
  if (!result.ok && result.error.kind === 'not-found') {
    return { ok: true, data: emptyTopicFile(slug) };
  }
  return result;
}

const DAY_STORAGE_PREFIX = 'ed-day-';

/**
 * Day files are immutable once written by the pipeline, so beyond the in-memory
 * cache, a successful fetch is also written to sessionStorage — an archive browse
 * session that hops between a few dates does not re-download them.
 */
export async function getDay(date: string): Promise<ApiResult<DayFile>> {
  const cacheKey = `day:${date}`;
  const inMemory = memoCache.get(cacheKey);
  if (inMemory) return inMemory as Promise<ApiResult<DayFile>>;

  try {
    const stored = sessionStorage.getItem(DAY_STORAGE_PREFIX + date);
    if (stored) {
      const data = JSON.parse(stored) as DayFile;
      const result: ApiResult<DayFile> = { ok: true, data };
      memoCache.set(cacheKey, Promise.resolve(result));
      return result;
    }
  } catch {
    // Corrupt sessionStorage entry or storage disabled — fall through to network.
  }

  const promise = fetchJson<DayFile>(`days/${date}.json`).then((result) => {
    if (result.ok) {
      try {
        sessionStorage.setItem(DAY_STORAGE_PREFIX + date, JSON.stringify(result.data));
      } catch {
        // Quota exceeded or storage disabled — the in-memory cache still works fine.
      }
    } else {
      memoCache.delete(cacheKey);
    }
    return result;
  });
  memoCache.set(cacheKey, promise);
  return promise;
}

/* -------------------------------------------------------------------------------- *
 * Cloudflare Worker endpoints (email subscribe / manage). Distinct from the static
 * API above: these are POST/GET calls against a small dynamic backend, not cached
 * files, and are skipped entirely if VITE_WORKER_URL is unset (see isWorkerConfigured
 * — /subscribe and /manage both check it before rendering a form).
 *
 * NOTE: no schema for these endpoints was provided under contract/ (only the static
 * file tree is specified there). Request/response shapes below are a best-effort
 * guess at a conventional REST surface and should be reconciled against the actual
 * Worker implementation.
 * -------------------------------------------------------------------------------- */

export function isWorkerConfigured(): boolean {
  return Boolean(import.meta.env.VITE_WORKER_URL);
}

function workerUrl(path: string): string {
  return `${(import.meta.env.VITE_WORKER_URL ?? '').replace(/\/$/, '')}${path}`;
}

async function readJsonResponse<T>(response: Response): Promise<ApiResult<T>> {
  if (response.status === 404) {
    return { ok: false, error: { kind: 'not-found', message: 'Not found.', status: 404 } };
  }
  if (!response.ok) {
    let message = `The server returned an unexpected response (${response.status}).`;
    try {
      const body: unknown = await response.json();
      if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') {
        message = body.error;
      }
    } catch {
      // No JSON body to read a message from — fall back to the generic message above.
    }
    return { ok: false, error: { kind: 'http', message, status: response.status } };
  }
  try {
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch {
    return { ok: false, error: { kind: 'parse', message: 'The response was not valid data.' } };
  }
}

async function workerFetch<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(workerUrl(path), {
      ...init,
      headers: { accept: 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    return {
      ok: false,
      error: { kind: 'offline', message: "Couldn't reach the server. Check your connection." },
    };
  }
  return readJsonResponse<T>(response);
}

export interface SubscribeRequest extends SubscriptionPrefs {
  email: string;
  /**
   * Honeypot field. Real readers never see or fill this; a filled value means "bot".
   *
   * The key MUST be `honeypot` — that is the exact property the Worker inspects in
   * `routes/subscribe.ts`. It was briefly named `website` here, which silently
   * disabled bot rejection altogether: the Worker looked for a key that never
   * arrived, so every submission read as human.
   */
  honeypot?: string;
}

export function subscribeToDigest(payload: SubscribeRequest): Promise<ApiResult<{ message?: string }>> {
  return workerFetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export interface PreferencesResponse extends SubscriptionPrefs {
  email: string;
}

export function getPreferences(token: string): Promise<ApiResult<PreferencesResponse>> {
  return workerFetch(`/api/preferences?token=${encodeURIComponent(token)}`);
}

/**
 * Update a subscriber's preferences.
 *
 * The token goes in the BODY, not the query string: the Worker's
 * `POST /api/preferences` handler reads `body.token` (only its GET counterpart
 * reads `?token=`). Sending it as a query parameter alone failed with
 * `missing_token`, so every preference change on /manage was a no-op.
 */
export function updatePreferences(
  token: string,
  prefs: SubscriptionPrefs,
): Promise<ApiResult<{ message?: string }>> {
  return workerFetch('/api/preferences', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...prefs, token }),
  });
}

/**
 * Unsubscribe.
 *
 * Hits the Worker's dedicated `/api/unsubscribe` endpoint, which accepts GET (for
 * the link in an email footer) and POST (for RFC 8058 one-click). An earlier
 * version sent `DELETE /api/preferences`, a route the Worker answers with 405 —
 * so the Unsubscribe button on /manage could never have worked.
 */
export function unsubscribe(token: string): Promise<ApiResult<{ message?: string }>> {
  return workerFetch(`/api/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST' });
}
