// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, RepositoryResponse, StatusSnapshotResponse } from "../../src/api/client";
import { CommitPanel } from "../../src/pages/workspace/CommitPanel";
import { buildChangeTree } from "../../src/features/changes/model/repository-status-summary";
import { WorkspacePage } from "../../src/pages/workspace/WorkspacePage";
import { CommitChanges } from "../../src/features/history/ui/CommitChanges";
import { CommitActionsMenu } from "../../src/features/history/ui/CommitActionsMenu";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";

afterEach(cleanup);

const repository: RepositoryResponse = { repoId: "repo", path: "C:/repo", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };

function renderPage(overrides: Partial<Parameters<typeof WorkspacePage>[0]> = {}) {
  const handlers = {
    onChangeMode: vi.fn(), onOpenPushDialog: vi.fn(), onOpenPullDialog: vi.fn(), onFetchRepository: vi.fn(), onOpenBranchSwitcher: vi.fn(),
    onToggleSidebar: vi.fn(), onToggleInspector: vi.fn(), onOpenTasks: vi.fn(), onCreateBranchAtHead: vi.fn(), onOpenRepository: vi.fn(),
  };
  render(<WorkspacePage
    repository={repository}
    mode="changes"
    changedFileCount={3}
    conflictCount={0}
    remoteCount={1}
    currentBranch={{ name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: false, upstream: "origin/main", upstreamGone: false, ahead: 2, behind: 1 }}
    shortcuts={defaultShortcutPreferences}
    isMacPlatform={false}
    connected
    hasActiveRepositoryTask={false}
    pushDisabledReason=""
    pullDisabledReason=""
    sidebarVisible
    inspectorAvailable={false}
    inspectorOpen={false}
    focusMode={false}
    openingRepository={false}
    {...handlers}
    {...overrides}
  ><div>view</div></WorkspacePage>);
  return handlers;
}

describe("WorkspacePage", () => {
  it("offers one tab list for the task views and moves between them with arrow keys", () => {
    const { onChangeMode } = renderPage();
    const tabs = within(screen.getByRole("tablist", { name: "Workspace views" })).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Changes3", "History", "Branches"]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("workspace-tab-changes");
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(onChangeMode).toHaveBeenCalledWith("history");
    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(onChangeMode).toHaveBeenCalledWith("branches");
  });

  it("groups Fetch, Pull and Push and states incoming and outgoing commits without changing their names", () => {
    const { onOpenPullDialog } = renderPage();
    const group = screen.getByRole("group", { name: "Synchronize with remotes" });
    const pull = within(group).getByRole("button", { name: "Pull" });
    expect(pull.textContent).toBe("Pull↓1");
    expect(pull.getAttribute("title")).toContain("1 incoming commits");
    expect(within(group).getByRole("button", { name: "Push" }).getAttribute("title")).toContain("2 outgoing commits");
    fireEvent.click(pull);
    // No click event leaks into the handler: openPullDialog treats its first argument as a repository ID.
    expect(onOpenPullDialog).toHaveBeenCalledWith();
  });

  it("shows no synchronization buttons when the repository has no remotes", () => {
    renderPage({ remoteCount: 0 });
    expect(screen.queryByRole("group", { name: "Synchronize with remotes" })).toBeNull();
    expect(screen.getByText("No remotes")).toBeDefined();
  });

  it("offers the commit inspector toggle only in views that have one", () => {
    renderPage();
    expect(screen.queryByRole("button", { name: /commit details/ })).toBeNull();
    cleanup();
    const { onToggleInspector } = renderPage({ mode: "history", inspectorAvailable: true });
    fireEvent.click(screen.getByRole("button", { name: "Show commit details" }));
    expect(onToggleInspector).toHaveBeenCalledOnce();
  });

  it("keeps an in-progress operation and conflicts visible in every view", () => {
    const { onOpenTasks, onChangeMode } = renderPage({ mode: "history", repository: { ...repository, state: "rebasing" }, conflictCount: 2 });
    const banner = screen.getByText("Rebase in progress").closest(".workspaceBanner") as HTMLElement;
    expect(banner.textContent).toContain("2 conflicted files");
    fireEvent.click(within(banner).getByRole("button", { name: "Open tasks" }));
    expect(onOpenTasks).toHaveBeenCalledOnce();
    fireEvent.click(within(banner).getByRole("button", { name: "Review conflicts" }));
    expect(onChangeMode).toHaveBeenCalledWith("changes");
  });

  it("names a detached HEAD instead of a branch", () => {
    renderPage({ repository: { ...repository, branch: null, detached: true } });
    expect(screen.getByText(`Detached · ${"a".repeat(7)}`)).toBeDefined();
    expect(screen.getByText(`Detached HEAD at ${"a".repeat(7)}`)).toBeDefined();
  });

  it("hides the toolbar in focus mode", () => {
    renderPage({ focusMode: true });
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByText("view")).toBeDefined();
  });
});

