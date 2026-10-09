import type { StatusSnapshotResponse } from "../../../api/client";

export interface RepositoryStatusGroup {
  category: "staged" | "unstaged" | "untracked" | "conflicted" | "ignored";
  label: string;
  files: StatusSnapshotResponse["files"];
}

const CHANGE_GROUPS = [
  { category: "staged", label: "Staged" },
  { category: "unstaged", label: "Unstaged" },
  { category: "untracked", label: "Untracked" },
  { category: "conflicted", label: "Conflicted" },
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
  let hasConflicts = false;

  for (const file of files) {
    if (file.categories.includes("staged")) stagedCount += 1;
    if (file.categories.some((category) => category === "unstaged" || category === "untracked" || category === "conflicted")) {
      workingCount += 1;
    }
    if (file.categories.includes("conflicted")) hasConflicts = true;
  }

  return { groups, stagedCount, workingCount, hasConflicts };
}
