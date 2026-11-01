// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { RepositoryResponse } from "../../src/api/client";
import { WelcomePage } from "../../src/pages/welcome/WelcomePage";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";

afterEach(cleanup);
const repositories: RepositoryResponse[] = [
  { repoId: "a", path: "C:/projects/alpha", branch: "main", head: "a".repeat(40), detached: false, availability: "available", state: "normal", isFavorite: true, lastAccessedAt: 1 },
  { repoId: "b", path: "C:/projects/beta", branch: null, head: "b".repeat(40), detached: true, availability: "available", state: "normal", isFavorite: false, lastAccessedAt: 2 },
  { repoId: "c", path: "C:/projects/missing", branch: "main", head: null, detached: false, availability: "missing", state: "normal", isFavorite: false, lastAccessedAt: 3 },
];
function setup() {
  const onOpenRepository = vi.fn(), onToggleFavorite = vi.fn();
  render(<WelcomePage repositories={repositories} connected openingRepository={false} openError="" shortcuts={defaultShortcutPreferences} isMacPlatform={false} onOpenLocalRepository={vi.fn()} onCloneRepository={vi.fn()} onNavigateWorkspace={vi.fn()} onInitializeRepository={vi.fn()} onOpenRepository={onOpenRepository} onToggleFavorite={onToggleFavorite} onForgetRepository={vi.fn()} onLocateRepository={vi.fn()} />);
  return { onOpenRepository, onToggleFavorite };
}
it("leads with recents, has one action row and one Tab stop per repository, with arrow access to secondary actions", () => {
  const { onOpenRepository, onToggleFavorite } = setup();
  expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Recent repositories");
  expect(screen.getByRole("group", { name: "Repository actions" }).querySelectorAll("button")).toHaveLength(3);
  expect(screen.queryByRole("button", { name: /Preview workspace/ })).toBeNull();
  const rows = [...document.querySelectorAll<HTMLElement>(".repositoryRow")];
  rows.forEach((row) => expect([...row.querySelectorAll<HTMLButtonElement>("button")].filter((button) => button.tabIndex === 0)).toHaveLength(1));
  const first = rows[0].querySelector<HTMLButtonElement>(".repositoryRowOpen")!;
  const second = rows[1].querySelector<HTMLButtonElement>(".repositoryRowOpen")!;
  first.focus(); fireEvent.keyDown(first, { key: "ArrowDown" });
  expect(document.activeElement).toBe(second);
  expect(onOpenRepository).not.toHaveBeenCalled();
  fireEvent.keyDown(second, { key: "Home" });
  fireEvent.keyDown(first, { key: "ArrowRight" });
  const favorite = screen.getByRole("button", { name: "Remove alpha from favorites" });
  expect(document.activeElement).toBe(favorite);
  fireEvent.click(favorite);
  expect(onToggleFavorite).toHaveBeenCalledWith(repositories[0]);
  fireEvent.keyDown(favorite, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(first);
  fireEvent.click(first);
  expect(onOpenRepository).toHaveBeenCalledWith(repositories[0]);
  expect(screen.getByLabelText("Detached HEAD")).toBeTruthy();
  expect(screen.getByLabelText("Repository unavailable")).toBeTruthy();
});
it("filters recents by name, path or branch and moves from search into the matching rows", () => {
  setup();
  const search = screen.getByRole("searchbox", { name: "Filter recent repositories" });
  fireEvent.change(search, { target: { value: "beta" } });
  expect(document.querySelectorAll(".repositoryRow")).toHaveLength(1);
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement?.className).toBe("repositoryRowOpen");
  fireEvent.change(search, { target: { value: "no-match" } });
  expect(screen.getByRole("status").textContent).toBe("No repositories match this filter.");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(document.querySelectorAll(".repositoryRow")).toHaveLength(3);
});
