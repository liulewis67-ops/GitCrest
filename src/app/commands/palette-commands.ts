import type { MessageKey } from "../../shared/i18n";
import { displayShortcut, type ShortcutAction, type ShortcutPreferences } from "../../features/settings";

export type CommandGroup = "navigate" | "repository" | "changes" | "branches" | "commits" | "remote" | "view" | "app";

export interface CommandPaletteCommand {
  id: string;
  label: string;
  detail: string;
  group: CommandGroup;
  available: boolean;
  /** Why an unavailable command cannot run now; shown instead of the description. */
  unavailableReason?: string;
  /** The remappable shortcut that runs the same action; the palette shows its current binding. */
  shortcut?: ShortcutAction;
  run: () => void;
}

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string;

/**
 * The palette entry that runs each remappable shortcut's action, or why it has none. A shortcut
 * added without an entry here fails the type check, and `tests/unit/palette-commands.test.ts`
 * checks that every listed entry exists.
 */
export const SHORTCUT_COMMANDS: Record<ShortcutAction, string | { exempt: string }> = {
  commandPalette: { exempt: "It opens the palette itself." },
  openRepository: "open",
  cloneRepository: "clone",
  initializeRepository: "init",
  commit: "commit",
  commitAndPush: "commit-push",
  stageAll: "stage-all",
  undoRecentOperation: "undo",
  fetch: "fetch",
  push: "push",
  pull: "pull",
  refreshStatus: "refresh",
  openDiff: "open-diff",
  toggleDiffView: "toggle-diff-view",
  zoomIn: "zoom-in",
  zoomOut: "zoom-out",
  zoomReset: "zoom-reset",
  searchCommits: "search-commits",
  shelve: "shelve",
  settings: "settings",
  rebase: "rebase",
  branchSwitcher: "branch-switcher",
  cherryPick: "cherry-pick",
  createTag: "create-tag",
  aiCommitMessage: "ai-commit-message",
  viewChanges: "view-changes",
  viewHistory: "view-history",
  toggleSidebar: "toggle-sidebar",
  toggleInspector: "toggle-details",
  focusMode: "focus-mode",
};

export interface PaletteInput {
  t: Translate;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  page: "welcome" | "workspace";
  /** The workspace view: Changes or History. */
  mode: "changes" | "history";
  connected: boolean;
  repository?: { repoId: string; availability: string; head: string | null; branch: string | null; detached: boolean };
  hasActiveRepositoryTask: boolean;
  hasBranches: boolean;
  /** The current local branch as a pipeline source: its pushed commit, and why it cannot run if so. */
  pipelineSource?: { branch: string; oid: string; blocker?: "noUpstream" | "unpushed" };
  stagedCount: number;
  workingCount: number;
  hasConflicts: boolean;
  commitBusy: boolean;
  canCommit: boolean;
  hasCommitMessage: boolean;
  /** The commit selected in History, when it is a full object id. */
  selectedCommit?: string;
  hasDiffTarget: boolean;
  hasSelectedFile: boolean;
  activeStatusLoading: boolean;
  /** Describes the theme change, such as "Current: dark; next: light". */
  themeDetail: string;
  run: {
    showWelcome: () => void;
    showWorkspace: () => void;
    openAppearance: () => void;
    nextTheme: () => void;
    openRepository: () => void;
    initializeRepository: () => void;
    cloneRepository: () => void;
    openBranchSwitcher: () => void;
    createBranchAt: (oid: string) => void;
    checkoutCommit: (oid: string) => void;
    resetToCommit: (oid: string) => void;
    renameCurrentBranch: (name: string) => void;
    newWorktreeFrom: (oid: string) => void;
    merge: (oid: string) => void;
    cherryPick: (oid: string) => void;
    revert: (oid: string) => void;
    createTag: (oid: string) => void;
    reset: () => void;
    rebase: () => void;
    fetch: () => void;
    pull: () => void;
    push: () => void;
    commit: () => void;
    commitAndPush: () => void;
    stageAll: () => void;
    undo: () => void;
    refreshStatus: (repoId: string) => void;
    openDiff: () => void;
    searchCommits: (repoId: string) => void;
    shelve: (repoId: string) => void;
    openSettings: () => void;
    openAiAssistant: () => void;
    showView: (mode: "changes" | "history") => void;
    toggleSidebar: () => void;
    toggleInspector: () => void;
    toggleFocusMode: () => void;
    toggleDiffView: () => void;
    showReflog: () => void;
    showSubmodules: () => void;
    compare: (request: { base?: string; head?: string; workingTree?: boolean }) => void;
    runPipeline: (source: { branch: string; oid: string }) => void;
    openInEditor: () => void;
    openInTerminal: () => void;
    zoomIn: () => void;
    zoomOut: () => void;
    zoomReset: () => void;
    manageRemotes: () => void;
    closeTab: (repoId: string) => void;
  };
}

