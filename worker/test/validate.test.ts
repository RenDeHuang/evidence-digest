import { describe, expect, it } from 'vitest';
import {
  isValidEmail,
  isValidFrequency,
  isValidMinScore,
  isValidSendHour,
  isValidTimezone,
  normalizeEmail,
  validateTopicsShape,
} from '../src/validate';

describe('isValidEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmail('a@example.com')).toBe(true);
    expect(isValidEmail('a.b+tag@sub.example.co.uk')).toBe(true);
  });
  it('rejects malformed or oversized addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
    expect(isValidEmail('a@' + 'b'.repeat(260) + '.com')).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail('  Reader@Example.COM  ')).toBe('reader@example.com');
  });
});

describe('isValidFrequency / isValidMinScore / isValidSendHour', () => {
  it('accepts the allowed frequency set only', () => {
    expect(isValidFrequency('daily')).toBe(true);
    expect(isValidFrequency('weekly')).toBe(true);
    expect(isValidFrequency('monthly')).toBe(true);
    expect(isValidFrequency('hourly')).toBe(false);
    expect(isValidFrequency(undefined)).toBe(false);
  });

  it('accepts integers 0-100 for minScore', () => {
    expect(isValidMinScore(0)).toBe(true);
    expect(isValidMinScore(100)).toBe(true);
    expect(isValidMinScore(50.5)).toBe(false);
    expect(isValidMinScore(-1)).toBe(false);
    expect(isValidMinScore(101)).toBe(false);
  });

  it('accepts integers 0-23 for sendHour', () => {
    expect(isValidSendHour(0)).toBe(true);
    expect(isValidSendHour(23)).toBe(true);
    expect(isValidSendHour(24)).toBe(false);
    expect(isValidSendHour(-1)).toBe(false);
  });
});

describe('isValidTimezone', () => {
  it('accepts real IANA zones and rejects garbage', () => {
    expect(isValidTimezone('America/Chicago')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});

describe('validateTopicsShape', () => {
  it('rejects empty, over-max, non-array, and malformed slugs', () => {
    expect(validateTopicsShape([], 40).ok).toBe(false);
    expect(validateTopicsShape('nope', 40).ok).toBe(false);
    expect(validateTopicsShape(Array.from({ length: 41 }, (_, i) => `t${i}`), 40).ok).toBe(false);
    expect(validateTopicsShape(['Not-Lowercase'], 40).ok).toBe(false);
    expect(validateTopicsShape(['has space'], 40).ok).toBe(false);
  });

  it('de-duplicates while preserving order', () => {
    const result = validateTopicsShape(['a', 'b', 'a'], 40);
    expect(result.ok).toBe(true);
    expect(result.topics).toEqual(['a', 'b']);
  });

  it('accepts exactly maxTopics', () => {
    const topics = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const result = validateTopicsShape(topics, 40);
    expect(result.ok).toBe(true);
    expect(result.topics).toHaveLength(40);
  });
});
