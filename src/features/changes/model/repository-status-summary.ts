import type { StatusSnapshotResponse } from "../../../api/client";

type StatusFile = StatusSnapshotResponse["files"][number];
type DiffScope = "workingTree" | "index";

export function summarizeRepositoryStatus(snapshot?: StatusSnapshotResponse) {
  const files = snapshot?.files || [];
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

  return { stagedCount, workingCount, conflictCount, hasConflicts: conflictCount > 0 };
}

/** How much of a file's change is in the index: all of it, none of it, or some hunks. */
export type FileStageState = "staged" | "unstaged" | "partial";

export type ChangeTreeFile = {
  file: StatusFile;
  stage: FileStageState;
  /** Diffs this file has: its unstaged part, its staged part, or both. */
  scopes: DiffScope[];
};

/**
 * Groups of the Commit panel. Tracked changes share one group, whatever their index state;
 * the checkbox beside each file says whether it is staged. Files Git does not track yet
 * stay apart until they are added, and conflicts lead because they block staging.
 */
export type ChangeTreeGroup = {
  id: "conflicts" | "changes" | "unversioned" | "ignored";
  files: ChangeTreeFile[];
};

function stageState(file: StatusFile): FileStageState {
  const staged = file.categories.includes("staged");
  const unstaged = file.categories.some((category) => category === "unstaged" || category === "untracked");
  return staged && unstaged ? "partial" : staged ? "staged" : "unstaged";
}

function diffScopes(file: StatusFile): DiffScope[] {
  const scopes: DiffScope[] = [];
  if (file.categories.some((category) => category === "unstaged" || category === "untracked" || category === "conflicted")) scopes.push("workingTree");
  if (file.categories.includes("staged")) scopes.push("index");
  return scopes.length ? scopes : ["workingTree"];
}

export function buildChangeTree(snapshot?: StatusSnapshotResponse): ChangeTreeGroup[] {
  const groups: Record<ChangeTreeGroup["id"], ChangeTreeFile[]> = { conflicts: [], changes: [], unversioned: [], ignored: [] };
  for (const file of snapshot?.files || []) {
    const entry = { file, stage: stageState(file), scopes: diffScopes(file) };
    if (file.categories.includes("conflicted")) groups.conflicts.push(entry);
    else if (file.categories.includes("staged") || file.categories.includes("unstaged")) groups.changes.push(entry);
    else if (file.categories.includes("untracked")) groups.unversioned.push(entry);
    else if (file.categories.includes("ignored")) groups.ignored.push(entry);
  }
  return (["conflicts", "changes", "unversioned", "ignored"] as const).map((id) => ({ id, files: groups[id] }));
}

export type WorkingFileSelection = { path: string; scope: DiffScope };
export type ReviewableFile = { path: string; kind: StatusFile["kind"]; scopes: DiffScope[] };

/** Files in the order the Commit panel lists them. Ignored files are not reviewable. */
export function listReviewableFiles(groups: ChangeTreeGroup[]): ReviewableFile[] {
  return groups
    .filter((group) => group.id !== "ignored")
    .flatMap((group) => group.files.map(({ file, scopes }) => ({ path: file.path, kind: file.kind, scopes })));
}

/**
 * Keeps the Changes selection on a file that still exists after a status refresh: the same
 * file, switching to the diff it still has once it was staged or unstaged; otherwise the
 * first file, or nothing once the working tree is clean.
 */
export function reconcileWorkingSelection(files: ReviewableFile[], selected?: WorkingFileSelection): WorkingFileSelection | undefined {
  const same = selected && files.find((file) => file.path === selected.path);
  if (same && selected) return same.scopes.includes(selected.scope) ? selected : { path: same.path, scope: same.scopes[0] };
  const first = files[0];
  return first ? { path: first.path, scope: first.scopes[0] } : undefined;
}
