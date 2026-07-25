import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  icon?: string;
}

export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && (
        <span aria-hidden="true" className="text-3xl">
          {icon}
        </span>
      )}
      <p className="text-base font-semibold text-ink">{title}</p>
      {description && <p className="max-w-prose text-sm text-ink-muted">{description}</p>}
      {action}
    </div>
  );
}
