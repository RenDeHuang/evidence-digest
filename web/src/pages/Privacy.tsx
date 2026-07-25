import { Link } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function Privacy() {
  useDocumentTitle('Privacy', 'What Evidence Digest stores, what it never does, and how to delete your data.');

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold">Privacy</h1>
      <p className="mt-3 text-lg text-ink-muted">
        Evidence Digest is built to need as little about you as possible. This page says exactly
        what that means.
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold">No tracking, ever</h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-ink-muted">
          <li>No cookies.</li>
          <li>No analytics, no telemetry, no error-reporting services.</li>
          <li>No third-party requests of any kind — the app is entirely self-hosted, including its fonts and icons.</li>
          <li>No account, no password, no login, ever.</li>
        </ul>
        <p className="mt-2 text-ink-muted">
          Your topic selection and theme preference live only in your browser's local storage, on
          your device. We never see them.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">If you subscribe by email</h2>
        <p className="mt-2 text-ink-muted">
          The email digest is opt-in and double opt-in: we store your email address, your topic
          preferences, your chosen frequency, and (if set) a minimum score threshold — nothing
          else. That's it. No name, no IP-address log tied to your subscription, no profiling.
          Your address is used only to send the digest you asked for and its confirmation link.
          It is never sold, shared, or used for anything else.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Deleting your data</h2>
        <p className="mt-2 text-ink-muted">
          Every subscription email includes an unsubscribe link, and you can update or remove
          your subscription any time from the{' '}
          <Link to="/manage" className="text-accent hover:underline">
            manage preferences
          </Link>{' '}
          page using the link sent to your email. Unsubscribing deletes your email address and
          preferences from our records; it isn't a soft opt-out flag.
        </p>
      </section>

      <section className="mt-8">
        <h2 className="text-xl font-semibold">Questions</h2>
        <p className="mt-2 text-ink-muted">
          See the{' '}
          <Link to="/about" className="text-accent hover:underline">
            About page
          </Link>{' '}
          for how the data and ranking work, or open an issue on GitHub.
        </p>
      </section>
    </div>
  );
}
