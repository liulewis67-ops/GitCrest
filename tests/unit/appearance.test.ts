// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { contrastRatio, ensureContrast, mix, normalizeHex, readableOn, rotateHue } from "../../src/features/settings/model/color";
import {
  ADVANCED_TOKENS,
  BUILT_IN_THEMES,
  contrastChecks,
  derivePalette,
  fixContrast,
  GRAPH_LANE_TOKENS,
  paletteVariables,
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
  setMotion,
  setStyle,
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

  it("rotates hues without changing how light a color is", () => {
    expect(rotateHue("#ff0000", 120)).toBe("#00ff00");
    expect(rotateHue("#ff0000", -120)).toBe("#0000ff");
    expect(rotateHue("#808080", 90)).toBe("#808080");
    expect(rotateHue("#808080", 0, 0.5)).not.toBe("#808080");
  });

  it("moves a color only as far as needed to reach a contrast ratio", () => {
    expect(ensureContrast("#ffffff", "#000000", 4.5)).toBe("#ffffff");
    const lifted = ensureContrast("#333333", "#1d232b", 4.5);
    expect(contrastRatio(lifted, "#1d232b")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(ensureContrast("#dddddd", "#fafbfc", 3), "#fafbfc")).toBeGreaterThanOrEqual(3);
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

  it("passes every readability check in every built-in theme, with six distinct graph lanes", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(contrastChecks(theme.palette).filter((check) => !check.passes).map((check) => check.id), theme.id).toEqual([]);
      expect(new Set(GRAPH_LANE_TOKENS.map((token) => theme.palette[token])).size, theme.id).toBe(6);
    }
  });

  it("names lane and syntax variables the way tokens.css does", () => {
    const variables = paletteVariables(BUILT_IN_THEMES[0].palette);
    expect(variables).toHaveProperty("--graph-lane-1");
    expect(variables).toHaveProperty("--syntax-keyword");
    expect(variables["--surface-raised"]).toBe("#232a33");
  });

  it("recolors syntax and lanes from a new accent unless they are pinned", () => {
    const blue = derivePalette("dark", darkSeeds);
    const rose = derivePalette("dark", { ...darkSeeds, accent: "#ee8fb0" }, { syntaxString: "#123456" });
    expect(rose.graphLane1).not.toBe(blue.graphLane1);
    expect(rose.syntaxKeyword).not.toBe(blue.syntaxKeyword);
    expect(rose.syntaxString).toBe("#123456");
  });

  it("fixes failing readability checks with the smallest set of changes", () => {
    const unreadable = customTheme({ seeds: { ...darkSeeds, text: "#2a2f36", accent: "#2b3440" }, overrides: { graphLane3: "#1e232a", line: "#445566" } });
    expect(contrastChecks(derivePalette(unreadable.base, unreadable.seeds, unreadable.overrides)).some((check) => !check.passes)).toBe(true);
    const fixed = fixContrast(unreadable);
    const palette = derivePalette(fixed.base, fixed.seeds, fixed.overrides);
    expect(contrastChecks(palette).filter((check) => !check.passes).map((check) => check.id)).toEqual([]);
    expect(fixed.seeds.canvas).toBe(darkSeeds.canvas);
    expect(fixed.overrides.line).toBe("#445566");
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

  it("keeps only known style choices on a theme", () => {
    const parsed = parseCustomTheme({ ...customTheme(), style: { radius: "round", density: "huge", shadow: 3, extra: "x" } });
    expect(parsed?.style).toEqual({ radius: "round" });
    expect(parseCustomTheme({ ...customTheme(), style: { density: "huge" } })).not.toHaveProperty("style");
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
    expect(parsed).toMatchObject({ style: { radius: "default", density: "default", shadow: "default", graphColors: "accent" }, motion: "system" });
  });

  it("reads stored style and motion choices field by field", () => {
    const parsed = parseAppearance(JSON.stringify({ style: { radius: "square", density: "dense", graphColors: "lanes" }, motion: "reduced" }));
    expect(parsed.style).toEqual({ radius: "square", density: "default", shadow: "default", graphColors: "lanes" });
    expect(parsed.motion).toBe("reduced");
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

  it("applies style and motion to the document, with theme style on top", () => {
    setThemeMode("dark");
    setStyle({ radius: "square", density: "compact", shadow: "none", graphColors: "lanes" });
    setMotion("reduced");
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--radius-scale")).toBe("0");
    expect(Number(root.style.getPropertyValue("--density"))).toBeLessThan(1);
    expect(root.style.getPropertyValue("--shadow")).toBe("none");
    expect(root.dataset).toMatchObject({ density: "compact", graphColors: "lanes", motion: "reduced" });
    saveCustomTheme(customTheme({ style: { radius: "round", density: "comfortable" } }));
    expect(getAppearance().style).toEqual({ radius: "round", density: "comfortable", shadow: "none", graphColors: "lanes" });
    expect(root.dataset.density).toBe("comfortable");
    expect(getAppearance().preferences.style.radius).toBe("square");
  });

  it("resets mode, slots, text and style but keeps custom themes", () => {
    saveCustomTheme(customTheme());
    setTypography({ uiFontSize: 16 });
    setStyle({ density: "compact" });
    setMotion("full");
    resetAppearance();
    const { preferences } = getAppearance();
    expect(preferences).toMatchObject({ mode: "system", darkThemeId: "gitcrest-dark", typography: { uiFontSize: 13 }, style: { density: "default" }, motion: "system" });
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

  it("carries a theme's style and syntax colors through a file", () => {
    const imported = parseThemeFile(serializeThemeFile(customTheme({ style: { graphColors: "lanes" }, overrides: { syntaxKeyword: "#ff00aa" } })), []);
    expect(imported).toMatchObject({ style: { graphColors: "lanes" }, overrides: { syntaxKeyword: "#ff00aa" } });
  });

  it("still imports version 1 files, which have no style", () => {
    const { style, ...v1 } = customTheme({ style: { radius: "round" } });
    expect(style).toBeDefined();
    const imported = parseThemeFile(JSON.stringify({ format: "gitcrest-theme", version: 1, ...v1 }), []);
    expect(imported).not.toHaveProperty("style");
    expect(imported.seeds.accent).toBe("#a48bf0");
  });

  it("rejects files that aren't GitCrest themes", () => {
    expect(() => parseThemeFile("{}", [])).toThrow();
    expect(() => parseThemeFile("not json", [])).toThrow();
    expect(() => parseThemeFile(JSON.stringify({ format: "gitcrest-theme", name: "x", base: "dark", seeds: {} }), [])).toThrow();
  });
});
