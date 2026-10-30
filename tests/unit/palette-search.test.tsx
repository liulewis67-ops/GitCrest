// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPaletteCommands, type PaletteInput } from "../../src/app/commands/palette-commands";
import { rankCommands, readRecentCommands, rememberRecentCommand, RECENT_LIMIT, scoreCommand } from "../../src/app/commands/palette-search";
import { CommandPalette } from "../../src/app/layouts/CommandPalette";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { t } from "../../src/shared/i18n";

const OID = "a".repeat(40);

function input(run: Partial<PaletteInput["run"]> = {}): PaletteInput {
  const noop = vi.fn();
  const base = Object.fromEntries(
    ["showWelcome", "showWorkspace", "openAppearance", "nextTheme", "openRepository", "initializeRepository", "cloneRepository", "openBranchSwitcher", "createBranchAt", "checkoutCommit", "resetToCommit", "renameCurrentBranch", "newWorktreeFrom", "merge", "cherryPick", "revert", "createTag", "reset", "rebase", "fetch", "pull", "push", "commit", "commitAndPush", "stageAll", "undo", "refreshStatus", "openDiff", "searchCommits", "shelve", "openSettings", "openAiAssistant", "showView", "toggleSidebar", "toggleInspector", "toggleFocusMode", "toggleDiffView", "openInEditor", "openInTerminal", "zoomIn", "zoomOut", "zoomReset", "manageRemotes", "closeTab"].map((name) => [name, noop]),
  ) as unknown as PaletteInput["run"];
  return {
    t, shortcuts: defaultShortcutPreferences, isMacPlatform: false, page: "workspace", mode: "history", connected: true,
    repository: { repoId: "repo_a", availability: "available", head: OID, branch: "main", detached: false },
    hasActiveRepositoryTask: false, hasBranches: true, stagedCount: 1, workingCount: 2, hasConflicts: false, commitBusy: false,
    canCommit: true, hasCommitMessage: true, selectedCommit: OID, hasDiffTarget: true, hasSelectedFile: true,
    activeStatusLoading: false, themeDetail: "Current: dark; next: light", run: { ...base, ...run },
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("palette search", () => {
  const commands = createPaletteCommands(input());
  const top = (query: string) => rankCommands(commands, query)[0]?.id;

  it("finds Shelve when searching for stash", () => {
    expect(rankCommands(commands, "stash").map((command) => command.id)).toContain("shelve");
  });

  it("ranks a label that starts with the query first", () => {
    expect(top("push")).toBe("push");
    expect(top("cherry")).toBe("cherry-pick");
  });

  it("matches synonyms and Git's own words", () => {
    expect(rankCommands(commands, "checkout").map((command) => command.id)).toEqual(expect.arrayContaining(["branch-switcher", "checkout-commit"]));
    expect(rankCommands(commands, "ship").map((command) => command.id)).toContain("commit-push");
  });

  it("matches a run of letters inside a label", () => {
    expect(rankCommands(commands, "cpk").map((command) => command.id)).toContain("cherry-pick");
  });

  it("requires every word of a multi-word query", () => {
    const ids = rankCommands(commands, "selected commit").map((command) => command.id);
    expect(ids).toEqual(expect.arrayContaining(["merge", "cherry-pick", "revert"]));
    expect(rankCommands(commands, "selected zzzzzz")).toEqual([]);
  });

  it("returns nothing for text that matches no command and everything for no text", () => {
    expect(rankCommands(commands, "qqqqqqq")).toEqual([]);
    expect(rankCommands(commands, "  ")).toEqual(commands);
  });

  it("lists a runnable command before an equally good unavailable one", () => {
    const mixed = createPaletteCommands(input());
    mixed.find((command) => command.id === "merge")!.available = false;
    const ids = rankCommands(mixed, "selected commit").map((command) => command.id);
    expect(ids.indexOf("cherry-pick")).toBeLessThan(ids.indexOf("merge"));
    expect(scoreCommand(mixed[0], "")).toBe(1);
  });
});

describe("recent commands", () => {
  it("keeps the last five, newest first, without repeats", () => {
    let ids: string[] = [];
    for (const id of ["a", "b", "c", "d", "e", "f", "a"]) ids = rememberRecentCommand(id, ids);
    expect(ids).toEqual(["a", "f", "e", "d", "c"]);
    expect(ids).toHaveLength(RECENT_LIMIT);
    expect(readRecentCommands()).toEqual(ids);
  });

  it("survives unreadable storage", () => {
    localStorage.setItem("gitcrest.palette.recent", "{not json");
    expect(readRecentCommands()).toEqual([]);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(rememberRecentCommand("x", [])).toEqual(["x"]);
    vi.restoreAllMocks();
  });
});

describe("command palette", () => {
  function Harness({ run }: { run?: Partial<PaletteInput["run"]> }) {
    const [query, setQuery] = useState("");
    return <CommandPalette open context="ctx" commands={createPaletteCommands(input(run))} navigationShortcut="Ctrl" shortcuts={defaultShortcutPreferences} isMacPlatform={false} query={query} onQueryChange={setQuery} onClose={vi.fn()} />;
  }

  it("moves the commands just used to a Recent group at the top", () => {
    const fetch = vi.fn();
    const { unmount } = render(<Harness run={{ fetch }} />);
    fireEvent.click(screen.getByRole("button", { name: /Fetch from remotes/ }));
    expect(fetch).toHaveBeenCalled();
    unmount();

    render(<Harness />);
    const groups = screen.getAllByRole("group");
    expect(groups[0].getAttribute("aria-label")).toBe("Recent");
    expect(groups[0].textContent).toContain("Fetch from remotes");
    // Not repeated in its own group.
    expect(screen.getAllByRole("button", { name: /Fetch from remotes/ })).toHaveLength(1);
  });

  it("shows one ranked list while searching and finds Shelve by 'stash'", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "Search commands" }), { target: { value: "stash" } });
    const results = screen.getByRole("group", { name: "Results" });
    expect(results.textContent).toContain("Shelve changes");
    expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
  });

  it("shows each command's current shortcut", () => {
    render(<Harness />);
    const button = screen.getByRole("button", { name: /Search commit history/ });
    expect(button.textContent).toContain("Ctrl+F");
  });
});
