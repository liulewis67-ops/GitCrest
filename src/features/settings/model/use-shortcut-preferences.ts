import { useEffect, useState } from "react";
import { readShortcutPreferences, SHORTCUT_PREFERENCES_KEY } from "./shortcut-preferences";

export function useShortcutPreferences() {
  const [shortcuts, setShortcuts] = useState(() => {
    try {
      return readShortcutPreferences(window.localStorage.getItem(SHORTCUT_PREFERENCES_KEY));
    } catch {
      return readShortcutPreferences(null);
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SHORTCUT_PREFERENCES_KEY, JSON.stringify(shortcuts));
    } catch {
      // Shortcut edits remain active for this session when storage is unavailable.
    }
  }, [shortcuts]);

  return { shortcuts, setShortcuts };
}
