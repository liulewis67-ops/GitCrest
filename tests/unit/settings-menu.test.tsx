// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsMenu } from "../../src/app/layouts/SettingsMenu";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { getAppearance, setThemeMode } from "../../src/features/settings/model/appearance-store";
import { getLocale, setLocale } from "../../src/shared/i18n";

afterEach(() => {
  cleanup();
  setLocale("en");
  setThemeMode("system");
});

function renderMenu() {
  const onOpenSettings = vi.fn();
  render(<SettingsMenu shortcuts={defaultShortcutPreferences} isMacPlatform={false} onOpenSettings={onOpenSettings} />);
  const gear = screen.getByRole("button", { name: "Settings" });
  fireEvent.click(gear);
  return { gear, onOpenSettings, menu: screen.getByRole("menu", { name: "Quick settings" }) };
}

it("switches the theme and the language in place from the gear", () => {
  const { gear } = renderMenu();
  expect(gear.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("menuitemradio", { name: "System" }).getAttribute("aria-checked")).toBe("true");

  fireEvent.click(screen.getByRole("menuitemradio", { name: "Dark" }));
  expect(getAppearance().preferences.mode).toBe("dark");
  expect(screen.getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");

  fireEvent.click(screen.getByRole("menuitemradio", { name: "中文" }));
  expect(getLocale()).toBe("zh");
  // The menu stays open and follows the new language.
  expect(screen.getByRole("menuitemradio", { name: "深色" }).getAttribute("aria-checked")).toBe("true");
});

it("opens the full Settings page below the quick switches and closes the menu", () => {
  const { onOpenSettings } = renderMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /All settings/ }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes on Escape and returns focus to the gear", () => {
  const { gear } = renderMenu();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(document.activeElement).toBe(gear);
});
