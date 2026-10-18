import { useSyncExternalStore } from "react";
import { en, type MessageKey } from "./en";
import { zh } from "./zh";

export type { MessageKey } from "./en";
export type Locale = "en" | "zh";

export const LOCALES: readonly Locale[] = ["en", "zh"];
export const LOCALE_STORAGE_KEY = "gitcrest-locale";

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, zh };
const listeners = new Set<() => void>();

/** Picks the first system language we support (Chinese or English); anything else, or nothing, means English. */
export function localeFromSystem(languages: ReadonlyArray<string | undefined>): Locale {
  for (const language of languages) {
    const tag = (language ?? "").toLowerCase();
    if (tag.startsWith("zh")) return "zh";
    if (tag.startsWith("en")) return "en";
  }
  return "en";
}

function detectLocale(): Locale {
  // Outside a renderer window (tests, Node tooling) stay on English instead of following the host locale.
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    // Fall through to the browser language when storage is unavailable.
  }
  return localeFromSystem(typeof navigator === "undefined" ? [] : [...(navigator.languages ?? []), navigator.language]);
}

let currentLocale: Locale = detectLocale();

function applyDocumentLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = currentLocale === "zh" ? "zh-CN" : "en";
}
applyDocumentLanguage();

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale) {
  if (locale === currentLocale) return;
  currentLocale = locale;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // The language stays selected for this session when storage is unavailable.
  }
  applyDocumentLanguage();
  listeners.forEach((listener) => listener());
}

export type TranslateParams = Record<string, string | number | null | undefined>;

export function translate(locale: Locale, key: MessageKey, params?: TranslateParams): string {
  const template = catalogs[locale][key] ?? en[key];
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name] ?? "") : match));
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  // Keep secondary windows (Diff, Conflict review) in step when the language changes elsewhere.
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCALE_STORAGE_KEY || (event.newValue !== "en" && event.newValue !== "zh") || event.newValue === currentLocale) return;
    currentLocale = event.newValue;
    applyDocumentLanguage();
    listeners.forEach((listener) => listener());
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useI18n() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return {
    locale,
    setLocale,
    t: (key: MessageKey, params?: TranslateParams) => translate(locale, key, params),
  };
}

/** Non-reactive translation for plain modules; components should prefer useI18n so they re-render on change. */
export function t(key: MessageKey, params?: TranslateParams): string {
  return translate(currentLocale, key, params);
}
