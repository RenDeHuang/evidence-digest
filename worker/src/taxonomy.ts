import type { PublicTaxonomy } from '../../shared/types';
import type { Env } from './env';

/** api/taxonomy.json, fetched from the public site and cached in module scope.
 * Never trust a client-supplied topic slug — this is the source of truth for
 * "does this topic exist", refetched every TTL so a taxonomy change on the
 * site propagates without a worker redeploy. */

const TTL_MS = 5 * 60 * 1000;

interface TaxonomyCache {
  taxonomy: PublicTaxonomy;
  slugs: Set<string>;
  fetchedAt: number;
}

let cache: TaxonomyCache | null = null;

export async function getTaxonomy(env: Env): Promise<TaxonomyCache> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache;

  const res = await fetch(`${env.SITE_URL}/api/taxonomy.json`);
  if (!res.ok) {
    if (cache) return cache; // stale-if-error: don't break signups over a transient site hiccup
    throw new Error(`taxonomy fetch failed: ${res.status}`);
  }
  const taxonomy = (await res.json()) as PublicTaxonomy;
  const slugs = new Set<string>();
  for (const specialty of taxonomy.specialties) {
    for (const topic of specialty.topics) slugs.add(topic.slug);
  }
  cache = { taxonomy, slugs, fetchedAt: now };
  return cache;
}

export async function validTopicSlugs(env: Env, topics: string[]): Promise<{ valid: boolean; unknown: string[] }> {
  const { slugs } = await getTaxonomy(env);
  const unknown = topics.filter((t) => !slugs.has(t));
  return { valid: unknown.length === 0, unknown };
}

/** Display names for a set of topic slugs, in taxonomy order — used to list
 * a reader's chosen topics back to them in the confirmation email. Unknown
 * slugs (stale data) are silently skipped rather than shown as raw slugs. */
export function topicNames(taxonomy: PublicTaxonomy, slugs: string[]): string[] {
  const wanted = new Set(slugs);
  const names: string[] = [];
  for (const specialty of taxonomy.specialties) {
    for (const topic of specialty.topics) {
      if (wanted.has(topic.slug)) names.push(topic.name);
    }
  }
  return names;
}
