import type { StatusSnapshotResponse } from "../../../api/client";

export interface RepositoryStatusGroup {
  category: "staged" | "unstaged" | "untracked" | "conflicted" | "ignored";
  label: string;
  files: StatusSnapshotResponse["files"];
}

// Conflicts lead: nothing else can be staged or committed until they are resolved.
const CHANGE_GROUPS = [
  { category: "conflicted", label: "Conflicted" },
  { category: "staged", label: "Staged" },
  { category: "unstaged", label: "Unstaged" },
  { category: "untracked", label: "Untracked" },
  { category: "ignored", label: "Ignored" },
] as const satisfies ReadonlyArray<Pick<RepositoryStatusGroup, "category" | "label">>;

export function summarizeRepositoryStatus(snapshot?: StatusSnapshotResponse) {
  const files = snapshot?.files || [];
  const groups: RepositoryStatusGroup[] = CHANGE_GROUPS.map((group) => ({
    ...group,
    files: files.filter((file) => file.categories.includes(group.category)),
  }));
  let stagedCount = 0;
  let workingCount = 0;
  let conflictCount = 0;

  for (const file of files) {
    if (file.categories.includes("staged")) stagedCount += 1;
    if (file.categories.some((category) => category === "unstaged" || category === "untracked" || category === "conflicted")) {
      workingCount += 1;
    }
    if (file.categories.includes("conflicted")) conflictCount += 1;
  }

  return { groups, stagedCount, workingCount, conflictCount, hasConflicts: conflictCount > 0 };
}

export type WorkingFileSelection = { path: string; scope: "workingTree" | "index" };
export type ReviewableFile = WorkingFileSelection & { kind: StatusSnapshotResponse["files"][number]["kind"] };

/** Files in the order the Changes list shows them, each with the diff scope its row opens. Ignored files are not reviewable. */
export function listReviewableFiles(groups: RepositoryStatusGroup[]): ReviewableFile[] {
  return groups
    .filter((group) => group.category !== "ignored")
    .flatMap((group) => group.files.map((file) => ({ path: file.path, kind: file.kind, scope: group.category === "staged" ? "index" as const : "workingTree" as const })));
}

/**
 * Keeps the Changes selection pointing at a file that still exists after a status refresh:
 * the same file in its new group when it was staged or unstaged, otherwise the first file,
 * or nothing once the working tree is clean.
 */
export function reconcileWorkingSelection(files: ReviewableFile[], selected?: WorkingFileSelection): WorkingFileSelection | undefined {
  if (selected && files.some((file) => file.path === selected.path && file.scope === selected.scope)) return selected;
  const samePath = selected && files.find((file) => file.path === selected.path);
  if (samePath) return { path: samePath.path, scope: samePath.scope };
  const first = files[0];
  return first ? { path: first.path, scope: first.scope } : undefined;
}
