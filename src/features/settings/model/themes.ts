import type { MessageKey } from "../../../shared/i18n";
import { contrastRatio, ensureContrast, mix, normalizeHex, readableOn, rotateHue, withAlpha, withHue, type Hex } from "./color";

export type ThemeBase = "light" | "dark";

/** Palette tokens a theme can set, in the order the advanced editor lists them. Each maps to `--<kebab-case>` in tokens.css. */
export const THEME_TOKENS = [
  "canvas", "surface", "surfaceRaised", "surfaceSoft", "line", "lineStrong",
  "text", "textSecondary", "textMuted",
  "accent", "accentStrong", "onAccent",
  "green", "amber", "danger",
  "gitModified", "gitAdded", "gitDeleted", "gitRenamed", "gitUntracked", "gitConflicted", "gitIgnored",
  "syntaxComment", "syntaxKeyword", "syntaxString", "syntaxNumber", "syntaxType", "syntaxTag",
  "graphLane1", "graphLane2", "graphLane3", "graphLane4", "graphLane5", "graphLane6",
] as const;
export type ThemeToken = typeof THEME_TOKENS[number];

/** Tokens derived from the seeds; the advanced editor can pin any of them. */
export const ADVANCED_TOKENS = [
  "surfaceRaised", "surfaceSoft", "line", "lineStrong", "textSecondary", "textMuted", "accentStrong", "onAccent",
  "gitModified", "gitAdded", "gitDeleted", "gitRenamed", "gitUntracked", "gitConflicted", "gitIgnored",
  "syntaxComment", "syntaxKeyword", "syntaxString", "syntaxNumber", "syntaxType", "syntaxTag",
  "graphLane1", "graphLane2", "graphLane3", "graphLane4", "graphLane5", "graphLane6",
] as const satisfies readonly ThemeToken[];
export type AdvancedThemeToken = typeof ADVANCED_TOKENS[number];

/** How the advanced editor groups the pinnable tokens. */
export const TOKEN_GROUPS = [
  { id: "interface", tokens: ["surfaceRaised", "surfaceSoft", "line", "lineStrong", "textSecondary", "textMuted", "accentStrong", "onAccent"] },
  { id: "git", tokens: ["gitModified", "gitAdded", "gitDeleted", "gitRenamed", "gitUntracked", "gitConflicted", "gitIgnored"] },
  { id: "syntax", tokens: ["syntaxComment", "syntaxKeyword", "syntaxString", "syntaxNumber", "syntaxType", "syntaxTag"] },
  { id: "graph", tokens: ["graphLane1", "graphLane2", "graphLane3", "graphLane4", "graphLane5", "graphLane6"] },
] as const satisfies ReadonlyArray<{ id: string; tokens: readonly AdvancedThemeToken[] }>;

export const SYNTAX_TOKENS = TOKEN_GROUPS[2].tokens;
export const GRAPH_LANE_TOKENS = TOKEN_GROUPS[3].tokens;

/** The seven colors the basic editor asks for; every other token is derived from them. */
export const THEME_SEEDS = ["canvas", "surface", "text", "accent", "success", "warning", "danger"] as const;
export type ThemeSeed = typeof THEME_SEEDS[number];
export type ThemeSeeds = Record<ThemeSeed, Hex>;

export type ThemePalette = Record<ThemeToken, Hex> & {
  accentSoft: string;
  greenSoft: string;
  dangerSoft: string;
};

export interface ThemeTypographyOverride {
  uiFontSize?: number;
  codeFontSize?: number;
}

/** Shape and spacing choices that sit beside the colors: corner rounding, row density, overlay shadows, graph coloring. */
export const STYLE_OPTIONS = {
  radius: ["square", "tight", "default", "round"],
  density: ["compact", "default", "comfortable"],
  shadow: ["none", "subtle", "default", "strong"],
  graphColors: ["accent", "lanes"],
} as const;
export type StyleField = keyof typeof STYLE_OPTIONS;
export const STYLE_FIELDS = Object.keys(STYLE_OPTIONS) as StyleField[];
export type ThemeStyle = { [Field in StyleField]: typeof STYLE_OPTIONS[Field][number] };
export type Density = ThemeStyle["density"];

