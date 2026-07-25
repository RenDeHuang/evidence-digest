import type { Manifest, PublicSpecialty, PublicTaxonomy, StudyCard, TopicFile } from '../../shared/types';
import type { Env } from './env';
import type { SubscriberRow } from './db';

/**
 * Digest selection.
 *
 * IMPORTANT — substantive-only filter (2026-07-24): a 7-day corpus sample
 * across NEJM/Lancet/JAMA/Annals/Blood/JCO/Circulation showed only ~19% of
 * newly-indexed records carry an abstract; the other ~81% are letters,
 * replies, editorials, errata, and news items PubMed types as a plain
 * "Journal Article" with nothing to distinguish them from research. No
 * publication-type rule separates those from real studies — the absent
 * abstract is the only reliable, cheap discriminator, and a record with no
 * abstract also has an empty `takeaway`, which would render as a bare title
 * with no summary line. So `hasAbstract === false` is a HARD exclusion from
 * the main digest, not a score penalty (scoring.json's `noAbstract` penalty
 * alone does not reliably push every letter/editorial below a subscriber's
 * min_score, since min_score can be 0).
 *
 * One deliberate exception: a published erratum or retraction concerning a
 * study is genuinely important to a clinician even though it has no
 * abstract. Those are pulled into a separate, small "Corrections &
 * retractions" block at the end of the email (cap 3, no takeaway line,
 * bypasses min_score — a retraction's score is crushed by the `correction`
 * penalty and would otherwise never clear a nonzero threshold).
 */

const TOPIC_FETCH_TIMEOUT_MS = 8000;

interface ModuleCache {
  generatedAt: string;
  manifest: Manifest;
  topics: Map<string, TopicFile | null>;
}

let moduleCache: ModuleCache | null = null;

export async function fetchManifest(env: Env): Promise<Manifest> {
  const res = await fetch(`${env.SITE_URL}/api/manifest.json`);
  if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
  return (await res.json()) as Manifest;
}

/** Fetches (and module-scope caches, keyed by manifest.generatedAt) every
 * topic file a batch needs, once — never per subscriber. Returns a map from
 * topic slug to TopicFile (or null if that topic file 404s / is malformed,
 * which is logged and skipped rather than failing the whole tick). */
export async function loadTopicFiles(env: Env, manifest: Manifest, slugs: Iterable<string>): Promise<Map<string, TopicFile | null>> {
  if (!moduleCache || moduleCache.generatedAt !== manifest.generatedAt) {
    moduleCache = { generatedAt: manifest.generatedAt, manifest, topics: new Map() };
  }
  const cache = moduleCache;
  const need = Array.from(new Set(slugs)).filter((s) => !cache.topics.has(s));
  await Promise.all(
    need.map(async (slug) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TOPIC_FETCH_TIMEOUT_MS);
        const res = await fetch(`${env.SITE_URL}/api/topics/${slug}.json`, { signal: controller.signal });
        clearTimeout(timer);
        if (!res.ok) {
          cache.topics.set(slug, null);
          return;
        }
        cache.topics.set(slug, (await res.json()) as TopicFile);
      } catch {
        cache.topics.set(slug, null);
      }
    }),
  );
  return cache.topics;
}

function isCorrectionOrErratum(pubTypes: string[]): boolean {
  return pubTypes.some((pt) => /erratum/i.test(pt) || /retraction/i.test(pt));
}

/** Studies newer than this cutoff are candidates. Falls back to a
 * frequency-based window when the subscriber has no watermark yet. */
