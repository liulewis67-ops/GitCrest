import { useSyncExternalStore } from "react";

export const NOTIFICATIONS_STORAGE_KEY = "gitcrest-task-notifications-v1";

const listeners = new Set<() => void>();
let current: boolean | undefined;

/** On unless the user switched it off. */
export function readNotificationsEnabled(value: string | null): boolean {
  return value !== "off";
}

export function getNotificationsEnabled(): boolean {
  if (current === undefined) {
    try {
      current = readNotificationsEnabled(window.localStorage.getItem(NOTIFICATIONS_STORAGE_KEY));
    } catch {
      current = true;
    }
  }
  return current;
}

export function setNotificationsEnabled(enabled: boolean) {
  current = enabled;
  try {
    window.localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // The choice still applies for this session when storage is unavailable.
  }
  for (const listener of listeners) listener();
}

/** For tests: forget the cached value so the next read comes from storage again. */
export function resetNotificationPreferenceCache() {
  current = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useNotificationsEnabled(): boolean {
  return useSyncExternalStore(subscribe, getNotificationsEnabled, getNotificationsEnabled);
}
