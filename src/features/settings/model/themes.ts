import type { MessageKey } from "../../../shared/i18n";
import { contrastRatio, mix, normalizeHex, readableOn, withAlpha, type Hex } from "./color";

export type ThemeBase = "light" | "dark";

/** Palette tokens a theme can set, in the order the advanced editor lists them. Each maps to `--<kebab-case>` in tokens.css. */
export const THEME_TOKENS = [
  "canvas", "surface", "surfaceRaised", "surfaceSoft", "line", "lineStrong",
  "text", "textSecondary", "textMuted",
  "accent", "accentStrong", "onAccent",
  "green", "amber", "danger",
  "gitModified", "gitAdded", "gitDeleted", "gitRenamed", "gitUntracked", "gitConflicted", "gitIgnored",
] as const;
export type ThemeToken = typeof THEME_TOKENS[number];

/** Tokens derived from the seeds; the advanced editor can pin any of them. */
export const ADVANCED_TOKENS = [
  "surfaceRaised", "surfaceSoft", "line", "lineStrong", "textSecondary", "textMuted", "accentStrong", "onAccent",
  "gitModified", "gitAdded", "gitDeleted", "gitRenamed", "gitUntracked", "gitConflicted", "gitIgnored",
] as const satisfies readonly ThemeToken[];
export type AdvancedThemeToken = typeof ADVANCED_TOKENS[number];

/** The seven colors the basic editor asks for; every other token is derived from them. */
export const THEME_SEEDS = ["canvas", "surface", "text", "accent", "success", "warning", "danger"] as const;
export type ThemeSeed = typeof THEME_SEEDS[number];
export type ThemeSeeds = Record<ThemeSeed, Hex>;

export type ThemePalette = Record<ThemeToken, Hex> & {
  accentSoft: string;
  greenSoft: string;
  dangerSoft: string;
  shadow: string;
};

export interface ThemeTypographyOverride {
  uiFontSize?: number;
  codeFontSize?: number;
}

export interface CustomTheme {
  id: string;
  name: string;
  base: ThemeBase;
  seeds: ThemeSeeds;
  overrides: Partial<Record<ThemeToken, Hex>>;
  typography?: ThemeTypographyOverride;
}

export interface ThemeDefinition extends CustomTheme {
  builtIn: boolean;
  /** Built-in themes show a translated name. */
  nameKey?: MessageKey;
  palette: ThemePalette;
}

export interface Typography {
  uiFontSize: number;
  codeFontSize: number;
  uiFontFamily: string;
  codeFontFamily: string;
}

export const UI_FONT_SIZES = { min: 12, max: 16, default: 13 } as const;
export const CODE_FONT_SIZES = { min: 11, max: 20, default: 13 } as const;
export const THEME_NAME_MAX_LENGTH = 40;
const FONT_FAMILY_MAX_LENGTH = 120;

export const DEFAULT_TYPOGRAPHY: Typography = {
  uiFontSize: UI_FONT_SIZES.default,
  codeFontSize: CODE_FONT_SIZES.default,
  uiFontFamily: "",
  codeFontFamily: "",
};

export const ACCENT_PRESETS = [
  { id: "blue", dark: "#6db6d8", light: "#147ba5" },
  { id: "indigo", dark: "#8ea2f5", light: "#3d55c9" },
  { id: "violet", dark: "#a48bf0", light: "#6a45c9" },
  { id: "rose", dark: "#ee8fb0", light: "#b8386a" },
  { id: "orange", dark: "#eba26a", light: "#a8551a" },
  { id: "amber", dark: "#e0c070", light: "#8a641f" },
  { id: "green", dark: "#82cf98", light: "#287b46" },
  { id: "teal", dark: "#6cc9bd", light: "#137a70" },
] as const satisfies ReadonlyArray<{ id: string; dark: Hex; light: Hex }>;

const DARK_SHADOW = "0 18px 56px rgb(0 0 0 / 32%)";
const LIGHT_SHADOW = "0 18px 56px rgb(35 48 60 / 18%)";

