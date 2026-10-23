import { t } from "../../../shared/i18n";
import { newCustomThemeId, parseCustomTheme, uniqueThemeName, type CustomTheme } from "./themes";

const THEME_FILE_FORMAT = "gitcrest-theme";
export const THEME_FILE_SUFFIX = ".gitcrest-theme.json";
const MAX_THEME_FILE_BYTES = 64 * 1024;

export function serializeThemeFile(theme: CustomTheme): string {
  const { name, base, seeds, overrides, typography, style } = theme;
  // Version 2 adds the optional style block; version 1 files still import and simply have none.
  return `${JSON.stringify({ format: THEME_FILE_FORMAT, version: 2, name, base, seeds, overrides, ...(typography ? { typography } : {}), ...(style ? { style } : {}) }, null, 2)}\n`;
}

export function themeFileName(theme: CustomTheme): string {
  const stem = theme.name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
  return `${stem}${THEME_FILE_SUFFIX}`;
}

/** Reads an exported theme. The result always gets a fresh id and a name no other theme uses. */
export function parseThemeFile(text: string, takenNames: readonly string[]): CustomTheme {
  if (text.length > MAX_THEME_FILE_BYTES) throw new Error(t("appearance.importTooLarge"));
  let source: unknown;
  try {
    source = JSON.parse(text);
  } catch {
    throw new Error(t("appearance.importInvalid"));
  }
  if (!source || typeof source !== "object" || (source as Record<string, unknown>).format !== THEME_FILE_FORMAT) {
    throw new Error(t("appearance.importInvalid"));
  }
  const theme = parseCustomTheme({ ...source, id: newCustomThemeId() });
  if (!theme) throw new Error(t("appearance.importInvalid"));
  return { ...theme, name: uniqueThemeName(theme.name, takenNames) };
}
