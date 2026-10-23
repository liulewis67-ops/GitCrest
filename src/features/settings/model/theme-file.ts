import type { CustomTheme } from "./themes";

const THEME_FILE_FORMAT = "gitcrest-theme";
const THEME_FILE_SUFFIX = ".gitcrest-theme.json";

export function serializeThemeFile(theme: CustomTheme): string {
  const { name, base, seeds, overrides, typography, style } = theme;
  // Version 2 added the optional style block; version 1 files have none.
  return `${JSON.stringify({ format: THEME_FILE_FORMAT, version: 2, name, base, seeds, overrides, ...(typography ? { typography } : {}), ...(style ? { style } : {}) }, null, 2)}\n`;
}

export function themeFileName(theme: CustomTheme): string {
  const stem = theme.name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
  return `${stem}${THEME_FILE_SUFFIX}`;
}
