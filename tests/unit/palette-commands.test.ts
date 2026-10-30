import { describe, expect, it, vi } from "vitest";
import { createPaletteCommands, SHORTCUT_COMMANDS, type PaletteInput } from "../../src/app/commands/palette-commands";
import { shortcutActions } from "../../src/features/settings";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { t } from "../../src/shared/i18n";

const OID = "a".repeat(40);

function runners(): PaletteInput["run"] {
  const noop = vi.fn();
  return {
    showWelcome: noop, showWorkspace: noop, openAppearance: noop, nextTheme: noop, openRepository: noop, initializeRepository: noop,
    cloneRepository: noop, openBranchSwitcher: noop, createBranchAt: noop, checkoutCommit: noop, resetToCommit: noop, renameCurrentBranch: noop, newWorktreeFrom: noop,
    merge: noop, cherryPick: noop, revert: noop, createTag: noop, reset: noop, rebase: noop, fetch: noop, pull: noop, push: noop,
    commit: noop, commitAndPush: noop, stageAll: noop, undo: noop, refreshStatus: noop, openDiff: noop, searchCommits: noop,
    shelve: noop, openSettings: noop, openAiAssistant: noop, showView: noop, toggleSidebar: noop, toggleInspector: noop,
    toggleFocusMode: noop, toggleDiffView: noop, manageRemotes: noop, closeTab: noop,
  };
}

function input(overrides: Partial<PaletteInput> = {}): PaletteInput {
  return {
    t, shortcuts: defaultShortcutPreferences, isMacPlatform: false, page: "workspace", mode: "history", connected: true,
    repository: { repoId: "repo_a", availability: "available", head: OID, branch: "main", detached: false },
    hasActiveRepositoryTask: false, hasBranches: true, stagedCount: 1, workingCount: 2, hasConflicts: false, commitBusy: false,
    canCommit: true, hasCommitMessage: true, selectedCommit: OID, hasDiffTarget: true, hasSelectedFile: true,
    activeStatusLoading: false, themeDetail: "Current: dark; next: light", run: runners(), ...overrides,
  };
}

describe("command palette registry", () => {
  const commands = createPaletteCommands(input());
  const byId = new Map(commands.map((command) => [command.id, command]));

  it("lists every command once", () => {
    expect(byId.size).toBe(commands.length);
  });

  it("has an entry, or a stated exemption, for every remappable shortcut", () => {
    expect(Object.keys(SHORTCUT_COMMANDS).sort()).toEqual(shortcutActions.map(({ id }) => id).sort());
    for (const [action, target] of Object.entries(SHORTCUT_COMMANDS)) {
      if (typeof target === "string") {
        const command = byId.get(target);
        expect(command, `${action} -> ${target}`).toBeDefined();
        expect(command?.shortcut, `${target} must show the ${action} binding`).toBe(action);
      } else {
        expect(target.exempt.length).toBeGreaterThan(10);
      }
    }
  });

  it("links every command that names a shortcut back to that shortcut's entry", () => {
    for (const command of commands.filter((item) => item.shortcut)) {
      expect(SHORTCUT_COMMANDS[command.shortcut!], command.id).toBe(command.id);
    }
  });

  it("covers the flows the plan names: merge, cherry-pick, revert, branches, shelve, tags, settings, worktrees, tabs, init, refresh, undo", () => {
    for (const id of ["checkout-commit", "reset-to-commit", "merge", "cherry-pick", "revert", "branch-here", "branch-at-head", "rename-branch", "shelve", "create-tag", "settings", "new-worktree", "close-tab", "init", "refresh", "undo"]) {
      expect(byId.get(id), id).toBeDefined();
      expect(byId.get(id)?.available, id).toBe(true);
    }
  });

  it("keeps unavailable commands listed with a reason", () => {
    const empty = createPaletteCommands(input({ repository: undefined, selectedCommit: undefined, page: "welcome" }));
    const merge = empty.find((command) => command.id === "merge");
    expect(merge?.available).toBe(false);
    expect(merge?.unavailableReason).toBe("Open a repository first.");
    for (const command of empty.filter((item) => !item.available)) {
      expect(command.unavailableReason, command.id).toBeTruthy();
    }
    expect(empty.find((command) => command.id === "open")?.available).toBe(true);
  });

  it("explains why a commit-bound command waits for a selected commit", () => {
    const noCommit = createPaletteCommands(input({ selectedCommit: undefined })).find((command) => command.id === "cherry-pick");
    expect(noCommit?.available).toBe(false);
    expect(noCommit?.unavailableReason).toBe("Select a commit in History first.");
  });

  it("blocks Git actions while a task runs and commits without a message", () => {
    const busy = createPaletteCommands(input({ hasActiveRepositoryTask: true }));
    expect(busy.find((command) => command.id === "merge")?.unavailableReason).toBe("Wait for the running Git task to finish.");
    const noMessage = createPaletteCommands(input({ mode: "changes", hasCommitMessage: false, canCommit: false }));
    expect(noMessage.find((command) => command.id === "commit")?.unavailableReason).toBe("Write a commit message first.");
  });

  it("cannot rename a branch while HEAD is detached", () => {
    const detached = createPaletteCommands(input({ repository: { repoId: "repo_a", availability: "available", head: OID, branch: null, detached: true } }));
    expect(detached.find((command) => command.id === "rename-branch")?.unavailableReason).toBe("HEAD is detached, so there is no current branch.");
  });

  it("runs the matching action with the selected commit", () => {
    const run = runners();
    createPaletteCommands(input({ run })).find((command) => command.id === "revert")?.run();
    expect(run.revert).toHaveBeenCalledWith(OID);
  });
});
