import { useSyncExternalStore } from "react";

export const HINTS_STORAGE_KEY = "gitcrest-hints-v1";

/** The first-use hints, each shown once until dismissed. */
export const HINT_IDS = ["changes", "shelves", "structure", "ai"] as const;
export type HintId = (typeof HINT_IDS)[number];

const listeners = new Set<() => void>();
let dismissed: ReadonlySet<string> | undefined;

/** A saved list only counts for hints that exist. */
export function readDismissedHints(value: string | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && (HINT_IDS as readonly string[]).includes(id)) : []);
  } catch {
    return new Set();
  }
}

function load(): ReadonlySet<string> {
  if (!dismissed) {
    try {
      dismissed = readDismissedHints(window.localStorage.getItem(HINTS_STORAGE_KEY));
    } catch {
      dismissed = new Set();
    }
  }
  return dismissed;
}

function save(next: Set<string>) {
  dismissed = next;
  try {
    window.localStorage.setItem(HINTS_STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // A hint then comes back next time, which is harmless.
  }
  for (const listener of listeners) listener();
}

export function dismissHint(id: HintId) {
  if (!load().has(id)) save(new Set([...load(), id]));
}

/** Brings every hint back, such as from Settings. */
export function resetHints() {
  save(new Set());
}

/** For tests: forget the cached value so the next read comes from storage again. */
export function resetHintsCache() {
  dismissed = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHintVisible(id: HintId): boolean {
  return useSyncExternalStore(subscribe, () => !load().has(id), () => true);
}

export function useAnyHintDismissed(): boolean {
  return useSyncExternalStore(subscribe, () => load().size > 0, () => false);
}
