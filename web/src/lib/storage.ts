/**
 * Thin, exception-safe localStorage/sessionStorage helpers. Every call is wrapped
 * because storage can throw (private browsing, quota, disabled) and none of that
 * should ever crash a page — Evidence Digest works fine with storage unavailable,
 * it just forgets preferences between visits.
 */

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignored — see module note.
  }
}

export function removeKey(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Ignored.
  }
}

export const STORAGE_KEYS = {
  selectedTopics: 'ed-selected-topics',
  theme: 'ed-theme',
  includeNonAbstract: 'ed-include-non-abstract',
} as const;
