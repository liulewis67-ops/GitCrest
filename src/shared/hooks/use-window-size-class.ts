import { useSyncExternalStore } from "react";

/**
 * Desktop width classes. Wide windows dock the inspector beside the content; medium windows
 * float it over the content; narrow windows (down to the 960px window minimum) float the sidebar too.
 */
export type WindowSizeClass = "wide" | "medium" | "narrow";

const WIDE_QUERY = "(min-width: 1440px)";
const MEDIUM_QUERY = "(min-width: 1024px)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

function snapshot(): WindowSizeClass {
  // Without media queries (tests, previews) behave like a wide window.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return "wide";
  return matches(WIDE_QUERY) ? "wide" : matches(MEDIUM_QUERY) ? "medium" : "narrow";
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const queries = [window.matchMedia(WIDE_QUERY), window.matchMedia(MEDIUM_QUERY)];
  queries.forEach((query) => query.addEventListener?.("change", onChange));
  return () => queries.forEach((query) => query.removeEventListener?.("change", onChange));
}

export function useWindowSizeClass(): WindowSizeClass {
  return useSyncExternalStore(subscribe, snapshot, () => "wide");
}
