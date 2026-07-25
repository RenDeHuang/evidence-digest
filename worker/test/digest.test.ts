import { describe, expect, it } from 'vitest';
import type { PublicTaxonomy, StudyCard, TopicFile } from '../../shared/types';
import type { SubscriberRow } from '../src/db';
import { selectDigest, isDigestEmpty } from '../src/digest';

function study(overrides: Partial<StudyCard> & { pmid: string }): StudyCard {
  return {
    doi: null,
    title: `Study ${overrides.pmid}`,
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
    url: `https://pubmed.ncbi.nlm.nih.gov/${overrides.pmid}/`,
    doiUrl: null,
    pmcid: null,
    openAccess: false,
    trialIds: [],
    hasAbstract: true,
    takeaway: 'Why this matters.',
    ...overrides,
  };
}

const taxonomy: PublicTaxonomy = {
  version: 1,
  specialties: [
    { slug: 'hematology', name: 'Hematology', icon: '🩸', blurb: '', topics: [{ slug: 'heme-lymphoma', name: 'Lymphoma', blurb: '' }] },
    { slug: 'oncology', name: 'Oncology', icon: '🎗️', blurb: '', topics: [{ slug: 'onc-breast', name: 'Breast cancer', blurb: '' }] },
  ],
};

function subscriber(overrides: Partial<SubscriberRow> = {}): SubscriberRow {
  return {
    id: 1,
    email: 'reader@example.com',
    status: 'active',
    frequency: 'daily',
    min_score: 0,
    timezone: null,
    send_hour: null,
    created_at: '2026-01-01T00:00:00.000Z',
    confirmed_at: '2026-01-01T00:00:00.000Z',
    unsubscribed_at: null,
    last_sent_at: null,
    last_sent_entry_date: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

function topicFile(specialty: string, studies: StudyCard[]): TopicFile {
  return { topic: specialty, specialty, generatedAt: '2026-07-24T00:00:00.000Z', total: studies.length, returned: studies.length, studies };
}

const NOW = new Date('2026-07-25T06:00:00.000Z');

describe('selectDigest — substantive-only hard filter', () => {
  it('excludes hasAbstract=false studies from the main groups', () => {
    const files = new Map([
      [
        'heme-lymphoma',
        topicFile('hematology', [
          study({ pmid: '1', hasAbstract: true, score: 80, entryDate: '2026-07-25' }),
          study({ pmid: '2', hasAbstract: false, score: 60, entryDate: '2026-07-25', pubTypes: ['Letter'] }),
        ]),
      ],
    ]);
    const selection = selectDigest(subscriber(), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.totalStudies).toBe(1);
    expect(selection.groups[0]!.studies.map((s) => s.pmid)).toEqual(['1']);
  });

  it('routes an erratum/retraction with hasAbstract=false into the corrections block, capped at 3, bypassing min_score', () => {
    const errata = Array.from({ length: 5 }, (_, i) =>
      study({ pmid: `err${i}`, hasAbstract: false, score: 1, entryDate: '2026-07-25', pubTypes: ['Published Erratum'] }),
    );
    const files = new Map([['heme-lymphoma', topicFile('hematology', errata)]]);
    const selection = selectDigest(subscriber({ min_score: 90 }), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.totalStudies).toBe(0);
    expect(selection.corrections).toHaveLength(3);
  });

  it('does not route a plain non-abstract letter into corrections', () => {
    const files = new Map([
      ['heme-lymphoma', topicFile('hematology', [study({ pmid: '1', hasAbstract: false, pubTypes: ['Letter'], entryDate: '2026-07-25' })])],
    ]);
    const selection = selectDigest(subscriber(), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.totalStudies).toBe(0);
    expect(selection.corrections).toHaveLength(0);
    expect(isDigestEmpty(selection)).toBe(true);
  });
});

describe('selectDigest — date cutoff and watermark', () => {
  it('falls back to a frequency-based window when there is no watermark yet', () => {
    const files = new Map([
      [
        'heme-lymphoma',
        topicFile('hematology', [
          study({ pmid: 'new', entryDate: '2026-07-25', score: 70 }),
          study({ pmid: 'old', entryDate: '2026-07-01', score: 99 }),
        ]),
      ],
    ]);
    const selection = selectDigest(subscriber({ frequency: 'daily', last_sent_entry_date: null }), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.groups[0]!.studies.map((s) => s.pmid)).toEqual(['new']);
  });

  it('only includes studies newer than the stored watermark', () => {
    const files = new Map([
      [
        'heme-lymphoma',
        topicFile('hematology', [
          study({ pmid: 'newer', entryDate: '2026-07-25', score: 70 }),
          study({ pmid: 'at-watermark', entryDate: '2026-07-24', score: 90 }),
        ]),
      ],
    ]);
    const selection = selectDigest(subscriber({ last_sent_entry_date: '2026-07-24' }), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.groups[0]!.studies.map((s) => s.pmid)).toEqual(['newer']);
  });

  it('sets the newest-entryDate watermark from included studies only, not skipped ones', () => {
    const files = new Map([
      [
        'heme-lymphoma',
        topicFile('hematology', [
          study({ pmid: 'a', entryDate: '2026-07-25', score: 90 }),
          study({ pmid: 'b', entryDate: '2026-07-24', hasAbstract: false, pubTypes: ['Letter'] }),
        ]),
      ],
    ]);
    const selection = selectDigest(subscriber({ last_sent_entry_date: '2026-07-20' }), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.newestEntryDate).toBe('2026-07-25');
  });

  it('returns a null watermark and isDigestEmpty=true when there is nothing to send', () => {
    const files = new Map([['heme-lymphoma', topicFile('hematology', [])]]);
    const selection = selectDigest(subscriber(), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.newestEntryDate).toBeNull();
    expect(isDigestEmpty(selection)).toBe(true);
  });
});

describe('selectDigest — ranking, caps, grouping', () => {
  it('applies min_score to main studies', () => {
    const files = new Map([
      [
        'heme-lymphoma',
        topicFile('hematology', [
          study({ pmid: 'high', entryDate: '2026-07-25', score: 80 }),
          study({ pmid: 'low', entryDate: '2026-07-25', score: 20 }),
        ]),
      ],
    ]);
    const selection = selectDigest(subscriber({ min_score: 50 }), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.groups[0]!.studies.map((s) => s.pmid)).toEqual(['high']);
  });

  it('caps per-topic and overall, and sorts by score descending', () => {
    const many = Array.from({ length: 10 }, (_, i) => study({ pmid: `s${i}`, entryDate: '2026-07-25', score: i }));
    const files = new Map([['heme-lymphoma', topicFile('hematology', many)]]);
    const selection = selectDigest(subscriber(), ['heme-lymphoma'], files, taxonomy, NOW, {
      emailStudiesPerTopic: 3,
      emailMaxStudies: 30,
      correctionsMax: 3,
    });
    expect(selection.groups[0]!.studies.map((s) => s.pmid)).toEqual(['s9', 's8', 's7']);
  });

  it('de-duplicates a study that matches more than one subscribed topic', () => {
    const shared = study({ pmid: 'dup', entryDate: '2026-07-25', score: 70, topics: ['heme-lymphoma', 'onc-breast'] });
    const files = new Map([
      ['heme-lymphoma', topicFile('hematology', [shared])],
      ['onc-breast', topicFile('oncology', [shared])],
    ]);
    const selection = selectDigest(subscriber(), ['heme-lymphoma', 'onc-breast'], files, taxonomy, NOW);
    expect(selection.totalStudies).toBe(1);
  });

  it('orders groups by taxonomy order regardless of the subscriber topic order', () => {
    const files = new Map([
      ['onc-breast', topicFile('oncology', [study({ pmid: 'o1', entryDate: '2026-07-25', score: 70 })])],
      ['heme-lymphoma', topicFile('hematology', [study({ pmid: 'h1', entryDate: '2026-07-25', score: 70 })])],
    ]);
    // subscriber lists onc-breast first, but taxonomy order is hematology, then oncology
    const selection = selectDigest(subscriber(), ['onc-breast', 'heme-lymphoma'], files, taxonomy, NOW);
    expect(selection.groups.map((g) => g.slug)).toEqual(['hematology', 'oncology']);
  });

  it('skips topics whose file failed to fetch (null) instead of throwing', () => {
    const files = new Map<string, TopicFile | null>([['heme-lymphoma', null]]);
    const selection = selectDigest(subscriber(), ['heme-lymphoma'], files, taxonomy, NOW);
    expect(isDigestEmpty(selection)).toBe(true);
  });
});
