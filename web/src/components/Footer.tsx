import { Link } from 'react-router-dom';
import { useManifest } from '../hooks/useApi';
import { formatDate } from '../lib/format';

const GITHUB_REPO = 'https://github.com/muhammadali-k/evidence-digest';

export function Footer() {
  const [manifestState] = useManifest();
  const feedsBase = `${import.meta.env.BASE_URL}feeds`;

  return (
    <footer className="mt-16 border-t border-line">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 text-sm text-ink-muted sm:px-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-serif text-base font-semibold text-ink">Evidence Digest</p>
          <p className="mt-1 max-w-sm">
            Free, no account, no tracking. Peer-reviewed evidence, organized by topic.
          </p>
        </div>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-5 gap-y-2">
          <a href={GITHUB_REPO} target="_blank" rel="noreferrer noopener" className="hover:text-ink hover:underline">
            GitHub repo ↗
          </a>
          <a href={`${feedsBase}/all.xml`} className="hover:text-ink hover:underline">
            Atom feed (all topics)
          </a>
          <Link to="/about" className="hover:text-ink hover:underline">
            About
          </Link>
          <Link to="/privacy" className="hover:text-ink hover:underline">
            Privacy
          </Link>
        </nav>
      </div>
      <div className="border-t border-line px-4 py-3 text-center text-xs text-ink-faint sm:px-6">
        {manifestState.status === 'success'
          ? `Data last updated ${formatDate(manifestState.data.generatedAt.slice(0, 10))}`
          : 'Data freshness unavailable'}
      </div>
    </footer>
  );
}
