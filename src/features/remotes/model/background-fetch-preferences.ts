import { useSyncExternalStore } from "react";

export const FETCH_INTERVAL_MINUTES = [5, 10, 15, 30, 60] as const;
export const BACKGROUND_FETCH_STORAGE_KEY = "gitcrest-background-fetch-v1";

export interface BackgroundFetchPreferences {
  enabled: boolean;
  intervalMinutes: number;
  /** Repositories the user switched background fetch off for. */
  disabledRepositories: string[];
}

export const DEFAULT_BACKGROUND_FETCH: BackgroundFetchPreferences = {
  enabled: true,
  intervalMinutes: 10,
  disabledRepositories: [],
};

/** A saved value only counts when it has a known shape; anything else falls back to the default. */
export function readBackgroundFetchPreferences(value: string | null): BackgroundFetchPreferences {
  if (!value) return DEFAULT_BACKGROUND_FETCH;
  try {
    const saved = JSON.parse(value) as Partial<Record<keyof BackgroundFetchPreferences, unknown>>;
    return {
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : DEFAULT_BACKGROUND_FETCH.enabled,
      intervalMinutes: FETCH_INTERVAL_MINUTES.find((minutes) => minutes === saved.intervalMinutes) ?? DEFAULT_BACKGROUND_FETCH.intervalMinutes,
      disabledRepositories: Array.isArray(saved.disabledRepositories)
        ? saved.disabledRepositories.filter((id): id is string => typeof id === "string").slice(0, 500)
        : [],
    };
  } catch {
    return DEFAULT_BACKGROUND_FETCH;
  }
}

const listeners = new Set<() => void>();
let current: BackgroundFetchPreferences | undefined;

function load(): BackgroundFetchPreferences {
  if (!current) {
    try {
      current = readBackgroundFetchPreferences(window.localStorage.getItem(BACKGROUND_FETCH_STORAGE_KEY));
    } catch {
      current = DEFAULT_BACKGROUND_FETCH;
    }
  }
  return current;
}

export function getBackgroundFetchPreferences(): BackgroundFetchPreferences {
  return load();
}

export function updateBackgroundFetchPreferences(change: Partial<BackgroundFetchPreferences>) {
  const next = readBackgroundFetchPreferences(JSON.stringify({ ...load(), ...change }));
  current = next;
  try {
    window.localStorage.setItem(BACKGROUND_FETCH_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The choice still applies for this session when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

export function setRepositoryBackgroundFetch(repoId: string, enabled: boolean) {
  const others = load().disabledRepositories.filter((id) => id !== repoId);
  updateBackgroundFetchPreferences({ disabledRepositories: enabled ? others : [...others, repoId] });
}

/** For tests: forget the cached value so the next read comes from storage again. */
export function resetBackgroundFetchPreferencesCache() {
  current = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackgroundFetchPreferences(): BackgroundFetchPreferences {
  return useSyncExternalStore(subscribe, getBackgroundFetchPreferences, getBackgroundFetchPreferences);
}
