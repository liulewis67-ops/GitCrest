import { useSyncExternalStore } from "react";
import { getGitCrestBridge } from "../../../api/bridge";
import { matchesShortcut, readShortcutPreferences, SHORTCUT_PREFERENCES_KEY } from "./shortcut-preferences";

/** The levels the interface can be zoomed to; the layout is checked to stay usable across this range. */
export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5] as const;
export const DEFAULT_ZOOM = 1;
export const ZOOM_STORAGE_KEY = "gitcrest-zoom-v1";

const listeners = new Set<() => void>();
let current: number = DEFAULT_ZOOM;

/** A saved value only counts when it is one of the supported levels. */
export function readZoom(value: string | null): number {
  const parsed = Number(value);
  return ZOOM_LEVELS.find((level) => level === parsed) ?? DEFAULT_ZOOM;
}

function apply(level: number) {
  const bridge = getGitCrestBridge();
  if (bridge?.setZoomFactor) bridge.setZoomFactor(level);
  else if (typeof document !== "undefined") document.documentElement.style.setProperty("zoom", String(level));
}

function store(level: number) {
  try {
    window.localStorage.setItem(ZOOM_STORAGE_KEY, String(level));
  } catch {
    // The level still applies for this session when storage is unavailable.
  }
}

function publish(level: number) {
  current = level;
  apply(level);
  for (const listener of listeners) listener();
}

export function getZoom(): number {
  return current;
}

export function setZoom(level: number) {
  const next = ZOOM_LEVELS.find((candidate) => candidate === level) ?? DEFAULT_ZOOM;
  store(next);
  publish(next);
}

function step(direction: 1 | -1) {
  const index = ZOOM_LEVELS.findIndex((level) => level === current);
  const next = ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index + direction))];
  setZoom(next);
}

export const zoomIn = () => step(1);
export const zoomOut = () => step(-1);
export const resetZoom = () => setZoom(DEFAULT_ZOOM);

/** Applies the saved level and follows changes made in another window. */
export function startZoom() {
  try {
    current = readZoom(window.localStorage.getItem(ZOOM_STORAGE_KEY));
  } catch {
    current = DEFAULT_ZOOM;
  }
  apply(current);
  const isMacPlatform = navigator.platform.toLowerCase().includes("mac");
  // Capture phase, so the zoom keys work from any focused control and the window's own zoom stays out.
  window.addEventListener("keydown", (event) => { if (!event.isComposing) handleZoomShortcut(event, isMacPlatform); }, true);
  window.addEventListener("storage", (event) => {
    if (event.key === ZOOM_STORAGE_KEY) publish(readZoom(event.newValue));
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useZoom() {
  return useSyncExternalStore(subscribe, getZoom, getZoom);
}

/**
 * Zoom shortcuts for a whole window, including text fields. They are handled here so the level is
 * kept and shared; the window's built-in zoom would change the view without remembering it.
 */
export function handleZoomShortcut(event: KeyboardEvent, isMacPlatform: boolean): boolean {
  let shortcuts;
  try {
    shortcuts = readShortcutPreferences(window.localStorage.getItem(SHORTCUT_PREFERENCES_KEY));
  } catch {
    shortcuts = readShortcutPreferences(null);
  }
  const action = matchesShortcut(event, shortcuts.zoomIn, isMacPlatform) ? zoomIn
    : matchesShortcut(event, shortcuts.zoomOut, isMacPlatform) ? zoomOut
      : matchesShortcut(event, shortcuts.zoomReset, isMacPlatform) ? resetZoom : undefined;
  if (!action) return false;
  event.preventDefault();
  action();
  return true;
}
