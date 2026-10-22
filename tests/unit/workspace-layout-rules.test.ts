import { describe, expect, it } from "vitest";
import { isComposerVisible } from "../../src/features/commits/model/composer-visibility";
import { buildChangeTree, listReviewableFiles, reconcileWorkingSelection, summarizeRepositoryStatus } from "../../src/features/changes/model/repository-status-summary";
import { DEFAULT_PANEL_PREFERENCES, readPanelPreferences } from "../../src/features/repositories/model/use-panel-preferences";
import type { StatusSnapshotResponse } from "../../src/api/client";

const base = { inChangesView: true, statusReady: true, stagedCount: 0, workingCount: 0, draft: "", amend: false };

describe("isComposerVisible", () => {
  it("hides the commit form for a clean working tree and outside the Changes view", () => {
    expect(isComposerVisible(base)).toBe(false);
    expect(isComposerVisible({ ...base, inChangesView: false, stagedCount: 2 })).toBe(false);
    expect(isComposerVisible({ ...base, statusReady: false, stagedCount: 2 })).toBe(false);
  });

  it("shows it while there is anything to commit", () => {
    expect(isComposerVisible({ ...base, workingCount: 3 })).toBe(true);
    expect(isComposerVisible({ ...base, stagedCount: 1 })).toBe(true);
    expect(isComposerVisible({ ...base, amend: true })).toBe(true);
  });

  it("keeps a draft visible after the tree becomes clean so it is never lost from view", () => {
    expect(isComposerVisible({ ...base, draft: "unfinished message" })).toBe(true);
    expect(isComposerVisible({ ...base, draft: "   " })).toBe(false);
  });
});

function snapshot(files: Array<{ path: string; categories: StatusSnapshotResponse["files"][number]["categories"]; kind?: StatusSnapshotResponse["files"][number]["kind"] }>): StatusSnapshotResponse {
  return { repoId: "repo", refreshedAtMs: 1, files: files.map((file) => ({ path: file.path, indexStatus: ".", worktreeStatus: "M", kind: file.kind ?? "modified", categories: file.categories, modeChanged: false })) };
}

describe("change tree", () => {
  const status = snapshot([
    { path: "a.txt", categories: ["unstaged"] },
    { path: "b.txt", categories: ["conflicted"], kind: "conflicted" },
    { path: "c.log", categories: ["ignored"], kind: "ignored" },
    { path: "d.txt", categories: ["staged", "unstaged"] },
    { path: "e.txt", categories: ["staged"], kind: "added" },
    { path: "new.txt", categories: ["untracked"], kind: "untracked" },
  ]);

  it("puts tracked changes in one group whatever their index state, apart from unversioned files", () => {
    const groups = buildChangeTree(status);
    const byId = Object.fromEntries(groups.map((group) => [group.id, group.files.map(({ file, stage }) => `${file.path}:${stage}`)]));
    expect(groups.map((group) => group.id)).toEqual(["conflicts", "changes", "unversioned", "ignored"]);
    expect(byId).toEqual({
      conflicts: ["b.txt:unstaged"],
      changes: ["a.txt:unstaged", "d.txt:partial", "e.txt:staged"],
      unversioned: ["new.txt:unstaged"],
      ignored: ["c.log:unstaged"],
    });
    expect(summarizeRepositoryStatus(status).conflictCount).toBe(1);
  });

  it("lists reviewable files in panel order with the diffs each one has", () => {
    expect(listReviewableFiles(buildChangeTree(status)).map((file) => `${file.path}:${file.scopes.join("+")}`)).toEqual([
      "b.txt:workingTree", "a.txt:workingTree", "d.txt:workingTree+index", "e.txt:index", "new.txt:workingTree",
    ]);
  });

  it("keeps a valid selection, follows a file once it is staged or unstaged, and falls back or clears", () => {
    const files = listReviewableFiles(buildChangeTree(snapshot([
      { path: "a.txt", categories: ["unstaged"] },
      { path: "b.txt", categories: ["staged"] },
      { path: "c.txt", categories: ["staged", "unstaged"] },
    ])));
    expect(reconcileWorkingSelection(files, { path: "a.txt", scope: "workingTree" })).toEqual({ path: "a.txt", scope: "workingTree" });
    expect(reconcileWorkingSelection(files, { path: "b.txt", scope: "workingTree" })).toEqual({ path: "b.txt", scope: "index" });
    expect(reconcileWorkingSelection(files, { path: "c.txt", scope: "index" })).toEqual({ path: "c.txt", scope: "index" });
    expect(reconcileWorkingSelection(files, { path: "gone.txt", scope: "index" })).toEqual({ path: "a.txt", scope: "workingTree" });
    expect(reconcileWorkingSelection(files, undefined)).toEqual({ path: "a.txt", scope: "workingTree" });
    expect(reconcileWorkingSelection([], { path: "a.txt", scope: "workingTree" })).toBeUndefined();
  });
});

describe("readPanelPreferences", () => {
  it("defaults to a hidden History inspector and a visible Branches inspector", () => {
    expect(readPanelPreferences(null)).toEqual(DEFAULT_PANEL_PREFERENCES);
    expect(DEFAULT_PANEL_PREFERENCES.inspectorOpen).toEqual({ history: false, branches: true });
    expect(readPanelPreferences("not json")).toEqual(DEFAULT_PANEL_PREFERENCES);
  });

  it("restores saved flags and ignores anything malformed", () => {
    expect(readPanelPreferences(JSON.stringify({ sidebarHidden: { history: true, changes: "yes" }, inspectorOpen: { history: true, branches: 1 } }))).toEqual({
      sidebarHidden: { changes: false, history: true, branches: false },
      inspectorOpen: { history: true, branches: true },
    });
  });
});
