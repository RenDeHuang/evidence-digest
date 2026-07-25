export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  hideLabel?: boolean;
}

export function Select({ id, label, value, onChange, options, hideLabel }: SelectProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-xs font-medium text-ink-muted'}>
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-ink"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
