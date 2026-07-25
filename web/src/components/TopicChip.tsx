export interface TopicChipProps {
  label: string;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
}

export function TopicChip({ label, onRemove, removeLabel, className = '' }: TopicChipProps) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1 text-xs text-ink-muted ${className}`}
    >
      {label}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel ?? `Remove ${label} from your selection`}
          // The visible glyph stays chip-sized, but an invisible ::after pseudo-element
          // pads the actual hit area out to ~44px so this stays a real tap target on
          // mobile without ballooning the chip itself.
          className="relative -mr-1 ml-0.5 flex h-4 w-4 items-center justify-center rounded-full text-ink-faint after:absolute after:-inset-3.5 after:content-[''] hover:bg-line hover:text-ink"
        >
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </span>
  );
}
