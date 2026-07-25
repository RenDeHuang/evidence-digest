import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const GITHUB_REPO = 'https://github.com/muhammadali-k/evidence-digest';

export default function About() {
  useDocumentTitle(
    'About',
    'What Evidence Digest is, where its data comes from, and how the ranking works.',
  );

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold">About Evidence Digest</h1>
      <p className="mt-3 text-lg text-ink-muted">
        Evidence Digest watches a curated list of medical and scientific journals and
        surfaces what's newly indexed, organized by topic, so you can catch up in
        minutes instead of scrolling a journal's table of contents.
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">Where the data comes from</h2>
        <p className="mt-2 text-ink-muted">
          Every record comes from{' '}
          <a
            href="https://pubmed.ncbi.nlm.nih.gov/"
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            PubMed
          </a>{' '}
          via the National Library of Medicine's E-utilities. Evidence Digest is an
          independent project and is <strong>not affiliated with, endorsed by, or
          sponsored by the NLM or NCBI</strong>. We poll a fixed list of journals,
          not the whole of PubMed, and only publications from roughly the last 120
          days are kept in the live app; older records simply age out of the served
          window.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">How ranking works</h2>
        <p className="mt-2 text-ink-muted">
          Every study gets a transparent, rule-based relevance score from 0–100.{' '}
          <strong>No AI model reads or judges any study</strong> — the score is
          arithmetic: journal reach, study design (a randomized trial or guideline
          scores higher than a case report), how recently it was indexed, and a
          handful of signal bonuses and penalties (a correction notice, for
          instance, is pushed down but never hidden). The same record always
          produces the same score. The full weights are public — see{' '}
          <a
            href={`${GITHUB_REPO}/blob/main/pipeline/config/scoring.json`}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            scoring.json on GitHub
          </a>
          . Study design is classified from PubMed's own publication types, then
          MeSH terms, then conservative title/abstract cues — again, no model in
          the loop.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">What's stored</h2>
        <p className="mt-2 text-ink-muted">
          Browsing Evidence Digest stores nothing on our servers at all — the site
          is a set of static files. If you choose to subscribe to the email
          digest, we store your email address and your topic preferences, and
          nothing else. Full detail is on the{' '}
          <Link to="/privacy" className="text-accent hover:underline">
            privacy page
          </Link>
          .
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">The code</h2>
        <p className="mt-2 text-ink-muted">
          Evidence Digest is open source. The harvesting pipeline, the ranking
          rules, and this web app are all on{' '}
          <a
            href={GITHUB_REPO}
            target="_blank"
            rel="noreferrer noopener"
            className="text-accent hover:underline"
          >
            GitHub
          </a>
          .
        </p>
      </section>
    </div>
  );
}
