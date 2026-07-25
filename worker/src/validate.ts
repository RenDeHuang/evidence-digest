import type { Frequency } from '../../shared/types';

export const MAX_BODY_BYTES = 8 * 1024;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FREQUENCIES: Frequency[] = ['daily', 'weekly', 'monthly'];

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return typeof email === 'string' && email.length > 0 && email.length <= 254 && EMAIL_RE.test(email);
}

export function isValidFrequency(value: unknown): value is Frequency {
  return typeof value === 'string' && (FREQUENCIES as string[]).includes(value);
}

export function isValidMinScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) return false;
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isValidSendHour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23;
}

export interface TopicsValidation {
  ok: boolean;
  topics: string[];
  error?: string;
}

/** Validates the topics array shape + length only. Membership against the
 * site's real taxonomy is checked separately (see taxonomy.ts) because that
 * requires a fetch and callers need to distinguish "malformed" from
 * "unknown slug" for logging, even though both produce a 400. */
export function validateTopicsShape(value: unknown, maxTopics: number): TopicsValidation {
  if (!Array.isArray(value)) return { ok: false, topics: [], error: 'topics must be an array' };
  if (value.length === 0) return { ok: false, topics: [], error: 'select at least one topic' };
  if (value.length > maxTopics) return { ok: false, topics: [], error: `select at most ${maxTopics} topics` };
  const topics: string[] = [];
  for (const t of value) {
    if (typeof t !== 'string' || t.length === 0 || t.length > 80 || !/^[a-z0-9-]+$/.test(t)) {
      return { ok: false, topics: [], error: 'invalid topic slug' };
    }
    topics.push(t);
  }
  // De-duplicate while preserving order.
  return { ok: true, topics: Array.from(new Set(topics)) };
}

export async function readBodyWithSizeLimit(request: Request, maxBytes = MAX_BODY_BYTES): Promise<string | null> {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > maxBytes) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > maxBytes) return null;
  return new TextDecoder().decode(buf);
}
