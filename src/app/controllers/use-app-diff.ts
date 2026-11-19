import { useEffect, useState } from "react";
import { getSensitiveStagedPaths, type CommitAction } from "../../features/commits";
import { buildChangeTree, listReviewableFiles, summarizeRepositoryStatus } from "../../features/changes";
import { isFullGitObjectId } from "../../features/history";
import { hasCodeStructureSupport, useDiffViewPreferences, useRepositoryDiffQuery } from "../../features/diff";
import { useLanguageRegistry } from "../../features/languages";

import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";

type DiffTarget = { path: string; scope: "workingTree" | "index" | "commit"; commitOid?: string; shelfId?: string };

export function useAppDiff(ctx: Shell & Connection & Repositories) {
  const { activeStatus, activeTabState, apiRef, commitPanelTab, mode, selectedCommit, selectedRepository } = ctx;
  const [savedFile, setSavedFile] = useState<{ repoId: string; path: string } & (
    { tab: "stash"; commitOid: string; shelfId?: never } |
    { tab: "shelves"; shelfId: string; commitOid?: never }
  )>();
  const repoId = selectedRepository?.repoId;

  useEffect(() => {
    setSavedFile(undefined);
  }, [repoId, mode, commitPanelTab]);

  function openStashFile(path: string, oid: string) {
    if (repoId && isFullGitObjectId(oid)) setSavedFile({ repoId, path, tab: "stash", commitOid: oid });
  }

  function openShelfFile(path: string, shelfId: string) {
    if (repoId) setSavedFile({ repoId, path, tab: "shelves", shelfId });
  }

  function closeSavedFile() {
    setSavedFile(undefined);
  }
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

  const openedSavedFile = savedFile?.tab === commitPanelTab && savedFile.repoId === repoId ? savedFile : undefined;
  const workingDiff = selectedFilePath && selectedFileScope
    ? { path: selectedFilePath, scope: selectedFileScope, commitOid: undefined }
    : undefined;
  const changesDiff = commitPanelTab === "commit" ? workingDiff : openedSavedFile && {
    path: openedSavedFile.path,
    scope: "commit" as const,
    commitOid: openedSavedFile.commitOid,
    shelfId: openedSavedFile.shelfId,
  };
  const diffTarget: DiffTarget | undefined = mode === "changes"
    ? changesDiff
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
    shelfId: diffTarget?.shelfId,
    context: !diffTarget?.shelfId && diffViewPreferences.layout === "full" ? "full" : "hunks",
    refreshKey: diffStatusKey,
  });

  const { state: diffState, activeKey: activeDiffKey } = diffQuery;

  // The line view groups changes by code structure, which needs the complete file read after the same hunks.
  // Language plugins arrive after startup, so the registry is read here to re-render when they do.
  useLanguageRegistry();

  const hunksDocument = diffState.key === activeDiffKey && !diffState.loading ? diffState.document : undefined;

  const structureQuery = useRepositoryDiffQuery({
    api: apiRef.current,
    enabled: Boolean(diffTarget && !diffTarget.shelfId && hunksDocument?.status === "text" && diffViewPreferences.layout === "hunks" && hasCodeStructureSupport(diffTarget.path)),
    repository: selectedRepository,
    path: diffTarget?.path,
    scope: diffTarget?.scope,
    commitOid: diffTarget?.commitOid,
    context: "full",
    refreshKey: hunksDocument?.revision,
  });

  const sensitiveStagedPaths = getSensitiveStagedPaths(activeStatus);
  return { activeCommitAction, selectedFilePath, selectedFileScope, historyFilePath, historyFileOid, selectedDiffFile, diffViewPreferences, updateDiffViewPreferences, stagedCount, hasConflicts, conflictCount, workingCount, changeTree, reviewableFiles, openStashFile, openShelfFile, closeSavedFile, openedSavedFile, diffTarget, diffQuery, diffState, activeDiffKey, structureQuery, sensitiveStagedPaths };
}

export type DiffArea = ReturnType<typeof useAppDiff>;