export const DEFAULT_STYLE: ThemeStyle = { radius: "default", density: "default", shadow: "default", graphColors: "lanes" };

/** Multiplies every corner radius; `default` keeps the 2–12px scale in tokens.css. */
export const RADIUS_SCALE: Record<ThemeStyle["radius"], number> = { square: 0, tight: 0.5, default: 1, round: 1.75 };
/** Multiplies list row heights. The commit graph has its own row heights so it can lay rows out without measuring them. */
export const DENSITY_SCALE: Record<Density, number> = { compact: 0.86, default: 1, comfortable: 1.15 };
export const GRAPH_ROW_HEIGHT: Record<Density, number> = { compact: 42, default: 52, comfortable: 60 };

const SHADOWS: Record<ThemeBase, Record<ThemeStyle["shadow"], string>> = {
  dark: {
    none: "none",
    subtle: "0 6px 20px rgb(0 0 0 / 22%)",
    default: "0 18px 56px rgb(0 0 0 / 32%)",
    strong: "0 24px 72px rgb(0 0 0 / 50%)",
  },
  light: {
    none: "none",
    subtle: "0 6px 20px rgb(35 48 60 / 10%)",
    default: "0 18px 56px rgb(35 48 60 / 18%)",
    strong: "0 24px 72px rgb(35 48 60 / 30%)",
  },
};

export function shadowFor(base: ThemeBase, strength: ThemeStyle["shadow"]): string {
  return SHADOWS[base][strength];
}

