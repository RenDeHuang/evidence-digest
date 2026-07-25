import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function NotFound() {
  useDocumentTitle('Page not found', 'This page does not exist.');

  return (
    <div className="mx-auto max-w-lg px-4 py-24 text-center sm:px-6">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="mt-3 text-ink-muted">
        The page you're looking for doesn't exist, or the link may be out of date.
      </p>
      <Link
        to="/"
        className="mt-6 inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold"
        style={{ backgroundColor: 'var(--ed-accent)', color: 'var(--ed-accent-ink)' }}
      >
        Back to home
      </Link>
    </div>
  );
}
