import { useCallback, useEffect, useState } from 'react';
import { STORAGE_KEYS } from '../lib/storage';

export type Theme = 'light' | 'dark';

function readCurrentTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  return attr === 'dark' ? 'dark' : 'light';
}

/**
 * Mirrors the theme the inline bootstrap script in index.html already applied to
 * <html data-theme>. Toggling here updates both the DOM attribute (so CSS reacts
 * immediately) and localStorage (so index.html's bootstrap picks it up next load —
 * that's what avoids a flash of the wrong theme).
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readCurrentTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      // Written as a bare string (not JSON) so index.html's non-JSON-aware bootstrap
      // script — which reads this before React even loads — can use it directly.
      try {
        localStorage.setItem(STORAGE_KEYS.theme, next);
      } catch {
        // Storage unavailable — the toggle still works for this tab via DOM state.
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}
