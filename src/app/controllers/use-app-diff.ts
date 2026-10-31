import { getSensitiveStagedPaths, type CommitAction } from "../../features/commits";
import { buildChangeTree, listReviewableFiles, summarizeRepositoryStatus } from "../../features/changes";
import { isFullGitObjectId } from "../../features/history";
import { hasCodeStructureSupport, useDiffViewPreferences, useRepositoryDiffQuery } from "../../features/diff";
import { useLanguageRegistry } from "../../features/languages";

import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";

export function useAppDiff(ctx: Shell & Connection & Repositories) {
  const { activeStatus, activeTabState, apiRef, mode, selectedCommit, selectedRepository } = ctx;

  const activeCommitAction: CommitAction = activeTabState?.commitAction || "commit";

  const selectedFilePath = activeTabState?.selectedFilePath;

  const selectedFileScope = activeTabState?.selectedFileScope;

  const historyFilePath = activeTabState?.selectedCommitFilePath;

  const historyFileOid = activeTabState?.selectedDiffCommitOid;

  const selectedDiffFile = (activeStatus?.files || []).find((file) => file.path === selectedFilePath);

  const { preferences: diffViewPreferences, updatePreferences: updateDiffViewPreferences } = useDiffViewPreferences();

  const { stagedCount, hasConflicts, conflictCount, workingCount } = summarizeRepositoryStatus(activeStatus);

  const changeTree = buildChangeTree(activeStatus);

  const reviewableFiles = listReviewableFiles(changeTree);

  // Each view reads its own file: Changes a working-tree or staged file, History a file of the selected commit.
  const diffTarget = mode === "changes" && selectedFilePath && selectedFileScope
    ? { path: selectedFilePath, scope: selectedFileScope, commitOid: undefined }
    : mode === "history" && historyFilePath && isFullGitObjectId(historyFileOid) && historyFileOid === selectedCommit
      ? { path: historyFilePath, scope: "commit" as const, commitOid: historyFileOid }
      : undefined;

  // The open file's status entry: when it changes (say from untracked to modified), its diff is read again.
  const diffStatusKey = diffTarget?.scope !== "commit" && selectedDiffFile
    ? [selectedDiffFile.kind, selectedDiffFile.indexStatus, selectedDiffFile.worktreeStatus, selectedDiffFile.categories.join(","), selectedDiffFile.originalPath ?? ""].join("|")
    : "";

  const diffQuery = useRepositoryDiffQuery({
    api: apiRef.current,
    enabled: Boolean(diffTarget),
    repository: selectedRepository,
    path: diffTarget?.path,
    scope: diffTarget?.scope,
    commitOid: diffTarget?.commitOid,
    context: diffViewPreferences.layout === "full" ? "full" : "hunks",
    refreshKey: diffStatusKey,
  });

  const { state: diffState, activeKey: activeDiffKey } = diffQuery;

  // The line view groups changes by code structure, which needs the complete file read after the same hunks.
  // Language plugins arrive after startup, so the registry is read here to re-render when they do.
  useLanguageRegistry();

  const hunksDocument = diffState.key === activeDiffKey && !diffState.loading ? diffState.document : undefined;

  const structureQuery = useRepositoryDiffQuery({
    api: apiRef.current,
    enabled: Boolean(diffTarget && hunksDocument?.status === "text" && diffViewPreferences.layout === "hunks" && hasCodeStructureSupport(diffTarget.path)),
    repository: selectedRepository,
    path: diffTarget?.path,
    scope: diffTarget?.scope,
    commitOid: diffTarget?.commitOid,
    context: "full",
    refreshKey: hunksDocument?.revision,
  });

  const sensitiveStagedPaths = getSensitiveStagedPaths(activeStatus);
  return { activeCommitAction, selectedFilePath, selectedFileScope, historyFilePath, historyFileOid, selectedDiffFile, diffViewPreferences, updateDiffViewPreferences, stagedCount, hasConflicts, conflictCount, workingCount, changeTree, reviewableFiles, diffTarget, diffQuery, diffState, activeDiffKey, structureQuery, sensitiveStagedPaths };
}

export type DiffArea = ReturnType<typeof useAppDiff>;