describe("CommitChanges", () => {
  const oid = "b".repeat(40);
  const detail = { repoId: "repo", oid, parents: ["a".repeat(40)], authorName: "Ada", authorEmail: "ada@example.test", committedAtMs: 1, message: "Add parser\n\nDetails", stats: { filesChanged: 2, insertions: 3, deletions: 1 }, files: [{ path: "src/parser.ts", additions: 2, deletions: 1 }, { path: "README.md", additions: 1, deletions: 0 }] };
  const api = { withSignal: () => ({ getRepositoryCommit: vi.fn(async () => detail) }) } as unknown as GitCrestApiClient;

  it("opens the first file of a newly selected commit, then navigates its files", async () => {
    const onOpenFile = vi.fn();
    const renderDiff = vi.fn((_navigation?: { index: number; total: number; onNext: () => void }) => <p>diff</p>);
    const { rerender } = render(<CommitChanges api={api} repoId="repo" oid={oid} onOpenFile={onOpenFile} onOpenDiffWindow={vi.fn()} renderDiff={renderDiff} />);
    expect(await screen.findByRole("heading", { name: "Add parser" })).toBeDefined();
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("src/parser.ts", oid));

    rerender(<CommitChanges api={api} repoId="repo" oid={oid} openPath="src/parser.ts" openPathOid={oid} onOpenFile={onOpenFile} onOpenDiffWindow={vi.fn()} renderDiff={renderDiff} />);
    expect(screen.getByText("diff")).toBeDefined();
    const navigation = renderDiff.mock.calls[renderDiff.mock.calls.length - 1]?.[0];
    expect(navigation).toMatchObject({ index: 0, total: 2 });
    navigation?.onNext();
    expect(onOpenFile).toHaveBeenLastCalledWith("README.md", oid);
    fireEvent.keyDown(screen.getByRole("button", { name: "Open commit diff for src/parser.ts" }), { key: "ArrowDown" });
    expect(onOpenFile).toHaveBeenLastCalledWith("README.md", oid);
  });

  it("keeps the open file when the next commit touches it too", async () => {
    const onOpenFile = vi.fn();
    render(<CommitChanges api={api} repoId="repo" oid={oid} openPath="README.md" openPathOid={"c".repeat(40)} onOpenFile={onOpenFile} onOpenDiffWindow={vi.fn()} renderDiff={() => null} />);
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith("README.md", oid));
  });
});

