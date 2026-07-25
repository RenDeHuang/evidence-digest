/** Token minting/hashing. Raw tokens are 32 random bytes, base64url-encoded,
 * and are handed to the caller exactly once (in a URL). Only the SHA-256 hash
 * of the token is ever persisted — see migrations/0001_init.sql on `tokens`
 * for why a manual constant-time string compare isn't needed on top of that. */

export type TokenKind = 'confirm' | 'manage' | 'unsubscribe';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function newRawToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return hex(digest);
}

export function confirmExpiry(now: Date): string {
  return new Date(now.getTime() + SEVEN_DAYS_MS).toISOString();
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function hex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
