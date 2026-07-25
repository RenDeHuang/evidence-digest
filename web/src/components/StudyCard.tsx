import { Link } from 'react-router-dom';
import type { StudyCard as StudyCardData } from '../../../shared/types';
import { EvidenceBadge } from './EvidenceBadge';
import { TopicChip } from './TopicChip';
import { formatDate, relativeDay, scoreDescription, scoreBand, isCorrectionOrRetraction } from '../lib/format';

/** Reader-facing words for the three score bands. The thresholds live in
 *  scoreBand() and were set against a real harvest: the median substantive study
 *  scores 44, the 90th percentile 69. */
const BAND_WORD = { high: 'High', medium: 'Moderate', low: 'Lower' } as const;

/**
 * The relevance score, made interpretable.
 *
 * A bare two-digit number is meaningless on a card face — "Relevance 18" next to
 * an "Other" badge tells a clinician nothing, and the explanation was previously
 * reachable only by hovering, which is to say never on a phone. So the band word
 * and a three-segment meter are both visible, with the number kept for people who
 * want it and the full sentence still available to assistive tech.
 *
 * Colour is paired with the word rather than carrying meaning alone, so the
 * indicator still reads correctly for colour-blind readers and in monochrome.
 */
function ScoreIndicator({ study }: { study: StudyCardData }) {
  const band = scoreBand(study.score);
  const filled = band === 'high' ? 3 : band === 'medium' ? 2 : 1;
  const tone =
    band === 'high'
      ? 'text-ink border-line-strong'
      : band === 'medium'
        ? 'text-ink-muted border-line-strong'
        : 'text-ink-muted border-line';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}
      title={scoreDescription(study)}
      aria-label={scoreDescription(study)}
      tabIndex={0}
    >
      <span aria-hidden="true" className="inline-flex items-end gap-px" role="presentation">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={`w-1 rounded-sm ${i < filled ? 'bg-current' : 'bg-current/25'}`}
            style={{ height: `${4 + i * 2}px` }}
          />
        ))}
      </span>
      <span aria-hidden="true">{BAND_WORD[band]}</span>
      <span aria-hidden="true" className="tabular-nums opacity-70">
        {study.score}
      </span>
    </span>
  );
}

export interface StudyCardProps {
  study: StudyCardData;
  /** topic slug -> display name, so chips read as "Leukemia & MDS" rather than "heme-leukemia". */
  topicNames?: Record<string, string>;
  /** Rendered next to each topic chip when the reader can drop that topic from their feed. */
  onRemoveTopic?: (slug: string) => void;
}

export function StudyCard({ study, topicNames, onRemoveTopic }: StudyCardProps) {
  const flagged = isCorrectionOrRetraction(study.pubTypes);
  const detailPath = `/study/${study.pmid}`;

  return (
    <article className="rounded-lg border border-line bg-surface p-4 shadow-sm sm:p-5">
      {flagged && (
        <p
          className="mb-3 flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-semibold"
          style={{
            backgroundColor: 'var(--ed-warn)',
            color: 'var(--ed-warn-ink)',
            borderColor: 'var(--ed-warn)',
          }}
        >
          <span aria-hidden="true">⚠</span>
          Correction or retraction notice on this record — verify before relying on it.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <EvidenceBadge level={study.evidence.level} label={study.evidence.label} />
        <ScoreIndicator study={study} />
        {study.openAccess && (
          <span className="inline-flex items-center gap-1 rounded-md border border-teal/40 bg-[var(--lvl-trial-bg)] px-2 py-0.5 text-xs font-medium text-[var(--lvl-trial-fg)]">
            Open access
          </span>
        )}
      </div>

      <h3 className="mt-2.5 text-lg leading-snug font-semibold">
        <Link
          to={detailPath}
          state={{ entryDate: study.entryDate }}
          className="text-ink hover:text-accent hover:underline"
        >
          {study.title}
        </Link>
      </h3>

      <p className="mt-1 text-sm text-ink-muted">
        {study.authorLine && <span>{study.authorLine} · </span>}
        <span className="italic">{study.journal.name}</span>
        <span> · {formatDate(study.pubdate)}</span>
        <span className="text-ink-faint"> · indexed {relativeDay(study.entryDate)}</span>
      </p>

      {study.hasAbstract ? (
        study.takeaway && <p className="mt-2.5 line-clamp-3 text-sm text-ink">{study.takeaway}</p>
      ) : (
        <p className="mt-2.5 flex items-center gap-1.5 text-sm text-ink-faint">
          <span
            className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-xs font-medium tracking-wide text-ink-faint uppercase"
            title="No abstract on this record — likely a letter, reply, editorial, erratum, or news item, not a study."
          >
            No abstract
          </span>
          <span>No summary to show — likely correspondence, an editorial, or a news item.</span>
        </p>
      )}

      {study.topics.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Topics">
          {study.topics.map((slug) => (
            <li key={slug}>
              <TopicChip
                label={topicNames?.[slug] ?? slug}
                onRemove={onRemoveTopic ? () => onRemoveTopic(slug) : undefined}
                removeLabel={`Remove ${topicNames?.[slug] ?? slug} from your feed`}
              />
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <a
          href={study.url}
          target="_blank"
          rel="noreferrer noopener"
          className="font-medium text-accent hover:underline"
        >
          PubMed ↗
        </a>
        {study.doiUrl && (
          <a
            href={study.doiUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-accent hover:underline"
          >
            DOI ↗
          </a>
        )}
        {study.pmcid && (
          <a
            href={`https://www.ncbi.nlm.nih.gov/pmc/articles/${study.pmcid}/`}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-accent hover:underline"
          >
            Free full text ↗
          </a>
        )}
      </div>
    </article>
  );
}
