import { useCallback, useEffect, useState } from "react";
import type { WorkspaceMode } from "./workspace-session";

const PANEL_PREFERENCES_KEY = "gitcrest-panels-v1";

/** Which optional panels each task view shows. Saved per device, shared by every repository. */
export type PanelPreferences = {
  sidebarHidden: Record<WorkspaceMode, boolean>;
  /** Changes has no commit inspector. */
  inspectorOpen: Record<Exclude<WorkspaceMode, "changes">, boolean>;
};

export const DEFAULT_PANEL_PREFERENCES: PanelPreferences = {
  sidebarHidden: { changes: false, history: false, branches: false },
  // History reads commits in the center; Branches needs the inspector to say what a graph node is.
  inspectorOpen: { history: false, branches: true },
};

export function readPanelPreferences(serialized: string | null): PanelPreferences {
  try {
    const value: unknown = JSON.parse(serialized || "null");
    if (!value || typeof value !== "object") return DEFAULT_PANEL_PREFERENCES;
    const stored = value as { sidebarHidden?: Record<string, unknown>; inspectorOpen?: Record<string, unknown> };
    const flag = (source: Record<string, unknown> | undefined, key: string, fallback: boolean) =>
      typeof source?.[key] === "boolean" ? source[key] as boolean : fallback;
    return {
      sidebarHidden: {
        changes: flag(stored.sidebarHidden, "changes", false),
        history: flag(stored.sidebarHidden, "history", false),
        branches: flag(stored.sidebarHidden, "branches", false),
      },
      inspectorOpen: {
        history: flag(stored.inspectorOpen, "history", DEFAULT_PANEL_PREFERENCES.inspectorOpen.history),
        branches: flag(stored.inspectorOpen, "branches", DEFAULT_PANEL_PREFERENCES.inspectorOpen.branches),
      },
    };
  } catch {
    return DEFAULT_PANEL_PREFERENCES;
  }
}

export function usePanelPreferences() {
  const [preferences, setPreferences] = useState<PanelPreferences>(() => {
    try {
      return readPanelPreferences(window.localStorage.getItem(PANEL_PREFERENCES_KEY));
    } catch {
      return DEFAULT_PANEL_PREFERENCES;
    }
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // Panels still open and close for this session if storage is unavailable.
    }
  }, [preferences]);

  const setSidebarHidden = useCallback((mode: WorkspaceMode, hidden: boolean) => {
    setPreferences((current) => ({ ...current, sidebarHidden: { ...current.sidebarHidden, [mode]: hidden } }));
  }, []);

  const setInspectorOpen = useCallback((mode: WorkspaceMode, open: boolean) => {
    if (mode === "changes") return;
    setPreferences((current) => ({ ...current, inspectorOpen: { ...current.inspectorOpen, [mode]: open } }));
  }, []);

  return { preferences, setSidebarHidden, setInspectorOpen };
}
