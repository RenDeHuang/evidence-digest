import { describe, expect, it } from 'vitest';
import { confirmExpiry, hashToken, newRawToken } from '../src/tokens';

describe('newRawToken', () => {
  it('produces distinct, URL-safe, unpadded base64url tokens', () => {
    const a = newRawToken();
    const b = newRawToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a).not.toContain('=');
    // 32 bytes base64url-encoded, unpadded, is 43 characters.
    expect(a.length).toBe(43);
  });
});

describe('hashToken', () => {
  it('is deterministic and produces a 64-char hex SHA-256 digest', async () => {
    const raw = newRawToken();
    const h1 = await hashToken(raw);
    const h2 = await hashToken(raw);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tokens hash to different values', async () => {
    const h1 = await hashToken(newRawToken());
    const h2 = await hashToken(newRawToken());
    expect(h1).not.toBe(h2);
  });
});

describe('confirmExpiry', () => {
  it('is exactly 7 days after the given time', () => {
    const now = new Date('2026-07-25T00:00:00.000Z');
    expect(confirmExpiry(now)).toBe('2026-08-01T00:00:00.000Z');
  });
});
