// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { contrastRatio, mix, normalizeHex, readableOn } from "../../src/features/settings/model/color";
import {
  ADVANCED_TOKENS,
  BUILT_IN_THEMES,
  derivePalette,
  parseCustomTheme,
  THEME_TOKENS,
  uniqueThemeName,
  type CustomTheme,
} from "../../src/features/settings/model/themes";
import {
  APPEARANCE_STORAGE_KEY,
  deleteCustomTheme,
  getAppearance,
  parseAppearance,
  previewTheme,
  reloadAppearance,
  resetAppearance,
  saveCustomTheme,
  selectTheme,
  setThemeMode,
  setTypography,
} from "../../src/features/settings/model/appearance-store";
import { parseThemeFile, serializeThemeFile } from "../../src/features/settings/model/theme-file";

const darkSeeds = BUILT_IN_THEMES[0].seeds;

function customTheme(overrides: Partial<CustomTheme> = {}): CustomTheme {
  return { id: "custom-test-1", name: "Ocean", base: "dark", seeds: { ...darkSeeds, accent: "#a48bf0" }, overrides: {}, ...overrides };
}

describe("color helpers", () => {
  it("normalizes hex colors and rejects anything else", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex(" #1D232B ")).toBe("#1d232b");
    expect(normalizeHex("red")).toBeUndefined();
    expect(normalizeHex("#12345")).toBeUndefined();
  });

  it("mixes in sRGB and measures WCAG contrast", () => {
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });

  it("picks the more readable text color for a filled background", () => {
    expect(readableOn("#ffffff")).not.toBe("#ffffff");
    expect(readableOn("#0b1a3a")).toBe("#ffffff");
  });
});

