import type { PublicTaxonomy, PublicTopic } from '../../../shared/types';

export interface FlatTopic extends PublicTopic {
  specialtySlug: string;
  specialtyName: string;
  specialtyIcon: string;
}

export function flattenTopics(taxonomy: PublicTaxonomy): FlatTopic[] {
  return taxonomy.specialties.flatMap((sp) =>
    sp.topics.map((t) => ({
      ...t,
      specialtySlug: sp.slug,
      specialtyName: sp.name,
      specialtyIcon: sp.icon,
    })),
  );
}

export function topicNameMap(taxonomy: PublicTaxonomy): Record<string, string> {
  const map: Record<string, string> = {};
  for (const sp of taxonomy.specialties) {
    for (const t of sp.topics) map[t.slug] = t.name;
  }
  return map;
}

export function specialtyNameMap(taxonomy: PublicTaxonomy): Record<string, string> {
  const map: Record<string, string> = {};
  for (const sp of taxonomy.specialties) map[sp.slug] = sp.name;
  return map;
}

export function specialtyIconMap(taxonomy: PublicTaxonomy): Record<string, string> {
  const map: Record<string, string> = {};
  for (const sp of taxonomy.specialties) map[sp.slug] = sp.icon;
  return map;
}