/** Builds the full palette from seeds, then applies per-token overrides. */
export function derivePalette(base: ThemeBase, seeds: ThemeSeeds, overrides: Partial<Record<ThemeToken, Hex>> = {}): ThemePalette {
  const dark = base === "dark";
  const { canvas, surface, text, accent, success, warning, danger } = seeds;
  const derived: Record<ThemeToken, Hex> = {
    canvas,
    surface,
    surfaceRaised: dark ? mix(surface, text, 0.05) : mix(surface, "#ffffff", 0.7),
    surfaceSoft: mix(canvas, surface, 0.5),
    line: mix(surface, text, 0.13),
    lineStrong: mix(surface, text, 0.21),
    text,
    // Light canvases need a heavier mix to keep muted metadata and placeholders at 4.5:1.
    textSecondary: mix(text, canvas, dark ? 0.3 : 0.26),
    textMuted: mix(text, canvas, dark ? 0.42 : 0.34),
    accent,
    accentStrong: mix(accent, dark ? "#ffffff" : "#000000", 0.16),
    onAccent: readableOn(accent),
    green: success,
    amber: warning,
    danger,
    gitModified: "#000000",
    gitAdded: success,
    gitDeleted: danger,
    gitRenamed: warning,
    gitUntracked: "#000000",
    gitConflicted: mix(warning, danger, 0.35),
    gitIgnored: "#000000",
  };
  const palette = { ...derived, ...overrides };
  // Tokens that follow other tokens use the overridden values, so pinning accent-strong also recolors modified files.
  palette.gitModified = overrides.gitModified ?? palette.accentStrong;
  palette.gitUntracked = overrides.gitUntracked ?? palette.textSecondary;
  palette.gitIgnored = overrides.gitIgnored ?? palette.textMuted;
  const softAlpha = dark ? 0.13 : 0.09;
  return {
    ...palette,
    accentSoft: withAlpha(palette.accent, softAlpha),
    greenSoft: withAlpha(palette.green, softAlpha),
    dangerSoft: withAlpha(palette.danger, softAlpha),
    shadow: dark ? DARK_SHADOW : LIGHT_SHADOW,
  };
}

// GitCrest Dark and Light reproduce tokens.css exactly; tokens.css stays the fallback before scripts run.
const GITCREST_DARK_PALETTE: ThemePalette = {
  canvas: "#171b21", surface: "#1d232b", surfaceRaised: "#232a33", surfaceSoft: "#20262e", line: "#333b46", lineStrong: "#424c59",
  text: "#e6eaf0", textSecondary: "#a4afbd", textMuted: "#8693a2",
  accent: "#6db6d8", accentStrong: "#81c8e8", onAccent: "#10232c",
  green: "#8fcba0", amber: "#d4b477", danger: "#d98787",
  gitModified: "#81c8e8", gitAdded: "#8fcba0", gitDeleted: "#d98787", gitRenamed: "#d4b477", gitUntracked: "#a4afbd", gitConflicted: "#e3a06f", gitIgnored: "#8693a2",
  accentSoft: "rgb(109 182 216 / 13%)", greenSoft: "rgb(95 172 117 / 12%)", dangerSoft: "rgb(217 135 135 / 12%)", shadow: DARK_SHADOW,
};

const GITCREST_LIGHT_PALETTE: ThemePalette = {
  canvas: "#f1f3f5", surface: "#fafbfc", surfaceRaised: "#ffffff", surfaceSoft: "#f4f6f8", line: "#dfe4e9", lineStrong: "#cbd3dc",
  text: "#1d2732", textSecondary: "#505c6a", textMuted: "#646f7d",
  accent: "#147ba5", accentStrong: "#086d98", onAccent: "#ffffff",
  green: "#287b46", amber: "#8a641f", danger: "#ab4d4d",
  gitModified: "#086d98", gitAdded: "#287b46", gitDeleted: "#ab4d4d", gitRenamed: "#8a641f", gitUntracked: "#505c6a", gitConflicted: "#a8561a", gitIgnored: "#646f7d",
  accentSoft: "rgb(20 123 165 / 9%)", greenSoft: "rgb(57 148 82 / 9%)", dangerSoft: "rgb(171 77 77 / 9%)", shadow: LIGHT_SHADOW,
};

function builtIn(id: string, name: string, nameKey: MessageKey, base: ThemeBase, seeds: ThemeSeeds, palette?: ThemePalette): ThemeDefinition {
  return { id, name, nameKey, base, seeds, overrides: {}, builtIn: true, palette: palette ?? derivePalette(base, seeds) };
}

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  builtIn("gitcrest-dark", "GitCrest Dark", "theme.builtIn.gitcrestDark", "dark", {
    canvas: "#171b21", surface: "#1d232b", text: "#e6eaf0", accent: "#6db6d8", success: "#8fcba0", warning: "#d4b477", danger: "#d98787",
  }, GITCREST_DARK_PALETTE),
  builtIn("gitcrest-light", "GitCrest Light", "theme.builtIn.gitcrestLight", "light", {
    canvas: "#f1f3f5", surface: "#fafbfc", text: "#1d2732", accent: "#147ba5", success: "#287b46", warning: "#8a641f", danger: "#ab4d4d",
  }, GITCREST_LIGHT_PALETTE),
  builtIn("midnight", "Midnight", "theme.builtIn.midnight", "dark", {
    canvas: "#0f1117", surface: "#151924", text: "#e4e6f0", accent: "#a48bf0", success: "#7fcf9a", warning: "#e0b86a", danger: "#e48a8a",
  }),
  builtIn("paper", "Paper", "theme.builtIn.paper", "light", {
    canvas: "#f4f1ea", surface: "#fbf9f4", text: "#2a2620", accent: "#2f7d5b", success: "#2f7d4a", warning: "#8c6418", danger: "#b04a3f",
  }),
];

export const DEFAULT_THEME_ID: Record<ThemeBase, string> = { dark: "gitcrest-dark", light: "gitcrest-light" };

export function resolveCustomTheme(theme: CustomTheme): ThemeDefinition {
  return { ...theme, builtIn: false, palette: derivePalette(theme.base, theme.seeds, theme.overrides) };
}

function clampInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function sanitizeFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  // Keep it a plain font list: no declarations, blocks or markup can ride along into the style attribute.
  return value.replace(/[;{}<>\\]/g, "").trim().slice(0, FONT_FAMILY_MAX_LENGTH);
}

export function sanitizeThemeName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, THEME_NAME_MAX_LENGTH) : "";
}

export function parseTypography(value: unknown): Typography {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    uiFontSize: clampInteger(source.uiFontSize, UI_FONT_SIZES.min, UI_FONT_SIZES.max) ?? DEFAULT_TYPOGRAPHY.uiFontSize,
    codeFontSize: clampInteger(source.codeFontSize, CODE_FONT_SIZES.min, CODE_FONT_SIZES.max) ?? DEFAULT_TYPOGRAPHY.codeFontSize,
    uiFontFamily: sanitizeFontFamily(source.uiFontFamily),
    codeFontFamily: sanitizeFontFamily(source.codeFontFamily),
  };
}

/** Accepts stored or imported data; returns undefined unless it has a name, a base and all seven seed colors. */
export function parseCustomTheme(value: unknown): CustomTheme | undefined {
  if (!value || typeof value !== "object") return undefined;
  const source = value as Record<string, unknown>;
  const name = sanitizeThemeName(source.name);
  const base = source.base === "light" || source.base === "dark" ? source.base : undefined;
  const id = typeof source.id === "string" && /^custom-[a-z0-9-]{1,40}$/.test(source.id) ? source.id : undefined;
  const rawSeeds = source.seeds && typeof source.seeds === "object" ? source.seeds as Record<string, unknown> : {};
  const seeds = Object.fromEntries(THEME_SEEDS.map((seed) => [seed, normalizeHex(rawSeeds[seed])]));
  if (!name || !base || !id || THEME_SEEDS.some((seed) => !seeds[seed])) return undefined;
  const rawOverrides = source.overrides && typeof source.overrides === "object" ? source.overrides as Record<string, unknown> : {};
  const overrides: Partial<Record<ThemeToken, Hex>> = {};
  for (const token of ADVANCED_TOKENS) {
    const color = normalizeHex(rawOverrides[token]);
    if (color) overrides[token] = color;
  }
  const rawTypography = source.typography && typeof source.typography === "object" ? source.typography as Record<string, unknown> : undefined;
  const typography: ThemeTypographyOverride = {};
  const uiFontSize = clampInteger(rawTypography?.uiFontSize, UI_FONT_SIZES.min, UI_FONT_SIZES.max);
  const codeFontSize = clampInteger(rawTypography?.codeFontSize, CODE_FONT_SIZES.min, CODE_FONT_SIZES.max);
  if (uiFontSize !== undefined) typography.uiFontSize = uiFontSize;
  if (codeFontSize !== undefined) typography.codeFontSize = codeFontSize;
  return {
    id,
    name,
    base,
    seeds: seeds as ThemeSeeds,
    overrides,
    ...(Object.keys(typography).length ? { typography } : {}),
  };
}

export function newCustomThemeId(): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `custom-${Date.now().toString(36)}-${random}`;
}

/** Returns `name`, or `name 2`, `name 3`… when another theme already uses it. */
export function uniqueThemeName(name: string, taken: readonly string[]): string {
  const base = sanitizeThemeName(name) || "Custom theme";
  const used = new Set(taken.map((value) => value.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base.slice(0, THEME_NAME_MAX_LENGTH - String(suffix).length - 1)} ${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

export type ContrastCheckId = "textOnCanvas" | "textOnSurface" | "mutedOnSurface" | "onAccent" | "accentOnSurface";

export interface ContrastCheck {
  id: ContrastCheckId;
  ratio: number;
  minimum: number;
  passes: boolean;
}

export function contrastChecks(palette: ThemePalette): ContrastCheck[] {
  const pairs: Array<[ContrastCheckId, Hex, Hex, number]> = [
    ["textOnCanvas", palette.text, palette.canvas, 4.5],
    ["textOnSurface", palette.text, palette.surface, 4.5],
    ["mutedOnSurface", palette.textMuted, palette.surface, 3],
    ["onAccent", palette.onAccent, palette.accent, 4.5],
    ["accentOnSurface", palette.accent, palette.surface, 3],
  ];
  return pairs.map(([id, foreground, background, minimum]) => {
    const ratio = contrastRatio(foreground, background);
    return { id, ratio, minimum, passes: ratio >= minimum };
  });
}

function kebab(token: string): string {
  return token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** CSS custom properties for a palette, keyed by property name (`--surface-raised`). */
export function paletteVariables(palette: ThemePalette): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const token of THEME_TOKENS) variables[`--${kebab(token)}`] = palette[token];
  variables["--accent-soft"] = palette.accentSoft;
  variables["--green-soft"] = palette.greenSoft;
  variables["--danger-soft"] = palette.dangerSoft;
  variables["--shadow"] = palette.shadow;
  return variables;
}