/** Builds every palette command from the current state; each one carries why it is unavailable. */
export function createPaletteCommands(input: PaletteInput): CommandPaletteCommand[] {
  const { t, run, repository } = input;
  const why = {
    noRepo: t("cmd.why.noRepo"),
    offline: t("cmd.why.offline"),
    missing: t("cmd.why.missing"),
    busy: t("cmd.why.busy"),
  };
  /** The first reason in order, or nothing when every condition holds. */
  const firstReason = (...reasons: Array<string | false | undefined>) => reasons.find((reason): reason is string => Boolean(reason));
  const inWorkspace = !repository ? why.noRepo : input.page !== "workspace" ? t("cmd.why.notWorkspace") : undefined;
  const repositoryReady = firstReason(
    !repository && why.noRepo,
    !input.connected && why.offline,
    repository && repository.availability !== "available" && why.missing,
  );
  const gitReady = firstReason(repositoryReady, input.hasActiveRepositoryTask && why.busy);
  const commitReady = firstReason(gitReady, !input.selectedCommit && t("cmd.why.noCommit"));
  const changesReady = firstReason(repositoryReady, input.mode !== "changes" && t("cmd.why.needChanges"));
  const repoId = repository?.repoId ?? "";
  const head = repository?.head ?? undefined;

  function command(
    id: string,
    group: CommandGroup,
    labelKey: MessageKey,
    detail: string,
    reason: string | false | undefined,
    action: () => void,
    shortcut?: ShortcutAction,
  ): CommandPaletteCommand {
    return {
      id,
      group,
      label: t(labelKey),
      detail,
      available: !reason,
      ...(reason ? { unavailableReason: reason } : {}),
      ...(shortcut ? { shortcut } : {}),
      run: action,
    };
  }
  const shortcutDetail = (key: MessageKey, action: ShortcutAction) =>
    t(key, { shortcut: displayShortcut(input.shortcuts[action], input.isMacPlatform) });
  const commitOid = input.selectedCommit ?? "";

  return [
    command("welcome", "navigate", "cmd.welcome", t("cmd.welcomeDetail"), false, run.showWelcome),
    command("workspace", "navigate", "cmd.workspace", t("cmd.workspaceDetail"), false, run.showWorkspace),
    command("open", "repository", "cmd.open", t("cmd.openDetail"), false, run.openRepository, "openRepository"),
    command("clone", "repository", "cmd.clone", t("cmd.cloneDetail"), !input.connected && why.offline, run.cloneRepository, "cloneRepository"),
    command("init", "repository", "cmd.init", t("cmd.initDetail"), !input.connected && why.offline, run.initializeRepository, "initializeRepository"),
    command("close-tab", "repository", "cmd.closeTab", t("cmd.closeTabDetail"), inWorkspace, () => run.closeTab(repoId)),
    command("refresh", "changes", "cmd.refresh", t("cmd.refreshDetail"), firstReason(repositoryReady, input.activeStatusLoading && why.busy), () => run.refreshStatus(repoId), "refreshStatus"),
    command("stage-all", "changes", "cmd.stageAll", t("cmd.stageAllDetail"), firstReason(gitReady, input.workingCount === 0 && t("cmd.why.noChanges")), run.stageAll, "stageAll"),
    command("commit", "changes", "cmd.commit", t("cmd.commitDetail"), firstReason(
      changesReady,
      input.stagedCount === 0 && t("cmd.why.noStaged"),
      input.hasConflicts && t("cmd.why.conflicts"),
      !input.hasCommitMessage && t("cmd.why.noMessage"),
      !input.canCommit && why.busy,
    ), run.commit, "commit"),
    command("commit-push", "changes", "cmd.commitPush", t("cmd.commitPushDetail"), firstReason(
      changesReady,
      input.stagedCount === 0 && t("cmd.why.noStaged"),
      input.hasConflicts && t("cmd.why.conflicts"),
      !input.hasCommitMessage && t("cmd.why.noMessage"),
      !input.canCommit && why.busy,
    ), run.commitAndPush, "commitAndPush"),
    command("undo", "changes", "cmd.undo", t("cmd.undoDetail"), gitReady, run.undo, "undoRecentOperation"),
    command("open-diff", "changes", "cmd.openDiff", t("cmd.openDiffDetail"), firstReason(inWorkspace, !input.hasSelectedFile && t("cmd.why.noFile")), run.openDiff, "openDiff"),
    command("shelve", "changes", "cmd.shelve", t("cmd.shelveDetail"), inWorkspace, () => run.shelve(repoId), "shelve"),
    command("ai-commit-message", "changes", "cmd.ai", shortcutDetail("cmd.aiDetail", "aiCommitMessage"), firstReason(
      repositoryReady,
      input.stagedCount === 0 && t("cmd.why.noStaged"),
      input.hasConflicts && t("cmd.why.conflicts"),
      input.commitBusy && why.busy,
    ), run.openAiAssistant, "aiCommitMessage"),
    command("branch-switcher", "branches", "cmd.branchSwitcher", shortcutDetail("cmd.branchSwitcherDetail", "branchSwitcher"), repositoryReady, run.openBranchSwitcher, "branchSwitcher"),
    command("show-submodules", "branches", "cmd.showSubmodules", t("cmd.showSubmodulesDetail"), repositoryReady, run.showSubmodules),
    command("run-pipeline", "branches", "cmd.runPipeline", t("cmd.runPipelineDetail"), firstReason(
      repositoryReady,
      !input.pipelineSource && t("cmd.why.noBranches"),
      input.pipelineSource?.blocker === "noUpstream" && t("pl.run.noUpstream"),
      input.pipelineSource?.blocker === "unpushed" && t("pl.run.unpushed"),
    ), () => { if (input.pipelineSource) run.runPipeline(input.pipelineSource); }),
    command("compare-refs", "branches", "cmd.compareRefs", t("cmd.compareRefsDetail"), repositoryReady, () => run.compare({})),
    command("compare-commit", "commits", "cmd.compareCommit", t("cmd.compareCommitDetail"), commitReady, () => run.compare({ base: commitOid })),
    command("compare-commit-tree", "commits", "cmd.compareCommitTree", t("cmd.compareCommitTreeDetail"), commitReady, () => run.compare({ base: commitOid, workingTree: true })),
    command("show-reflog", "branches", "cmd.showReflog", t("cmd.showReflogDetail"), repositoryReady, run.showReflog),
    command("branch-here", "branches", "cmd.branchHere", t("cmd.branchHereDetail"), commitReady, () => run.createBranchAt(commitOid)),
    command("checkout-commit", "commits", "cmd.checkoutCommit", t("cmd.checkoutCommitDetail"), commitReady, () => run.checkoutCommit(commitOid)),
    command("reset-to-commit", "commits", "cmd.resetToCommit", t("cmd.resetToCommitDetail"), firstReason(commitReady, !input.hasBranches && t("cmd.why.noBranches")), () => run.resetToCommit(commitOid)),
    command("branch-at-head", "branches", "cmd.branchAtHead", t("cmd.branchAtHeadDetail"), firstReason(gitReady, !head && t("cmd.why.noHead")), () => { if (head) run.createBranchAt(head); }),
    command("rename-branch", "branches", "cmd.renameBranch", t("cmd.renameBranchDetail"), firstReason(gitReady, repository?.detached && t("cmd.why.detached"), !repository?.branch && t("cmd.why.detached")), () => { if (repository?.branch) run.renameCurrentBranch(repository.branch); }),
    command("new-worktree", "branches", "cmd.newWorktree", t("cmd.newWorktreeDetail"), firstReason(gitReady, !head && t("cmd.why.noHead")), () => { if (head) run.newWorktreeFrom(head); }),
    command("rebase", "branches", "cmd.rebase", shortcutDetail("cmd.rebaseDetail", "rebase"), firstReason(repositoryReady, !input.hasBranches && t("cmd.why.noBranches")), run.rebase, "rebase"),
    command("reset", "branches", "cmd.reset", t("cmd.resetDetail"), firstReason(repositoryReady, !input.hasBranches && t("cmd.why.noBranches")), run.reset),
    command("merge", "commits", "cmd.merge", t("cmd.mergeDetail"), commitReady, () => run.merge(commitOid)),
    command("cherry-pick", "commits", "cmd.cherryPick", t("cmd.cherryPickDetail"), commitReady, () => run.cherryPick(commitOid), "cherryPick"),
    command("revert", "commits", "cmd.revert", t("cmd.revertDetail"), commitReady, () => run.revert(commitOid)),
    command("create-tag", "commits", "cmd.createTag", t("cmd.createTagDetail"), commitReady, () => run.createTag(commitOid), "createTag"),
    command("search-commits", "commits", "cmd.searchCommits", t("cmd.searchCommitsDetail"), firstReason(inWorkspace, !head && t("cmd.why.noHead")), () => run.searchCommits(repoId), "searchCommits"),
    command("fetch", "remote", "cmd.fetch", t("cmd.fetchDetail"), repositoryReady, run.fetch, "fetch"),
    command("pull", "remote", "cmd.pull", t("cmd.pullDetail"), repositoryReady, run.pull, "pull"),
    command("push", "remote", "cmd.push", t("cmd.pushDetail"), repositoryReady, run.push, "push"),
    command("manage-remotes", "remote", "cmd.manageRemotes", t("cmd.manageRemotesDetail"), repositoryReady, run.manageRemotes),
    command("view-changes", "view", "cmd.viewChanges", shortcutDetail("cmd.viewChangesDetail", "viewChanges"), repositoryReady, () => run.showView("changes"), "viewChanges"),
    command("view-history", "view", "cmd.viewHistory", shortcutDetail("cmd.viewHistoryDetail", "viewHistory"), repositoryReady, () => run.showView("history"), "viewHistory"),
    command("toggle-sidebar", "view", "cmd.toggleSidebar", shortcutDetail("cmd.toggleSidebarDetail", "toggleSidebar"), inWorkspace, run.toggleSidebar, "toggleSidebar"),
    command("toggle-details", "view", "cmd.toggleDetails", shortcutDetail("cmd.toggleDetailsDetail", "toggleInspector"), firstReason(inWorkspace, input.mode === "changes" && t("cmd.why.notHistory")), run.toggleInspector, "toggleInspector"),
    command("focus-mode", "view", "cmd.focus", shortcutDetail("cmd.focusDetail", "focusMode"), firstReason(inWorkspace, !input.hasDiffTarget && t("cmd.why.noDiff")), run.toggleFocusMode, "focusMode"),
    command("toggle-diff-view", "view", "cmd.toggleDiffView", t("cmd.toggleDiffViewDetail"), firstReason(inWorkspace, !input.hasDiffTarget && t("cmd.why.noDiff")), run.toggleDiffView, "toggleDiffView"),
    command("open-in-editor", "repository", "cmd.openInEditor", t("cmd.openInEditorDetail"), repositoryReady, run.openInEditor),
    command("open-in-terminal", "repository", "cmd.openInTerminal", t("cmd.openInTerminalDetail"), repositoryReady, run.openInTerminal),
    command("zoom-in", "view", "cmd.zoomIn", t("cmd.zoomInDetail"), false, run.zoomIn, "zoomIn"),
    command("zoom-out", "view", "cmd.zoomOut", t("cmd.zoomOutDetail"), false, run.zoomOut, "zoomOut"),
    command("zoom-reset", "view", "cmd.zoomReset", t("cmd.zoomResetDetail"), false, run.zoomReset, "zoomReset"),
    command("settings", "app", "cmd.settings", t("cmd.settingsDetail"), false, run.openSettings, "settings"),
    command("appearance", "app", "cmd.appearance", t("cmd.appearanceDetail"), false, run.openAppearance),
    command("theme", "app", "cmd.theme", input.themeDetail, false, run.nextTheme),
  ];
}
