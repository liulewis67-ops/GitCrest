import {
  BUILT_IN_THEMES,
  DEFAULT_STYLE,
  DEFAULT_THEME_ID,
  DEFAULT_TYPOGRAPHY,
  DENSITY_SCALE,
  paletteVariables,
  parseCustomTheme,
  parseStyle,
  parseTypography,
  RADIUS_SCALE,
  resolveCustomTheme,
  shadowFor,
  type CustomTheme,
  type ThemeBase,
  type ThemeDefinition,
  type ThemeStyle,
  type Typography,
} from "./themes";

export const THEME_MODES = ["system", "light", "dark"] as const;
export type ThemeMode = typeof THEME_MODES[number];
/** `system` follows the OS reduce-motion setting; the other two override it. */
export const MOTION_PREFERENCES = ["system", "reduced", "full"] as const;
export type MotionPreference = typeof MOTION_PREFERENCES[number];

export interface AppearancePreferences {
  version: 1;
  mode: ThemeMode;
  lightThemeId: string;
  darkThemeId: string;
  customThemes: CustomTheme[];
  typography: Typography;
  style: ThemeStyle;
  motion: MotionPreference;
}

export interface AppearanceSnapshot {
  preferences: AppearancePreferences;
  themes: readonly ThemeDefinition[];
  /** The custom theme being edited; while set it is shown instead of the saved choice. */
  draft?: CustomTheme;
  resolvedBase: ThemeBase;
  activeTheme: ThemeDefinition;
  /** Global sizes with the active theme's own size overrides applied. */
  typography: Typography;
  /** Global style with the active theme's own style choices applied. */
  style: ThemeStyle;
}

export const APPEARANCE_STORAGE_KEY = "gitcrest-appearance-v1";
const LEGACY_THEME_KEY = "gitcrest-theme";

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 1,
  mode: "system",
  lightThemeId: DEFAULT_THEME_ID.light,
  darkThemeId: DEFAULT_THEME_ID.dark,
  customThemes: [],
  typography: DEFAULT_TYPOGRAPHY,
  style: DEFAULT_STYLE,
  motion: "system",
};

const DEFAULT_UI_FONT = `Inter, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", ui-sans-serif, system-ui, sans-serif`;
const DEFAULT_CODE_FONT = `"JetBrains Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, ui-monospace, monospace`;
const BASE_UI_FONT_SIZE = 13;

/** The font-family list for code, with the user's font (if any) in front of the default stack. */
export function codeFontStack(typography: Typography): string {
  return typography.codeFontFamily ? `${typography.codeFontFamily}, ${DEFAULT_CODE_FONT}` : DEFAULT_CODE_FONT;
}

function themeList(customThemes: readonly CustomTheme[]): ThemeDefinition[] {
  return [...BUILT_IN_THEMES, ...customThemes.map(resolveCustomTheme)];
}

/** Keeps a slot only when it names an existing theme of the slot's base. */
function validSlot(id: unknown, base: ThemeBase, themes: readonly ThemeDefinition[]): string {
  return typeof id === "string" && themes.some((theme) => theme.id === id && theme.base === base) ? id : DEFAULT_THEME_ID[base];
}

export function parseAppearance(stored: string | null, legacyMode: string | null = null): AppearancePreferences {
  let source: Record<string, unknown> = {};
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) source = parsed as Record<string, unknown>;
    } catch {
      // Unreadable data falls back to defaults below.
    }
  }
  const customThemes: CustomTheme[] = [];
  for (const candidate of Array.isArray(source.customThemes) ? source.customThemes : []) {
    const theme = parseCustomTheme(candidate);
    if (theme && !customThemes.some((existing) => existing.id === theme.id)) customThemes.push(theme);
  }
  const themes = themeList(customThemes);
  const storedMode = stored ? source.mode : legacyMode;
  return {
    version: 1,
    mode: THEME_MODES.includes(storedMode as ThemeMode) ? storedMode as ThemeMode : "system",
    lightThemeId: validSlot(source.lightThemeId, "light", themes),
    darkThemeId: validSlot(source.darkThemeId, "dark", themes),
    customThemes,
    typography: parseTypography(source.typography),
    style: parseStyle(source.style),
    motion: MOTION_PREFERENCES.includes(source.motion as MotionPreference) ? source.motion as MotionPreference : "system",
  };
}

function readStorage(key: string): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function loadPreferences(): AppearancePreferences {
  const stored = readStorage(APPEARANCE_STORAGE_KEY);
  return parseAppearance(stored, stored ? null : readStorage(LEGACY_THEME_KEY));
}

const systemThemeQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: light)")
  : undefined;

let preferences = loadPreferences();
let draft: CustomTheme | undefined;
let snapshot = buildSnapshot();
let started = false;
const listeners = new Set<() => void>();

function buildSnapshot(): AppearanceSnapshot {
  const themes = themeList(preferences.customThemes);
  let activeTheme: ThemeDefinition;
  if (draft) {
    activeTheme = resolveCustomTheme(draft);
  } else {
    const base: ThemeBase = preferences.mode === "system" ? (systemThemeQuery?.matches ? "light" : "dark") : preferences.mode;
    const id = base === "light" ? preferences.lightThemeId : preferences.darkThemeId;
    activeTheme = themes.find((theme) => theme.id === id && theme.base === base)
      ?? themes.find((theme) => theme.id === DEFAULT_THEME_ID[base])!;
  }
  return {
    preferences,
    themes,
    draft,
    resolvedBase: activeTheme.base,
    activeTheme,
    typography: { ...preferences.typography, ...activeTheme.typography },
    style: { ...preferences.style, ...activeTheme.style },
  };
}

