import type { EvidenceLevel } from '../../../shared/types';

/**
 * Canonical display order + labels for the nine evidence-design buckets, mirroring
 * pipeline/config/scoring.json's `evidenceLevels` (rank 1 = strongest). This is UI
 * chrome for the level filter, not a tunable weight, so it's fine to fix here —
 * the type itself (EvidenceLevel) already comes from shared/types.ts.
 */
export const EVIDENCE_LEVELS: ReadonlyArray<{ level: EvidenceLevel; label: string }> = [
  { level: 'guideline', label: 'Guideline' },
  { level: 'meta-analysis', label: 'Meta-analysis' },
  { level: 'rct', label: 'Randomized trial' },
  { level: 'trial', label: 'Clinical trial' },
  { level: 'observational', label: 'Observational' },
  { level: 'review', label: 'Review' },
  { level: 'basic', label: 'Preclinical' },
  { level: 'case-report', label: 'Case report' },
  { level: 'other', label: 'Other' },
];

export const ALL_EVIDENCE_LEVELS: ReadonlyArray<EvidenceLevel> = EVIDENCE_LEVELS.map((l) => l.level);
