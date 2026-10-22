import { describe, expect, it } from "vitest";
import { getComposerVisibility } from "../../src/features/commits/model/composer-visibility";
import { listReviewableFiles, reconcileWorkingSelection, summarizeRepositoryStatus } from "../../src/features/changes/model/repository-status-summary";
import { DEFAULT_PANEL_PREFERENCES, readPanelPreferences } from "../../src/features/repositories/model/use-panel-preferences";
import type { StatusSnapshotResponse } from "../../src/api/client";

const base = { inChangesView: true, statusReady: true, stagedCount: 0, workingCount: 0, draft: "", amend: false, assistantOpen: false, selectionCount: 0 };

describe("getComposerVisibility", () => {
  it("hides the composer for a clean working tree and outside the Changes view", () => {
    expect(getComposerVisibility(base)).toEqual({ visible: false, expanded: false });
    expect(getComposerVisibility({ ...base, inChangesView: false, stagedCount: 2 })).toEqual({ visible: false, expanded: false });
    expect(getComposerVisibility({ ...base, statusReady: false, stagedCount: 2 })).toEqual({ visible: false, expanded: false });
  });

  it("stays one row with only unstaged changes and expands once something is staged or written", () => {
    expect(getComposerVisibility({ ...base, workingCount: 3 })).toEqual({ visible: true, expanded: false });
    expect(getComposerVisibility({ ...base, stagedCount: 1 })).toEqual({ visible: true, expanded: true });
    expect(getComposerVisibility({ ...base, workingCount: 1, draft: "fix: typo" })).toEqual({ visible: true, expanded: true });
  });

  it("keeps a draft visible after the tree becomes clean so it is never lost from view", () => {
    expect(getComposerVisibility({ ...base, draft: "unfinished message" }).visible).toBe(true);
  });

  it("follows the user's own choice except while an option or tool needs the full form", () => {
    expect(getComposerVisibility({ ...base, stagedCount: 1, expandedOverride: false }).expanded).toBe(false);
    expect(getComposerVisibility({ ...base, workingCount: 1, expandedOverride: true }).expanded).toBe(true);
    expect(getComposerVisibility({ ...base, stagedCount: 1, amend: true, expandedOverride: false }).expanded).toBe(true);
    expect(getComposerVisibility({ ...base, stagedCount: 1, assistantOpen: true, expandedOverride: false }).expanded).toBe(true);
    expect(getComposerVisibility({ ...base, stagedCount: 1, selectionCount: 2, expandedOverride: false }).expanded).toBe(true);
  });
});

function snapshot(files: Array<{ path: string; categories: StatusSnapshotResponse["files"][number]["categories"]; kind?: StatusSnapshotResponse["files"][number]["kind"] }>): StatusSnapshotResponse {
  return { repoId: "repo", refreshedAtMs: 1, files: files.map((file) => ({ path: file.path, indexStatus: ".", worktreeStatus: "M", kind: file.kind ?? "modified", categories: file.categories, modeChanged: false })) };
}

describe("working tree selection", () => {
  it("lists conflicts first and leaves ignored files out of review", () => {
    const { groups, conflictCount } = summarizeRepositoryStatus(snapshot([
      { path: "a.txt", categories: ["unstaged"] },
      { path: "b.txt", categories: ["conflicted"], kind: "conflicted" },
      { path: "c.log", categories: ["ignored"], kind: "ignored" },
      { path: "d.txt", categories: ["staged", "unstaged"] },
    ]));
    expect(conflictCount).toBe(1);
    expect(listReviewableFiles(groups).map((file) => `${file.scope}:${file.path}`)).toEqual(["workingTree:b.txt", "index:d.txt", "workingTree:a.txt", "workingTree:d.txt"]);
  });

  it("keeps a valid selection, follows a file between staged and unstaged, and falls back or clears", () => {
    const files = listReviewableFiles(summarizeRepositoryStatus(snapshot([
      { path: "a.txt", categories: ["unstaged"] },
      { path: "b.txt", categories: ["staged"] },
    ])).groups);
    expect(reconcileWorkingSelection(files, { path: "a.txt", scope: "workingTree" })).toEqual({ path: "a.txt", scope: "workingTree" });
    expect(reconcileWorkingSelection(files, { path: "b.txt", scope: "workingTree" })).toEqual({ path: "b.txt", scope: "index" });
    expect(reconcileWorkingSelection(files, { path: "gone.txt", scope: "index" })).toEqual({ path: "b.txt", scope: "index" });
    expect(reconcileWorkingSelection(files, undefined)).toEqual({ path: "b.txt", scope: "index" });
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
