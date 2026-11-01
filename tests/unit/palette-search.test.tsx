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
    ["showWelcome", "showWorkspace", "openAppearance", "nextTheme", "openRepository", "initializeRepository", "cloneRepository", "openBranchSwitcher", "createBranchAt", "checkoutCommit", "resetToCommit", "renameCurrentBranch", "newWorktreeFrom", "merge", "cherryPick", "revert", "createTag", "reset", "rebase", "fetch", "pull", "push", "commit", "commitAndPush", "stageAll", "undo", "refreshStatus", "openDiff", "searchCommits", "shelve", "openSettings", "openAiAssistant", "showView", "toggleSidebar", "toggleInspector", "toggleFocusMode", "toggleDiffView", "showReflog", "openInEditor", "openInTerminal", "zoomIn", "zoomOut", "zoomReset", "manageRemotes", "closeTab"].map((name) => [name, noop]),
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
    return <CommandPalette open context="ctx" commands={createPaletteCommands(input(run))} shortcuts={defaultShortcutPreferences} isMacPlatform={false} query={query} onQueryChange={setQuery} onClose={vi.fn()} />;
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

  it("collapses unavailable commands and exposes their reasons without running them", () => {
    const options = { ...input(), repository: undefined, page: "welcome" as const };
    const commands = createPaletteCommands(options);
    render(<CommandPalette open context="No repository" commands={commands} shortcuts={defaultShortcutPreferences} isMacPlatform={false} query="" onQueryChange={vi.fn()} onClose={vi.fn()} />);
    const commit = commands.find((command) => command.id === "commit")!;
    expect(screen.queryByRole("button", { name: commit.label })).toBeNull();
    const toggle = screen.getByRole("button", { name: /Requires a repository \(\d+\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    const disabled = screen.getByRole("button", { name: commit.label });
    expect(disabled.getAttribute("aria-disabled")).toBe("true");
    fireEvent.focus(disabled);
    expect(disabled.textContent).toContain(commit.unavailableReason);
    fireEvent.click(disabled);
    expect(options.run.commit).not.toHaveBeenCalled();
  });

  it("shows only the selected description and gives Ctrl+1 its actual Workspace meaning", () => {
    render(<Harness />);
    expect(document.querySelectorAll(".commandItemMain small")).toHaveLength(1);
    const fetch = screen.getByRole("button", { name: "Fetch from remotes" });
    fireEvent.focus(fetch);
    expect(document.querySelectorAll(".commandItemMain small")).toHaveLength(1);
    expect(fetch.querySelector("small")).not.toBeNull();
    const workspace = screen.getByRole("button", { name: "Show Workspace" });
    expect(workspace.textContent).toContain("Ctrl+1");
    expect(workspace.getAttribute("aria-keyshortcuts")).toBe("Control+1");
    expect(screen.getByRole("button", { name: "Go to Welcome" }).querySelector("kbd")).toBeNull();
  });
});
