export function PageLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center py-24" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div
        aria-hidden="true"
        className="h-8 w-8 animate-spin rounded-full border-2 border-line-strong border-t-accent"
      />
    </div>
  );
}
