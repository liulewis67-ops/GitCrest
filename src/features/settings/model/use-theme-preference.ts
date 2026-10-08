import { useCallback, useEffect, useState } from "react";

export const THEME_CYCLE = ["system", "light", "dark"] as const;
export type Theme = typeof THEME_CYCLE[number];

function readThemePreference(): Theme {
  try {
    const stored = window.localStorage.getItem("gitcrest-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function useThemePreference() {
  const [theme, setTheme] = useState<Theme>(readThemePreference);

  useEffect(() => {
    const systemTheme = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : undefined;
    const applyTheme = () => {
      document.documentElement.dataset.theme = theme === "system" ? (systemTheme?.matches ? "light" : "dark") : theme;
    };
    applyTheme();
    systemTheme?.addEventListener("change", applyTheme);
    try {
      window.localStorage.setItem("gitcrest-theme", theme);
    } catch {
      // The theme remains available for this session when storage is unavailable.
    }
    return () => systemTheme?.removeEventListener("change", applyTheme);
  }, [theme]);

  const nextTheme = useCallback(() => {
    setTheme((current) => THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length]);
  }, []);

  return { theme, setTheme, nextTheme };
}