describe("theme palettes", () => {
  it("derives every token as a hex color from seven seeds", () => {
    const palette = derivePalette("light", BUILT_IN_THEMES[1].seeds);
    for (const token of THEME_TOKENS) expect(normalizeHex(palette[token]), token).toBe(palette[token]);
    expect(palette.accentSoft).toMatch(/^rgb\(\d+ \d+ \d+ \/ 9%\)$/);
  });

  it("keeps muted text and filled-button text readable in every built-in theme", () => {
    for (const theme of BUILT_IN_THEMES) {
      const { palette } = theme;
      expect(contrastRatio(palette.textMuted, palette.canvas), `${theme.id} muted on canvas`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.textMuted, palette.surface), `${theme.id} muted on surface`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.onAccent, palette.accent), `${theme.id} on accent`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("lets pinned tokens win and keeps dependent tokens in step", () => {
    const palette = derivePalette("dark", darkSeeds, { accentStrong: "#ff0000" });
    expect(palette.accentStrong).toBe("#ff0000");
    expect(palette.gitModified).toBe("#ff0000");
  });

  it("only accepts complete custom themes and drops overrides of seeded tokens", () => {
    expect(parseCustomTheme({ ...customTheme(), seeds: { ...darkSeeds, text: "nope" } })).toBeUndefined();
    expect(parseCustomTheme({ ...customTheme(), name: "   " })).toBeUndefined();
    const parsed = parseCustomTheme({ ...customTheme(), overrides: { canvas: "#000000", line: "#123456" }, typography: { uiFontSize: 99 } });
    expect(parsed?.overrides).toEqual({ line: "#123456" });
    expect(parsed?.typography).toEqual({ uiFontSize: 16 });
    expect(ADVANCED_TOKENS).not.toContain("canvas");
  });

  it("suffixes names that are already taken", () => {
    expect(uniqueThemeName("Ocean", ["ocean", "Ocean 2"])).toBe("Ocean 3");
    expect(uniqueThemeName("Ocean", [])).toBe("Ocean");
  });
});

describe("stored appearance", () => {
  it("falls back field by field when stored data is damaged", () => {
    expect(parseAppearance("{not json")).toMatchObject({ mode: "system", lightThemeId: "gitcrest-light", darkThemeId: "gitcrest-dark", customThemes: [] });
    const parsed = parseAppearance(JSON.stringify({
      mode: "sepia",
      lightThemeId: "gitcrest-dark",
      darkThemeId: "custom-missing",
      customThemes: [customTheme(), { name: "broken" }],
      typography: { uiFontSize: 4, codeFontSize: 40, uiFontFamily: "Inter; color: red" },
    }));
    expect(parsed.mode).toBe("system");
    expect(parsed.lightThemeId).toBe("gitcrest-light");
    expect(parsed.darkThemeId).toBe("gitcrest-dark");
    expect(parsed.customThemes.map((theme) => theme.id)).toEqual(["custom-test-1"]);
    expect(parsed.typography).toMatchObject({ uiFontSize: 12, codeFontSize: 20, uiFontFamily: "Inter color: red" });
  });

  it("carries the old light/dark preference over when nothing new is stored", () => {
    expect(parseAppearance(null, "light").mode).toBe("light");
    expect(parseAppearance(JSON.stringify({ mode: "dark" }), "light").mode).toBe("dark");
  });
});

describe("appearance store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    reloadAppearance();
  });

  it("puts a theme in the slot for its base and switches a fixed mode to show it", () => {
    setThemeMode("light");
    selectTheme("midnight");
    const { preferences, activeTheme } = getAppearance();
    expect(preferences).toMatchObject({ mode: "dark", darkThemeId: "midnight", lightThemeId: "gitcrest-light" });
    expect(activeTheme.id).toBe("midnight");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.themeId).toBe("midnight");
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY) ?? "{}").darkThemeId).toBe("midnight");
  });

  it("keeps System mode when a theme is picked", () => {
    selectTheme("paper");
    expect(getAppearance().preferences).toMatchObject({ mode: "system", lightThemeId: "paper" });
  });

  it("previews a draft live and restores the saved theme when it is dropped", () => {
    setThemeMode("dark");
    previewTheme(customTheme({ base: "light", seeds: BUILT_IN_THEMES[1].seeds }));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.themeId).toBe("custom-test-1");
    previewTheme(undefined);
    expect(document.documentElement.dataset.themeId).toBe("gitcrest-dark");
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).not.toContain("custom-test-1");
  });

  it("saves a custom theme, shows it, and falls back when it is deleted", () => {
    setThemeMode("dark");
    saveCustomTheme(customTheme());
    expect(getAppearance().activeTheme.id).toBe("custom-test-1");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#a48bf0");
    deleteCustomTheme("custom-test-1");
    expect(getAppearance().preferences.darkThemeId).toBe("gitcrest-dark");
    expect(getAppearance().activeTheme.id).toBe("gitcrest-dark");
  });

  it("moves a theme to the other slot when its base changes", () => {
    setThemeMode("dark");
    saveCustomTheme(customTheme());
    saveCustomTheme(customTheme({ base: "light", seeds: BUILT_IN_THEMES[1].seeds }));
    expect(getAppearance().preferences).toMatchObject({ mode: "light", lightThemeId: "custom-test-1", darkThemeId: "gitcrest-dark" });
  });

  it("drives the type scale and code size from text settings, with theme overrides on top", () => {
    setThemeMode("dark");
    setTypography({ uiFontSize: 15, codeFontSize: 16, codeFontFamily: "Fira Code" });
    const style = document.documentElement.style;
    expect(Number(style.getPropertyValue("--font-scale"))).toBeCloseTo(15 / 13, 5);
    expect(style.getPropertyValue("--code-size")).toBe("16px");
    expect(style.getPropertyValue("--font-mono").startsWith("Fira Code, ")).toBe(true);
    saveCustomTheme(customTheme({ typography: { codeFontSize: 18 } }));
    expect(getAppearance().typography).toMatchObject({ uiFontSize: 15, codeFontSize: 18 });
    expect(style.getPropertyValue("--code-size")).toBe("18px");
  });

  it("resets mode, slots and text but keeps custom themes", () => {
    saveCustomTheme(customTheme());
    setTypography({ uiFontSize: 16 });
    resetAppearance();
    const { preferences } = getAppearance();
    expect(preferences).toMatchObject({ mode: "system", darkThemeId: "gitcrest-dark", typography: { uiFontSize: 13 } });
    expect(preferences.customThemes).toHaveLength(1);
  });
});

describe("theme files", () => {
  it("round-trips a theme with a fresh id and a free name", () => {
    const imported = parseThemeFile(serializeThemeFile(customTheme({ typography: { uiFontSize: 14 } })), ["Ocean"]);
    expect(imported.id).not.toBe("custom-test-1");
    expect(imported.name).toBe("Ocean 2");
    expect(imported).toMatchObject({ base: "dark", seeds: { accent: "#a48bf0" }, typography: { uiFontSize: 14 } });
  });

  it("rejects files that aren't GitCrest themes", () => {
    expect(() => parseThemeFile("{}", [])).toThrow();
    expect(() => parseThemeFile("not json", [])).toThrow();
    expect(() => parseThemeFile(JSON.stringify({ format: "gitcrest-theme", name: "x", base: "dark", seeds: {} }), [])).toThrow();
  });
});