export interface CustomTheme {
  id: string;
  name: string;
  base: ThemeBase;
  seeds: ThemeSeeds;
  overrides: Partial<Record<ThemeToken, Hex>>;
  typography?: ThemeTypographyOverride;
  /** Style choices this theme makes for itself; the rest follow the global style. */
  style?: Partial<ThemeStyle>;
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

const LANE_HUE_STEPS = [0, 120, 240, 60, 180, 300] as const;

type FollowerToken =Extract<ThemeToken, "gitModified" | "gitUntracked" | "gitIgnored" | `syntax${string}` | `graphLane${string}`>;

/** Builds the full palette from seeds, then applies per-token overrides. */
export function derivePalette(base: ThemeBase, seeds: ThemeSeeds, overrides: Partial<Record<ThemeToken, Hex>> = {}): ThemePalette {
  const dark = base === "dark";
  const { canvas, surface, text, accent, success, warning, danger } = seeds;
  const derived: Record<Exclude<ThemeToken, FollowerToken>, Hex> = {
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
    gitAdded: success,
    gitDeleted: danger,
    gitRenamed: warning,
    gitConflicted: mix(warning, danger, 0.35),
  };
  const palette = { ...derived, ...overrides } as Record<ThemeToken, Hex>;
  // Syntax and lane colors borrow the accent's weight, so they sit at the same brightness as the rest of the theme.
  // Keywords and types get fixed hues (violet, teal) that stay apart from the success, warning and danger colors.
  const readable = (color: Hex) => ensureContrast(color, palette.surface, 4.5);
  const visible = (color: Hex) => ensureContrast(color, palette.canvas, 3);
  // Neighboring lanes sit at least 120° apart; together the six cover the color wheel from the accent onward.
  const lane = (step: number) => visible(rotateHue(palette.accent, LANE_HUE_STEPS[step], 0.45));
  // Tokens that follow other tokens use the overridden values, so pinning accent-strong also recolors modified files.
  const followers: Record<FollowerToken, Hex> = {
    gitModified: palette.accentStrong,
    gitUntracked: palette.textSecondary,
    gitIgnored: palette.textMuted,
    syntaxComment: palette.textMuted,
    syntaxKeyword: readable(withHue(palette.accent, 285, 0.45)),
    syntaxString: readable(palette.green),
    syntaxNumber: readable(palette.amber),
    syntaxType: readable(withHue(palette.accent, 178, 0.45)),
    syntaxTag: readable(mix(palette.danger, palette.amber, 0.4)),
    graphLane1: visible(palette.accent),
    graphLane2: lane(1),
    graphLane3: lane(2),
    graphLane4: lane(3),
    graphLane5: lane(4),
    graphLane6: lane(5),
  };
  for (const token of Object.keys(followers) as FollowerToken[]) palette[token] = overrides[token] ?? followers[token];
  const softAlpha = dark ? 0.13 : 0.09;
  return {
    ...palette,
    accentSoft: withAlpha(palette.accent, softAlpha),
    greenSoft: withAlpha(palette.green, softAlpha),
    dangerSoft: withAlpha(palette.danger, softAlpha),
  };
}

// GitCrest Dark and Light reproduce tokens.css exactly; tokens.css stays the fallback before scripts run.
const GITCREST_DARK_SEEDS: ThemeSeeds = {
  canvas: "#171b21", surface: "#1d232b", text: "#e6eaf0", accent: "#6db6d8", success: "#8fcba0", warning: "#d4b477", danger: "#d98787",
};
const GITCREST_DARK_PALETTE: ThemePalette = {
  ...derivePalette("dark", GITCREST_DARK_SEEDS, {
    surfaceRaised: "#232a33", surfaceSoft: "#20262e", line: "#333b46", lineStrong: "#424c59",
    textSecondary: "#a4afbd", textMuted: "#8693a2", accentStrong: "#81c8e8", onAccent: "#10232c",
    gitModified: "#81c8e8", gitAdded: "#8fcba0", gitDeleted: "#d98787", gitRenamed: "#d4b477", gitUntracked: "#a4afbd", gitConflicted: "#e3a06f", gitIgnored: "#8693a2",
  }),
  accentSoft: "rgb(109 182 216 / 13%)", greenSoft: "rgb(95 172 117 / 12%)", dangerSoft: "rgb(217 135 135 / 12%)",
};

const GITCREST_LIGHT_SEEDS: ThemeSeeds = {
  canvas: "#f1f3f5", surface: "#fafbfc", text: "#1d2732", accent: "#147ba5", success: "#287b46", warning: "#8a641f", danger: "#ab4d4d",
};
const GITCREST_LIGHT_PALETTE: ThemePalette = {
  ...derivePalette("light", GITCREST_LIGHT_SEEDS, {
    surfaceRaised: "#ffffff", surfaceSoft: "#f4f6f8", line: "#dfe4e9", lineStrong: "#cbd3dc",
    textSecondary: "#505c6a", textMuted: "#646f7d", accentStrong: "#086d98", onAccent: "#ffffff",
    gitModified: "#086d98", gitAdded: "#287b46", gitDeleted: "#ab4d4d", gitRenamed: "#8a641f", gitUntracked: "#505c6a", gitConflicted: "#a8561a", gitIgnored: "#646f7d",
  }),
  accentSoft: "rgb(20 123 165 / 9%)", greenSoft: "rgb(57 148 82 / 9%)", dangerSoft: "rgb(171 77 77 / 9%)",
};

function builtIn(
  id: string,
  name: string,
  nameKey: MessageKey,
  base: ThemeBase,
  seeds: ThemeSeeds,
  { palette, overrides = {} }: { palette?: ThemePalette; overrides?: Partial<Record<ThemeToken, Hex>> } = {},
): ThemeDefinition {
  return { id, name, nameKey, base, seeds, overrides, builtIn: true, palette: palette ?? derivePalette(base, seeds, overrides) };
}

export const BUILT_IN_THEMES: readonly ThemeDefinition[] = [
  builtIn("gitcrest-dark", "GitCrest Dark", "theme.builtIn.gitcrestDark", "dark", GITCREST_DARK_SEEDS, { palette: GITCREST_DARK_PALETTE }),
  builtIn("gitcrest-light", "GitCrest Light", "theme.builtIn.gitcrestLight", "light", GITCREST_LIGHT_SEEDS, { palette: GITCREST_LIGHT_PALETTE }),
  builtIn("midnight", "Midnight", "theme.builtIn.midnight", "dark", {
    canvas: "#0f1117", surface: "#151924", text: "#e4e6f0", accent: "#a48bf0", success: "#7fcf9a", warning: "#e0b86a", danger: "#e48a8a",
  }),
  builtIn("graphite", "Graphite", "theme.builtIn.graphite", "dark", {
    canvas: "#161616", surface: "#1d1d1d", text: "#e8e8e8", accent: "#8ab4f8", success: "#81c995", warning: "#e6c06e", danger: "#f28b82",
  }),
  builtIn("fjord", "Fjord", "theme.builtIn.fjord", "dark", {
    canvas: "#252b36", surface: "#2b323e", text: "#e8ecf2", accent: "#88c0d0", success: "#a3be8c", warning: "#ebcb8b", danger: "#e0959b",
  }),
  builtIn("ember", "Ember", "theme.builtIn.ember", "dark", {
    canvas: "#1b1613", surface: "#221c18", text: "#efe6dd", accent: "#e8a065", success: "#a6c98d", warning: "#e3c06e", danger: "#e8877c",
  }),
  builtIn("contrast-dark", "High Contrast Dark", "theme.builtIn.contrastDark", "dark", {
    canvas: "#000000", surface: "#0b0b0b", text: "#ffffff", accent: "#5cc8ff", success: "#6fe38a", warning: "#ffd25e", danger: "#ff8080",
  }, { overrides: { line: "#6b6b6b", lineStrong: "#9a9a9a", textSecondary: "#e0e0e0", textMuted: "#c4c4c4" } }),
  builtIn("paper", "Paper", "theme.builtIn.paper", "light", {
    canvas: "#f4f1ea", surface: "#fbf9f4", text: "#2a2620", accent: "#2f7d5b", success: "#2f7d4a", warning: "#8c6418", danger: "#b04a3f",
  }),
  builtIn("mist", "Mist", "theme.builtIn.mist", "light", {
    canvas: "#edf1f6", surface: "#f8fafc", text: "#18222f", accent: "#4a55c8", success: "#24753f", warning: "#875f12", danger: "#b03a3a",
  }),
  builtIn("contrast-light", "High Contrast Light", "theme.builtIn.contrastLight", "light", {
    canvas: "#f0f0f0", surface: "#ffffff", text: "#000000", accent: "#0050b3", success: "#0f6a2a", warning: "#6b4500", danger: "#a40e26",
  }, { overrides: { line: "#8a8a8a", lineStrong: "#4d4d4d", textSecondary: "#1f1f1f", textMuted: "#3d3d3d" } }),
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

/** Keeps only known style fields with known values. */
export function parseStyleOverride(value: unknown): Partial<ThemeStyle> {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const style: Partial<Record<StyleField, string>> = {};
  for (const field of STYLE_FIELDS) {
    const choice = source[field];
    if ((STYLE_OPTIONS[field] as readonly unknown[]).includes(choice)) style[field] = choice as string;
  }
  return style as Partial<ThemeStyle>;
}

export function parseStyle(value: unknown): ThemeStyle {
  return { ...DEFAULT_STYLE, ...parseStyleOverride(value) };
}

/** Accepts stored data; returns undefined unless it has a name, a base and all seven seed colors. */
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
  const style = parseStyleOverride(source.style);
  return {
    id,
    name,
    base,
    seeds: seeds as ThemeSeeds,
    overrides,
    ...(Object.keys(typography).length ? { typography } : {}),
    ...(Object.keys(style).length ? { style } : {}),
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

export type ContrastCheckId = "textOnCanvas" | "textOnSurface" | "mutedOnSurface" | "onAccent" | "accentOnSurface" | "syntaxOnSurface" | "lanesOnCanvas";

export interface ContrastCheck {
  id: ContrastCheckId;
  ratio: number;
  minimum: number;
  passes: boolean;
}

const READABLE_SYNTAX_TOKENS = SYNTAX_TOKENS.filter((token) => token !== "syntaxComment");

export function contrastChecks(palette: ThemePalette): ContrastCheck[] {
  const lowest = (tokens: readonly ThemeToken[], background: Hex) => Math.min(...tokens.map((token) => contrastRatio(palette[token], background)));
  const pairs: Array<[ContrastCheckId, number, number]> = [
    ["textOnCanvas", contrastRatio(palette.text, palette.canvas), 4.5],
    ["textOnSurface", contrastRatio(palette.text, palette.surface), 4.5],
    ["mutedOnSurface", contrastRatio(palette.textMuted, palette.surface), 3],
    ["onAccent", contrastRatio(palette.onAccent, palette.accent), 4.5],
    ["accentOnSurface", contrastRatio(palette.accent, palette.surface), 3],
    // Comments are meant to recede, so only the colors that carry code are held to body-text contrast.
    ["syntaxOnSurface", lowest(READABLE_SYNTAX_TOKENS, palette.surface), 4.5],
    ["lanesOnCanvas", lowest(GRAPH_LANE_TOKENS, palette.canvas), 3],
  ];
  return pairs.map(([id, ratio, minimum]) => ({ id, ratio, minimum, passes: ratio >= minimum }));
}

/**
 * Returns `theme` with the fewest color changes that make every readability check pass:
 * seeds move only when no override can fix the pair, and colors that already pass are left alone.
 */
export function fixContrast(theme: CustomTheme): CustomTheme {
  const { canvas, surface } = theme.seeds;
  // Fix text against the background it reads worse on first, then make sure the other one still passes.
  const [weaker, stronger] = contrastRatio(theme.seeds.text, canvas) < contrastRatio(theme.seeds.text, surface) ? [canvas, surface] : [surface, canvas];
  const text = ensureContrast(ensureContrast(theme.seeds.text, weaker, 4.5), stronger, 4.5);
  const accent = ensureContrast(theme.seeds.accent, surface, 3);
  const seeds: ThemeSeeds = { ...theme.seeds, text, accent };
  const overrides = { ...theme.overrides };
  let palette = derivePalette(theme.base, seeds, overrides);
  if (contrastRatio(palette.onAccent, palette.accent) < 4.5) overrides.onAccent = readableOn(palette.accent);
  if (contrastRatio(palette.textMuted, palette.surface) < 3) overrides.textMuted = ensureContrast(palette.textMuted, palette.surface, 4.5);
  for (const token of READABLE_SYNTAX_TOKENS) {
    if (contrastRatio(palette[token], palette.surface) < 4.5) overrides[token] = ensureContrast(palette[token], palette.surface, 4.5);
  }
  for (const token of GRAPH_LANE_TOKENS) {
    if (contrastRatio(palette[token], palette.canvas) < 3) overrides[token] = ensureContrast(palette[token], palette.canvas, 3);
  }
  palette = derivePalette(theme.base, seeds, overrides);
  // A mid-tone accent can sit between both inks; darken or lighten it until its button text reads.
  if (contrastRatio(palette.onAccent, palette.accent) < 4.5) seeds.accent = ensureContrast(palette.accent, palette.onAccent, 4.5);
  return { ...theme, seeds, overrides };
}

function kebab(token: string): string {
  return token.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/(\D)(\d)/g, "$1-$2");
}

/** CSS custom properties for a palette, keyed by property name (`--surface-raised`, `--graph-lane-1`). */
export function paletteVariables(palette: ThemePalette): Record<string, string> {
  const variables: Record<string, string> = {};
  for (const token of THEME_TOKENS) variables[`--${kebab(token)}`] = palette[token];
  variables["--accent-soft"] = palette.accentSoft;
  variables["--green-soft"] = palette.greenSoft;
  variables["--danger-soft"] = palette.dangerSoft;
  return variables;
}
