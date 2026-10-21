import { useCallback, useState } from "react";

const STORAGE_KEY = "gitcrest-diff-view-v1";

export interface DiffViewPreferences {
  /** "full" compares both whole files; "hunks" lists changed hunks so lines can be staged or discarded. */
  layout: "full" | "hunks";
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  collapseUnchanged: boolean;
}

export const DEFAULT_DIFF_VIEW_PREFERENCES: DiffViewPreferences = {
  layout: "full",
  sideBySide: true,
  ignoreWhitespace: false,
  collapseUnchanged: false,
};

export function readDiffViewPreferences(value: string | null): DiffViewPreferences {
  if (!value) return DEFAULT_DIFF_VIEW_PREFERENCES;
  try {
    const candidate = JSON.parse(value) as Partial<Record<keyof DiffViewPreferences, unknown>>;
    return {
      layout: candidate.layout === "hunks" ? "hunks" : "full",
      sideBySide: typeof candidate.sideBySide === "boolean" ? candidate.sideBySide : DEFAULT_DIFF_VIEW_PREFERENCES.sideBySide,
      ignoreWhitespace: typeof candidate.ignoreWhitespace === "boolean" ? candidate.ignoreWhitespace : DEFAULT_DIFF_VIEW_PREFERENCES.ignoreWhitespace,
      collapseUnchanged: typeof candidate.collapseUnchanged === "boolean" ? candidate.collapseUnchanged : DEFAULT_DIFF_VIEW_PREFERENCES.collapseUnchanged,
    };
  } catch {
    return DEFAULT_DIFF_VIEW_PREFERENCES;
  }
}

export function useDiffViewPreferences() {
  const [preferences, setPreferences] = useState<DiffViewPreferences>(() => {
    try {
      return readDiffViewPreferences(window.localStorage.getItem(STORAGE_KEY));
    } catch {
      return DEFAULT_DIFF_VIEW_PREFERENCES;
    }
  });
  const updatePreferences = useCallback((change: Partial<DiffViewPreferences>) => {
    setPreferences((current) => {
      const next = { ...current, ...change };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Preferences still apply for this session when storage is unavailable.
      }
      return next;
    });
  }, []);
  return { preferences, updatePreferences };
}
