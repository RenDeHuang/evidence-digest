import { useEffect } from 'react';

/** Sets <title> and the meta description for the current route. */
export function useDocumentTitle(title: string, description?: string): void {
  useEffect(() => {
    document.title = title ? `${title} — Evidence Digest` : 'Evidence Digest';
    if (description) {
      document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    }
  }, [title, description]);
}