function applyToDocument() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const { activeTheme, typography, style } = snapshot;
  root.dataset.theme = activeTheme.base;
  root.dataset.themeId = activeTheme.id;
  root.dataset.density = style.density;
  root.dataset.graphColors = style.graphColors;
  root.dataset.motion = preferences.motion;
  for (const [name, value] of Object.entries(paletteVariables(activeTheme.palette))) root.style.setProperty(name, value);
  root.style.setProperty("--shadow", shadowFor(activeTheme.base, style.shadow));
  root.style.setProperty("--radius-scale", String(RADIUS_SCALE[style.radius]));
  root.style.setProperty("--density", String(DENSITY_SCALE[style.density]));
  root.style.setProperty("--font-scale", String(typography.uiFontSize / BASE_UI_FONT_SIZE));
  root.style.setProperty("--code-size", `${typography.codeFontSize}px`);
  root.style.setProperty("--code-leading", `${Math.round(typography.codeFontSize * 1.54)}px`);
  root.style.setProperty("--font-ui", typography.uiFontFamily ? `${typography.uiFontFamily}, ${DEFAULT_UI_FONT}` : DEFAULT_UI_FONT);
  root.style.setProperty("--font-mono", codeFontStack(typography));
}

function publish() {
  snapshot = buildSnapshot();
  applyToDocument();
  listeners.forEach((listener) => listener());
}

function commit(next: AppearancePreferences) {
  preferences = next;
  try {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // The appearance stays applied for this session when storage is unavailable.
  }
  publish();
}

/** Applies the saved appearance and follows OS and other-window changes. Safe to call more than once. */
export function startAppearance() {
  if (started) return;
  started = true;
  applyToDocument();
  systemThemeQuery?.addEventListener("change", () => {
    if (preferences.mode === "system") publish();
  });
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    // Diff and Conflict windows pick up changes made in the main window, and vice versa.
    window.addEventListener("storage", (event) => {
      if (event.key === APPEARANCE_STORAGE_KEY) reloadAppearance();
    });
  }
}

/** Re-reads saved preferences, dropping any unsaved draft. */
export function reloadAppearance() {
  preferences = loadPreferences();
  draft = undefined;
  publish();
}

export function getAppearance(): AppearanceSnapshot {
  return snapshot;
}

export function subscribeAppearance(listener: () => void) {
  startAppearance();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setThemeMode(mode: ThemeMode) {
  if (mode !== preferences.mode) commit({ ...preferences, mode });
}

export function cycleThemeMode() {
  setThemeMode(THEME_MODES[(THEME_MODES.indexOf(preferences.mode) + 1) % THEME_MODES.length]);
}

function withSelectedTheme(next: AppearancePreferences, theme: { id: string; base: ThemeBase }): AppearancePreferences {
  return {
    ...next,
    mode: next.mode === "system" ? "system" : theme.base,
    ...(theme.base === "light" ? { lightThemeId: theme.id } : { darkThemeId: theme.id }),
  };
}

/** Puts a theme in the slot for its base; a fixed mode of the other base switches so the choice is visible. */
export function selectTheme(id: string) {
  const theme = snapshot.themes.find((candidate) => candidate.id === id);
  if (theme) commit(withSelectedTheme(preferences, theme));
}

function withValidSlots(next: AppearancePreferences): AppearancePreferences {
  const themes = themeList(next.customThemes);
  return { ...next, lightThemeId: validSlot(next.lightThemeId, "light", themes), darkThemeId: validSlot(next.darkThemeId, "dark", themes) };
}

/** Adds or replaces a custom theme, drops the draft, and shows the saved theme. */
export function saveCustomTheme(theme: CustomTheme) {
  const parsed = parseCustomTheme(theme);
  if (!parsed) return;
  const exists = preferences.customThemes.some((candidate) => candidate.id === parsed.id);
  const customThemes = exists
    ? preferences.customThemes.map((candidate) => candidate.id === parsed.id ? parsed : candidate)
    : [...preferences.customThemes, parsed];
  draft = undefined;
  commit(withSelectedTheme(withValidSlots({ ...preferences, customThemes }), parsed));
}

export function deleteCustomTheme(id: string) {
  if (draft?.id === id) draft = undefined;
  commit(withValidSlots({ ...preferences, customThemes: preferences.customThemes.filter((theme) => theme.id !== id) }));
}

export function setTypography(changes: Partial<Typography>) {
  commit({ ...preferences, typography: parseTypography({ ...preferences.typography, ...changes }) });
}

export function setStyle(changes: Partial<ThemeStyle>) {
  commit({ ...preferences, style: parseStyle({ ...preferences.style, ...changes }) });
}

export function setMotion(motion: MotionPreference) {
  if (motion !== preferences.motion) commit({ ...preferences, motion });
}

/** Shows `theme` live without saving it; pass undefined to go back to the saved appearance. */
export function previewTheme(theme: CustomTheme | undefined) {
  draft = theme;
  publish();
}

export function resetAppearance() {
  draft = undefined;
  commit({ ...DEFAULT_APPEARANCE, customThemes: preferences.customThemes });
}
