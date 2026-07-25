import { describe, expect, it } from 'vitest';
import type { PublicTaxonomy, StudyCard } from '../../shared/types';
import type { SpecialtyGroup } from '../src/digest';
import { digestEmail } from '../src/templates/digest';
import { confirmEmail } from '../src/templates/confirm';
import { escapeHtml } from '../src/http';

function study(overrides: Partial<StudyCard> & { pmid: string }): StudyCard {
  return {
    doi: '10.1000/xyz',
    title: 'A study',
    authors: [],
    authorLine: '',
    journal: { name: 'Test Journal', ta: 'Test J', tier: 1 },
    specialties: ['hematology'],
    topics: ['heme-lymphoma'],
    pubTypes: ['Journal Article'],
    evidence: { level: 'rct', label: 'Randomized trial', rank: 3 },
    score: 50,
    pubdate: '2026-07-24',
    entryDate: '2026-07-24',
    url: 'https://pubmed.ncbi.nlm.nih.gov/1/',
    doiUrl: 'https://doi.org/10.1000/xyz',
    pmcid: null,
    openAccess: false,
    trialIds: [],
    hasAbstract: true,
    takeaway: 'Why this matters.',
    ...overrides,
  };
}

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's "quote"</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s &quot;quote&quot;&lt;/a&gt;',
    );
  });
});

describe('digestEmail', () => {
  it('escapes an untrusted title so it cannot break out of the HTML', () => {
    const malicious = study({ pmid: '1', title: '<script>alert(1)</script> & "quotes"' });
    const groups: SpecialtyGroup[] = [{ slug: 'hematology', name: 'Hematology', icon: '🩸', studies: [malicious] }];
    const rendered = digestEmail({
      groups,
      corrections: [],
      frequency: 'daily',
      manageUrl: 'https://site.example/manage?token=abc',
      unsubscribeUrl: 'https://api.example/api/unsubscribe?token=abc',
      siteUrl: 'https://site.example',
    });
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('produces a subject line with the study count and specialty names', () => {
    const groups: SpecialtyGroup[] = [
      { slug: 'hematology', name: 'Hematology', icon: '🩸', studies: [study({ pmid: '1' }), study({ pmid: '2' })] },
    ];
    const rendered = digestEmail({
      groups,
      corrections: [],
      frequency: 'weekly',
      manageUrl: 'https://site.example/manage?token=abc',
      unsubscribeUrl: 'https://api.example/api/unsubscribe?token=abc',
      siteUrl: 'https://site.example',
    });
    expect(rendered.subject).toBe('Evidence Digest — 2 new studies in Hematology');
  });

  it('a text alternative exists and contains the study title and links, not raw HTML tags', () => {
    const groups: SpecialtyGroup[] = [{ slug: 'hematology', name: 'Hematology', icon: '🩸', studies: [study({ pmid: '1', title: 'Plain title' })] }];
    const rendered = digestEmail({
      groups,
      corrections: [],
      frequency: 'daily',
      manageUrl: 'https://site.example/manage?token=abc',
      unsubscribeUrl: 'https://api.example/api/unsubscribe?token=abc',
      siteUrl: 'https://site.example',
    });
    expect(rendered.text).toContain('Plain title');
    expect(rendered.text).toContain('https://pubmed.ncbi.nlm.nih.gov/1/');
    expect(rendered.text).not.toContain('<div');
  });
});

describe('confirmEmail', () => {
  it('lists the chosen topics back and includes the "ignore this" disclaimer', () => {
    const rendered = confirmEmail({
      topicNames: ['Lymphoma', 'Breast cancer'],
      frequency: 'daily',
      confirmUrl: 'https://api.example/api/confirm?token=abc',
      siteUrl: 'https://site.example',
      expiryDays: 7,
    });
    expect(rendered.html).toContain('Lymphoma, Breast cancer');
    expect(rendered.text).toContain('Lymphoma, Breast cancer');
    expect(rendered.text.toLowerCase()).toContain('if you did not request this');
    expect(rendered.text).toContain('7 days');
  });
});
