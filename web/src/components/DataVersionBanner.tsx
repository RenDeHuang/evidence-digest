import { useManifest } from '../hooks/useApi';
import { isSupportedVersion } from '../lib/api';

/**
 * The pipeline bumps `manifest.dataVersion` only on a breaking change to the study
 * shape. If this build of the app is older than that, rendering the new data would
 * silently show broken or missing fields, so we refuse and ask for a reload instead.
 */
export function DataVersionBanner() {
  const [manifestState] = useManifest();

  if (manifestState.status !== 'success' || isSupportedVersion(manifestState.data)) {
    return null;
  }

  return (
    <div
      role="alert"
      className="border-b px-4 py-2.5 text-center text-sm font-medium"
      style={{ backgroundColor: 'var(--ed-warn)', color: 'var(--ed-warn-ink)' }}
    >
      This page is out of date and may not display correctly.{' '}
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="underline underline-offset-2"
      >
        Reload to get the latest version
      </button>
      .
    </div>
  );
}
