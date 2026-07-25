import type { EvidenceLevel } from '../../../shared/types';

/** Small glyph paired with every badge so level is never conveyed by colour alone. */
const LEVEL_GLYPH: Record<EvidenceLevel, string> = {
  guideline: '◆',
  'meta-analysis': '▲',
  rct: '●',
  trial: '○',
  observational: '□',
  review: '◇',
  basic: '·',
  'case-report': '–',
  other: '·',
};

export interface EvidenceBadgeProps {
  level: EvidenceLevel;
  label: string;
  size?: 'sm' | 'md';
}

export function EvidenceBadge({ level, label, size = 'md' }: EvidenceBadgeProps) {
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-xs';
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border font-medium tracking-wide ${padding}`}
      style={{
        backgroundColor: `var(--lvl-${level}-bg)`,
        color: `var(--lvl-${level}-fg)`,
        borderColor: `var(--lvl-${level}-border)`,
      }}
    >
      <span aria-hidden="true">{LEVEL_GLYPH[level]}</span>
      {label}
    </span>
  );
}