describe("CommitActionsMenu", () => {
  it("keeps commit operations behind one menu and explains why they are unavailable", () => {
    const onWorkflow = vi.fn();
    const onCopySha = vi.fn();
    render(<CommitActionsMenu oid={"d".repeat(40)} workflowDisabledReason="Wait for the current repository task." onWorkflow={onWorkflow} onCreateBranch={vi.fn()} onCreateTag={vi.fn()} onCopySha={onCopySha} />);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Actions for commit ddddddd" }));
    const menu = screen.getByRole("menu");
    const revert = within(menu).getByRole("menuitem", { name: "Revert…" }) as HTMLButtonElement;
    expect(revert.disabled).toBe(true);
    expect(revert.title).toBe("Wait for the current repository task.");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy SHA" }));
    expect(onCopySha).toHaveBeenCalledWith("d".repeat(40));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and returns focus to its button", () => {
    render(<CommitActionsMenu oid={"d".repeat(40)} onWorkflow={vi.fn()} onCreateBranch={vi.fn()} onCreateTag={vi.fn()} onCopySha={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Actions for commit ddddddd" });
    fireEvent.click(button);
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});

describe("CommitPanel", () => {
  const status = {
    repoId: "repo",
    refreshedAtMs: 1,
    files: [
      { path: "src/a.ts", indexStatus: ".", worktreeStatus: "M", kind: "modified", categories: ["unstaged"], modeChanged: false },
      { path: "src/b.ts", indexStatus: "M", worktreeStatus: "M", kind: "modified", categories: ["staged", "unstaged"], modeChanged: false },
      { path: "c.ts", indexStatus: "M", worktreeStatus: ".", kind: "modified", categories: ["staged"], modeChanged: false },
      { path: "new.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked", categories: ["untracked"], modeChanged: false },
    ],
  } as StatusSnapshotResponse;

  function renderPanel(overrides: Partial<Parameters<typeof CommitPanel>[0]> = {}) {
    const handlers = { onTabChange: vi.fn(), onStageChanges: vi.fn(), onRefreshStatus: vi.fn(), onOpenFileDiff: vi.fn(), onShelve: vi.fn(), onShelfTaskSubmitted: vi.fn(), onShelfComposerClosed: vi.fn(), onShelfComposerRequestHandled: vi.fn() };
    render(<CommitPanel
      repository={repository}
      status={status}
      statusLoading={false}
      tree={buildChangeTree(status)}
      workingCount={3}
      stagedCount={2}
      hasConflicts={false}
      stagingBusy={false}
      hasActiveStagingTask={false}
      connected
      hasActiveRepositoryTask={false}
      shortcuts={defaultShortcutPreferences}
      isMacPlatform={false}
      tab="commit"
      historyRefreshKey={0}
      shelfComposerRequest={0}
      composer={<p>composer</p>}
      {...handlers}
      {...overrides}
    />);
    return handlers;
  }

  it("lists tracked changes and unversioned files with a checkbox that stages or unstages each file", () => {
    const { onStageChanges } = renderPanel();
    expect(screen.getByRole("tab", { name: "Commit" }).getAttribute("aria-selected")).toBe("true");
    const changes = screen.getByRole("region", { name: "Changes" });
    expect(within(changes).getByText("3 files")).toBeDefined();
    expect(within(screen.getByRole("region", { name: "Unversioned Files" })).getByText("1 file")).toBeDefined();
    fireEvent.click(within(changes).getByRole("checkbox", { name: "Stage src/a.ts" }));
    expect(onStageChanges).toHaveBeenLastCalledWith("stageFile", "src/a.ts");
    fireEvent.click(within(changes).getByRole("checkbox", { name: "Stage src/b.ts" }));
    expect(onStageChanges).toHaveBeenLastCalledWith("stageFile", "src/b.ts");
    fireEvent.click(within(changes).getByRole("checkbox", { name: "Stage c.ts" }));
    expect(onStageChanges).toHaveBeenLastCalledWith("unstageFile", "c.ts");
    expect(screen.getByText("composer")).toBeDefined();
  });

  it("stages a whole group in one request, and unstages it once every file is staged", () => {
    const { onStageChanges } = renderPanel();
    const groupBox = screen.getByRole("checkbox", { name: "Stage every file in Changes" }) as HTMLInputElement;
    expect(groupBox.indeterminate).toBe(true);
    fireEvent.click(groupBox);
    expect(onStageChanges).toHaveBeenLastCalledWith("stagePaths", ["src/a.ts", "src/b.ts"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Stage every file in Unversioned Files" }));
    expect(onStageChanges).toHaveBeenLastCalledWith("stagePaths", ["new.txt"]);
    cleanup();
    const staged = { ...status, files: status.files.filter((file) => file.path === "c.ts") } as StatusSnapshotResponse;
    const second = renderPanel({ status: staged, tree: buildChangeTree(staged) });
    fireEvent.click(screen.getByRole("checkbox", { name: "Stage every file in Changes" }));
    expect(second.onStageChanges).toHaveBeenLastCalledWith("unstagePaths", ["c.ts"]);
  });

  it("opens the diff a file has, and folds groups", () => {
    const { onOpenFileDiff } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "modified c.ts" }));
    expect(onOpenFileDiff).toHaveBeenLastCalledWith("c.ts", "index");
    fireEvent.click(screen.getByRole("button", { name: "modified src/b.ts" }));
    expect(onOpenFileDiff).toHaveBeenLastCalledWith("src/b.ts", "workingTree");
    fireEvent.click(screen.getByRole("button", { name: "Collapse Changes" }));
    expect(screen.queryByRole("button", { name: "modified c.ts" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Expand all" }));
    expect(screen.getByRole("button", { name: "modified c.ts" })).toBeDefined();
  });
});
