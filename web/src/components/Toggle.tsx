export interface ToggleProps {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
}

/**
 * Accessible switch: a real <button role="switch"> nested inside its own <label>, so
 * the whole row — not just the small visual track — is a >=44px tap target and is
 * keyboard-operable.
 */
export function Toggle({ id, checked, onChange, label, description }: ToggleProps) {
  return (
    <label
      htmlFor={id}
      className="flex min-h-11 cursor-pointer items-center justify-between gap-3 py-1"
    >
      <span>
        <span className="block text-sm font-medium text-ink">{label}</span>
        {description && <span className="block text-xs text-ink-faint">{description}</span>}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
          checked ? 'border-accent bg-accent' : 'border-line-strong bg-line'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 rounded-full bg-[var(--ed-surface-raised)] shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
          style={{ height: '1.125rem', width: '1.125rem' }}
        />
      </button>
    </label>
  );
}