function cutoffEntryDate(subscriber: SubscriberRow, now: Date): string {
  if (subscriber.last_sent_entry_date) return subscriber.last_sent_entry_date;
  const days = subscriber.frequency === 'daily' ? 1 : subscriber.frequency === 'weekly' ? 7 : 30;
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export interface SpecialtyGroup {
  slug: string;
  name: string;
  icon: string;
  studies: StudyCard[];
}

export interface DigestSelection {
  groups: SpecialtyGroup[];
  corrections: StudyCard[];
  totalStudies: number; // main studies only, across all groups
  newestEntryDate: string | null; // watermark to persist; null when nothing was included
}

const LIMITS = {
  emailStudiesPerTopic: 6,
  emailMaxStudies: 30,
  correctionsMax: 3,
};

export function selectDigest(
  subscriber: SubscriberRow,
  topicSlugs: string[],
  topicFiles: Map<string, TopicFile | null>,
  taxonomy: PublicTaxonomy,
  now: Date,
  limits: { emailStudiesPerTopic: number; emailMaxStudies: number; correctionsMax: number } = LIMITS,
): DigestSelection {
  const cutoff = cutoffEntryDate(subscriber, now);
  const minScore = subscriber.min_score ?? 0;

  // pmid -> { study, specialtySlug } for main (substantive) studies, first-topic-wins
  // (topicSlugs iterated in the subscriber's own order, which is fine since
  // grouping below re-orders by taxonomy order regardless).
  const mainByPmid = new Map<string, { study: StudyCard; specialtySlug: string }>();
  const correctionsByPmid = new Map<string, StudyCard>();

  for (const slug of topicSlugs) {
    const topicFile = topicFiles.get(slug);
    if (!topicFile) continue;

    const candidates = topicFile.studies.filter((s) => s.entryDate > cutoff);

    const substantive = candidates
      .filter((s) => s.hasAbstract && s.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limits.emailStudiesPerTopic);
    for (const study of substantive) {
      if (!mainByPmid.has(study.pmid)) {
        mainByPmid.set(study.pmid, { study, specialtySlug: topicFile.specialty });
      }
    }

    for (const study of candidates) {
      if (!study.hasAbstract && isCorrectionOrErratum(study.pubTypes) && !correctionsByPmid.has(study.pmid)) {
        correctionsByPmid.set(study.pmid, study);
      }
    }
  }

  const mainSorted = Array.from(mainByPmid.values())
    .sort((a, b) => b.study.score - a.study.score)
    .slice(0, limits.emailMaxStudies);

  const specialtyOrder = new Map<string, PublicSpecialty>();
  for (const sp of taxonomy.specialties) specialtyOrder.set(sp.slug, sp);

  const groupsMap = new Map<string, SpecialtyGroup>();
  for (const { study, specialtySlug } of mainSorted) {
    const sp = specialtyOrder.get(specialtySlug);
    const key = sp?.slug ?? specialtySlug;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, { slug: key, name: sp?.name ?? specialtySlug, icon: sp?.icon ?? '', studies: [] });
    }
    groupsMap.get(key)!.studies.push(study);
  }
  // Order groups by taxonomy order; any specialty slug unknown to the current
  // taxonomy (e.g. renamed/removed since the subscriber picked it) is
  // appended at the end rather than dropped.
  const groups: SpecialtyGroup[] = [];
  for (const sp of taxonomy.specialties) {
    if (groupsMap.has(sp.slug)) groups.push(groupsMap.get(sp.slug)!);
  }
  for (const [key, group] of groupsMap) {
    if (!specialtyOrder.has(key)) groups.push(group);
  }
  // Studies within a group by score descending.
  for (const g of groups) g.studies.sort((a, b) => b.score - a.score);

  const corrections = Array.from(correctionsByPmid.values())
    .sort((a, b) => b.entryDate.localeCompare(a.entryDate))
    .slice(0, limits.correctionsMax);

  const totalStudies = mainSorted.length;

  const allIncludedEntryDates = [...mainSorted.map((m) => m.study.entryDate), ...corrections.map((c) => c.entryDate)];
  const newestEntryDate = allIncludedEntryDates.length > 0 ? allIncludedEntryDates.reduce((a, b) => (b > a ? b : a)) : null;

  return { groups, corrections, totalStudies, newestEntryDate };
}

export function isDigestEmpty(selection: DigestSelection): boolean {
  return selection.totalStudies === 0 && selection.corrections.length === 0;
}
