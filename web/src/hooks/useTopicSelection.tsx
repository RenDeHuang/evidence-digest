import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { readJSON, writeJSON, STORAGE_KEYS } from '../lib/storage';

interface TopicSelectionValue {
  selected: string[];
  setSelected: (slugs: string[]) => void;
  toggleTopic: (slug: string) => void;
  removeTopic: (slug: string) => void;
  clear: () => void;
}

const TopicSelectionContext = createContext<TopicSelectionValue | null>(null);

/**
 * App-wide "which topics did the reader pick" state. Backed by localStorage so it
 * survives a reload. The /topics page additionally syncs this with the `?t=`
 * query string so a selection is shareable; every other consumer (header count,
 * /feed, /subscribe prefill) just reads `selected` from here.
 */
export function TopicSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelectedState] = useState<string[]>(() =>
    readJSON<string[]>(STORAGE_KEYS.selectedTopics, []),
  );

  const setSelected = useCallback((slugs: string[]) => {
    // De-dupe and drop empties defensively — this is the single write path for
    // every caller (checkbox toggles, "select all", URL sync, "remove" buttons).
    const unique = Array.from(new Set(slugs.filter(Boolean)));
    setSelectedState(unique);
    writeJSON(STORAGE_KEYS.selectedTopics, unique);
  }, []);

  const toggleTopic = useCallback(
    (slug: string) => {
      setSelectedState((prev) => {
        const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
        writeJSON(STORAGE_KEYS.selectedTopics, next);
        return next;
      });
    },
    [],
  );

  const removeTopic = useCallback((slug: string) => {
    setSelectedState((prev) => {
      const next = prev.filter((s) => s !== slug);
      writeJSON(STORAGE_KEYS.selectedTopics, next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedState([]);
    writeJSON(STORAGE_KEYS.selectedTopics, []);
  }, []);

  const value = useMemo(
    () => ({ selected, setSelected, toggleTopic, removeTopic, clear }),
    [selected, setSelected, toggleTopic, removeTopic, clear],
  );

  return <TopicSelectionContext.Provider value={value}>{children}</TopicSelectionContext.Provider>;
}

export function useTopicSelection(): TopicSelectionValue {
  const ctx = useContext(TopicSelectionContext);
  if (!ctx) throw new Error('useTopicSelection must be used within TopicSelectionProvider');
  return ctx;
}
