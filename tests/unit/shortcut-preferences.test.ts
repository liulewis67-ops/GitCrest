import { describe, expect, it } from "vitest";
import {
  defaultShortcutPreferences,
  ariaShortcut,
  displayShortcut,
  isValidBinding,
  matchesShortcut,
  readShortcutPreferences,
  shortcutConflict,
  shortcutFromEvent,
} from "../../src/features/settings/model/shortcut-preferences";

function keyEvent(key: string, init: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    ...init,
  } as KeyboardEvent;
}

describe("keyboard shortcut preferences", () => {
  it("recovers from missing, invalid, and conflicting stored values", () => {
    expect(readShortcutPreferences(null)).toEqual(defaultShortcutPreferences);
    expect(readShortcutPreferences("{")).toEqual(defaultShortcutPreferences);
    expect(readShortcutPreferences(JSON.stringify({ commandPalette: "Mod+K", pull: "Mod+K" }))).toEqual(defaultShortcutPreferences);
  });

  it("loads valid shortcut swaps without treating other stored defaults as conflicts", () => {
    const preferences = readShortcutPreferences(JSON.stringify({ commandPalette: "Mod+O", openRepository: "Mod+K" }));
    expect(preferences.commandPalette).toBe("Mod+O");
    expect(preferences.openRepository).toBe("Mod+K");
  });

  it("captures a normalized cross-platform binding and ignores IME composition", () => {
    expect(shortcutFromEvent(keyEvent("l", { ctrlKey: true, shiftKey: true }))).toBe("Mod+Shift+L");
    expect(shortcutFromEvent(keyEvent("Enter", { metaKey: true }))).toBe("Mod+Enter");
    expect(shortcutFromEvent(keyEvent("Process", { ctrlKey: true, isComposing: true }))).toBeUndefined();
    expect(shortcutFromEvent(keyEvent("Enter", { ctrlKey: true, isComposing: true }))).toBeUndefined();
    expect(shortcutFromEvent(keyEvent("k"))).toBeUndefined();
    expect(shortcutFromEvent(keyEvent("\\", { ctrlKey: true }))).toBe("Mod+\\");
  });

  it("matches the platform modifier and requires the exact modifier set", () => {
    expect(matchesShortcut(keyEvent("k", { ctrlKey: true }), "Mod+K", false)).toBe(true);
    expect(matchesShortcut(keyEvent("k", { metaKey: true }), "Mod+K", true)).toBe(true);
    expect(matchesShortcut(keyEvent("k", { ctrlKey: true, shiftKey: true }), "Mod+K", false)).toBe(false);
    expect(matchesShortcut(keyEvent("k", { ctrlKey: true, isComposing: true }), "Mod+K", false)).toBe(false);
    expect(matchesShortcut(keyEvent("\\", { ctrlKey: true }), defaultShortcutPreferences.toggleDiffView, false)).toBe(true);
  });

  it("rejects duplicate and reserved shortcuts and formats labels by platform", () => {
    expect(shortcutConflict("pull", "Mod+K", defaultShortcutPreferences)).toBe("Already assigned to Open command palette.");
    expect(shortcutConflict("pull", "Mod+W", defaultShortcutPreferences)).toContain("reserved");
    expect(shortcutConflict("pull", "Shift+L", defaultShortcutPreferences)).toContain("Ctrl/Cmd");
    expect(isValidBinding("Mod+Shift+Enter")).toBe(true);
    expect(isValidBinding("Mod+Shift+Alt+Enter")).toBe(false);
    expect(displayShortcut("Mod+Shift+Enter", false)).toBe("Ctrl+Shift+↵");
    expect(displayShortcut("Mod+Shift+Enter", true)).toBe("⌘⇧↵");
    expect(ariaShortcut("Mod+Shift+Enter", false)).toBe("Control+Shift+Enter");
    expect(ariaShortcut("Mod+Shift+Enter", true)).toBe("Meta+Shift+Enter");
  });
});
