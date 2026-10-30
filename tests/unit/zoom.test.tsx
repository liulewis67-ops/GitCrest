// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultShortcutPreferences, SHORTCUT_PREFERENCES_KEY } from "../../src/features/settings/model/shortcut-preferences";
import { getZoom, handleZoomShortcut, readZoom, resetZoom, setZoom, startZoom, useZoom, zoomIn, zoomOut, ZOOM_LEVELS, ZOOM_STORAGE_KEY } from "../../src/features/settings/model/zoom-store";
import { StyleSettings } from "../../src/features/settings/ui/StyleSettings";

const setZoomFactor = vi.fn();

beforeEach(() => {
  localStorage.clear();
  setZoomFactor.mockClear();
  Object.defineProperty(window, "gitcrest", { configurable: true, value: { setZoomFactor } });
  setZoom(1);
  setZoomFactor.mockClear();
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gitcrest");
});

function key(init: KeyboardEventInit) {
  return new KeyboardEvent("keydown", { cancelable: true, ...init });
}

describe("zoom levels", () => {
  it("accepts only supported saved levels", () => {
    expect(readZoom("1.25")).toBe(1.25);
    for (const bad of [null, "", "abc", "3", "0.1", "1.05", "NaN"]) expect(readZoom(bad)).toBe(1);
  });

  it("steps through the supported range and stops at its ends", () => {
    for (let index = 0; index < ZOOM_LEVELS.length + 2; index += 1) zoomIn();
    expect(getZoom()).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    for (let index = 0; index < ZOOM_LEVELS.length + 2; index += 1) zoomOut();
    expect(getZoom()).toBe(ZOOM_LEVELS[0]);
    resetZoom();
    expect(getZoom()).toBe(1);
  });

  it("applies each level to the window and keeps it across restarts", () => {
    zoomIn();
    expect(setZoomFactor).toHaveBeenLastCalledWith(1.1);
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("1.1");
    setZoom(1.5);
    setZoomFactor.mockClear();
    startZoom();
    expect(setZoomFactor).toHaveBeenCalledWith(1.5);
    expect(getZoom()).toBe(1.5);
  });

  it("falls back to the document zoom outside the desktop app", () => {
    Reflect.deleteProperty(window, "gitcrest");
    setZoom(1.25);
    expect(document.documentElement.style.getPropertyValue("zoom")).toBe("1.25");
    document.documentElement.style.removeProperty("zoom");
  });

  it("follows a level changed in another window", () => {
    startZoom();
    window.dispatchEvent(new StorageEvent("storage", { key: ZOOM_STORAGE_KEY, newValue: "0.9" }));
    expect(getZoom()).toBe(0.9);
  });
});

describe("zoom shortcuts", () => {
  it("zoom with the default keys and stop the window's own zoom", () => {
    const event = key({ key: "=", ctrlKey: true });
    expect(handleZoomShortcut(event, false)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(getZoom()).toBe(1.1);
    expect(handleZoomShortcut(key({ key: "-", ctrlKey: true }), false)).toBe(true);
    expect(getZoom()).toBe(1);
    zoomIn();
    expect(handleZoomShortcut(key({ key: "0", ctrlKey: true }), false)).toBe(true);
    expect(getZoom()).toBe(1);
  });

  it("ignore other keys", () => {
    const event = key({ key: "a", ctrlKey: true });
    expect(handleZoomShortcut(event, false)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it("follow a remapped binding", () => {
    localStorage.setItem(SHORTCUT_PREFERENCES_KEY, JSON.stringify({ ...defaultShortcutPreferences, zoomIn: "Mod+9" }));
    expect(handleZoomShortcut(key({ key: "9", ctrlKey: true }), false)).toBe(true);
    expect(getZoom()).toBe(1.1);
    expect(handleZoomShortcut(key({ key: "=", ctrlKey: true }), false)).toBe(false);
  });
});

describe("zoom setting", () => {
  it("changes the level from Appearance and shows it", () => {
    function Probe() {
      return <span data-testid="level">{useZoom()}</span>;
    }
    render(<><StyleSettings themeName={() => "Theme"} /><Probe /></>);
    expect(screen.getByText("100%")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(screen.getByText("110%")).toBeTruthy();
    expect(screen.getByTestId("level").textContent).toBe("1.1");
    fireEvent.click(screen.getByRole("button", { name: "Reset to 100%" }));
    expect(screen.getByText("100%")).toBeTruthy();
  });

  it("disables the buttons at the ends of the range", () => {
    render(<StyleSettings themeName={() => "Theme"} />);
    act(() => setZoom(1.5));
    expect((screen.getByRole("button", { name: "Zoom in" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => setZoom(0.8));
    expect((screen.getByRole("button", { name: "Zoom out" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
