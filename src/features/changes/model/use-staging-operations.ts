import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useState } from "react";
import {
  type DiffDocumentResponse,
  type GitCrestApiClient,
  type RepositoryResponse,
  type StagingPatchRequest,
  type StagingRequest,
  type TaskSnapshotResponse,
} from "../../../api/client";

interface DiscardSelection {
  repoId: string;
  repositoryPath: string;
  path: string;
  revision: string;
  selections: Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>;
}

interface StagingOperationsOptions {
  getApi: () => GitCrestApiClient | undefined;
  repository?: RepositoryResponse;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  hasActiveRepositoryTaskForRepo: (repoId: string) => boolean;
  hasActiveStagingTask: boolean;
  document?: DiffDocumentResponse;
  appendTask: (task: TaskSnapshotResponse) => void;
  prependTask: (task: TaskSnapshotResponse) => void;
  setTaskError: (message: DisplayError) => void;
  openTaskCenter: () => void;
}

export function useStagingOperations({
  getApi,
  repository,
  connected,
  hasActiveRepositoryTask,
  hasActiveRepositoryTaskForRepo,
  hasActiveStagingTask,
  document,
  appendTask,
  prependTask,
  setTaskError,
  openTaskCenter,
}: StagingOperationsOptions) {
  const [busy, setBusy] = useState(false);
  const [discardSelection, setDiscardSelection] = useState<DiscardSelection>();

  function requestDiscard(document: DiffDocumentResponse, selections: DiscardSelection["selections"]) {
    if (document.scope !== "workingTree" || !repository || document.repoId !== repository.repoId) return;
    setTaskError("");
    setDiscardSelection({ repoId: document.repoId, repositoryPath: repository.path, path: document.path, revision: document.revision, selections });
  }

  function clearDiscardSelection() {
    setDiscardSelection(undefined);
  }

  /** `target` is one path for the file actions, or a list for stagePaths and unstagePaths. */
  async function stageChanges(action: StagingRequest["action"], target?: string | string[]) {
    const api = getApi();
    const repoId = repository?.repoId;
    if (!api || !repoId || busy || hasActiveStagingTask) return;
    setBusy(true);
    setTaskError("");
    try {
      const request: StagingRequest = { action, ...(Array.isArray(target) ? { paths: target } : target ? { path: target } : {}) };
      // Staging is quick and local: its progress shows in the titlebar, and the task center opens only if it fails.
      appendTask(await api.stageRepositoryChanges(repoId, request));
    } catch (error) {
      setTaskError(describeApiError(error, t("err.stagingStart")));
      openTaskCenter();
    } finally {
      setBusy(false);
    }
  }

  async function undoRecentOperation() {
    const api = getApi();
    if (!api || !repository || !connected || repository.availability !== "available" || hasActiveRepositoryTask) return;
    setTaskError("");
    try {
      prependTask(await api.undoRecentOperation(repository.repoId));
      openTaskCenter();
    } catch (error) {
      setTaskError(describeApiError(error, t("err.stagingUndo")));
      openTaskCenter();
    }
  }

  async function stageSelectedChanges(selections: Array<{ hunkIndex: number; rowIndex?: number; side?: "old" | "new" }>) {
    const api = getApi();
    if (!api || !repository || !document || document.scope === "commit" || busy || hasActiveStagingTask) return;
    setBusy(true);
    setTaskError("");
    try {
      const request: StagingPatchRequest = {
        action: document.scope === "index" ? "unstage" : "stage",
        path: document.path,
        scope: document.scope,
        revision: document.revision,
        selections,
      };
      appendTask(await api.stageSelectedDiffHunks(repository.repoId, request));
    } catch (error) {
      setTaskError(describeApiError(error, t("err.partialStaging")));
      openTaskCenter();
    } finally {
      setBusy(false);
    }
  }

  async function discardSelectedChanges() {
    const api = getApi();
    if (!api || !discardSelection || busy || hasActiveRepositoryTaskForRepo(discardSelection.repoId)) return;
    setBusy(true);
    setTaskError("");
    try {
      const { repoId, path, revision, selections } = discardSelection;
      const request = { path, revision, selections };
      prependTask(await api.discardSelectedDiffChanges(repoId, { ...request, confirmDiscard: true }));
      openTaskCenter();
      clearDiscardSelection();
    } catch (error) {
      setTaskError(describeApiError(error, t("err.discardStart")));
    } finally {
      setBusy(false);
    }
  }

  const hasActiveDiscardRepositoryTask = Boolean(discardSelection && hasActiveRepositoryTaskForRepo(discardSelection.repoId));
  return { busy, stageChanges, stageSelectedChanges, undoRecentOperation, discardSelection, hasActiveDiscardRepositoryTask, requestDiscard, clearDiscardSelection, discardSelectedChanges };
}
