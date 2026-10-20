import { useSyncExternalStore } from "react";
import { cycleThemeMode, getAppearance, setThemeMode, subscribeAppearance, THEME_MODES, type ThemeMode } from "./appearance-store";

export const THEME_CYCLE = THEME_MODES;
export type Theme = ThemeMode;

export function useAppearance() {
  return useSyncExternalStore(subscribeAppearance, getAppearance, getAppearance);
}

export function useThemePreference() {
  const { preferences } = useAppearance();
  return { theme: preferences.mode, setTheme: setThemeMode, nextTheme: cycleThemeMode };
}
