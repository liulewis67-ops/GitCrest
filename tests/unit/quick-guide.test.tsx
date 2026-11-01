// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { QuickGuideDialog } from "../../src/app/layouts/QuickGuideDialog";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { repositoryParentLabels } from "../../src/shared/lib/repository-display-name";

afterEach(cleanup);
it("offers searchable task help with current shortcuts and working modal dismissal", () => {
  const onClose = vi.fn();
  render(<QuickGuideDialog shortcuts={{ ...defaultShortcutPreferences, commit: "Mod+Shift+J" }} isMacPlatform={false} onClose={onClose} />);
  const search = screen.getByRole("searchbox", { name: "Search help" });
  expect(document.activeElement).toBe(search);
  expect(screen.getByRole("heading", { name: "Write a commit" })).toBeTruthy();
  expect(screen.getByText("Ctrl+Shift+J")).toBeTruthy();
  fireEvent.change(search, { target: { value: "signing key" } });
  expect(document.querySelectorAll(".quickGuideTopic")).toHaveLength(1);
  expect(screen.queryByRole("heading", { name: "Fetch, pull and push" })).toBeNull();
  fireEvent.change(search, { target: { value: "unmatched topic" } });
  expect(screen.getByRole("status").textContent).toContain("No matching topics");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});
it("distinguishes duplicate repository basenames with the shortest unique parent suffix", () => {
  const labels = repositoryParentLabels(["C:/work/one/repo", "D:/work/two/repo", "E:/other/two/repo", "C:\\solo\\unique\\"]);
  expect(labels.get("C:/work/one/repo")).toBe("one");
  expect(labels.get("D:/work/two/repo")).toBe("work/two");
  expect(labels.get("E:/other/two/repo")).toBe("other/two");
  expect(labels.has("C:\\solo\\unique\\")).toBe(false);
});
