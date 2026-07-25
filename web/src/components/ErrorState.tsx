import type { ApiError } from '../lib/api';

export function describeApiError(error?: ApiError): string {
  if (!error) return 'Something went wrong loading this page.';
  switch (error.kind) {
    case 'offline':
      return "Couldn't reach Evidence Digest. Check your connection and try again.";
    case 'not-found':
      return "That couldn't be found.";
    case 'http':
      return `The server had a problem${error.status ? ` (${error.status})` : ''}. Please try again in a moment.`;
    case 'parse':
      return 'The data that came back was not in the expected format. This is usually temporary — please try again.';
  }
}

export interface ErrorStateProps {
  error?: ApiError;
  message?: string;
  onRetry?: () => void;
  compact?: boolean;
}

export function ErrorState({ error, message, onRetry, compact }: ErrorStateProps) {
  const text = message ?? describeApiError(error);
  return (
    <div
      role="alert"
      className={`flex flex-col items-center gap-3 rounded-lg border border-line bg-surface text-center ${
        compact ? 'px-4 py-6' : 'px-6 py-14'
      }`}
    >
      <p className="max-w-prose text-sm text-ink-muted">{text}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-line-strong bg-surface px-3.5 py-1.5 text-sm font-medium text-ink hover:bg-line"
        >
          Try again
        </button>
      )}
    </div>
  );
}
