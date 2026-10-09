import { useEffect, useRef, useState } from "react";
import { GitCrestApiError, type BranchSnapshotResponse, type GitCrestApiClient, type RemoteSnapshotResponse } from "../../../api/client";

interface RepositoryRefsOptions {
  getApi: () => GitCrestApiClient | undefined;
  isRepositoryOpen: (repoId: string) => boolean;
  getCacheGeneration: (repoId: string) => number;
  beginCacheRequest: (repoId: string) => number;
  finishCacheRequest: (repoId: string) => void;
}

function withoutRecordKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export function useRepositoryRefs({
  getApi,
  isRepositoryOpen,
  getCacheGeneration,
  beginCacheRequest,
  finishCacheRequest,
}: RepositoryRefsOptions) {
  const [branches, setBranches] = useState<Record<string, BranchSnapshotResponse>>({});
  const [branchErrors, setBranchErrors] = useState<Record<string, string>>({});
  const [branchLoadingByRepo, setBranchLoadingByRepo] = useState<Record<string, boolean>>({});
  const [remotes, setRemotes] = useState<Record<string, RemoteSnapshotResponse>>({});
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  const [remoteLoadingByRepo, setRemoteLoadingByRepo] = useState<Record<string, boolean>>({});
  const controllersByRepoRef = useRef(new Map<string, Set<AbortController>>());

  useEffect(() => () => {
    for (const controllers of controllersByRepoRef.current.values()) {
      for (const controller of controllers) controller.abort();
    }
    controllersByRepoRef.current.clear();
  }, []);

  function createController(repoId: string) {
    const controller = new AbortController();
    const controllers = controllersByRepoRef.current.get(repoId) || new Set<AbortController>();
    controllers.add(controller);
    controllersByRepoRef.current.set(repoId, controllers);
    return controller;
  }

  function releaseController(repoId: string, controller: AbortController) {
    const controllers = controllersByRepoRef.current.get(repoId);
    controllers?.delete(controller);
    if (controllers?.size === 0) controllersByRepoRef.current.delete(repoId);
  }

  async function refreshBranches(repoId: string) {
    if (!isRepositoryOpen(repoId)) return;
    const api = getApi();
    if (!api) return;
    const controller = createController(repoId);
    const requestGeneration = beginCacheRequest(repoId);
    setBranchLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setBranchErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const snapshot = await api.withSignal(controller.signal).getRepositoryBranches(repoId);
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setBranches((current) => ({ ...current, [repoId]: snapshot }));
      }
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      if (!controller.signal.aborted && isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setBranchErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not read repository branches.") }));
      }
    } finally {
      releaseController(repoId, controller);
      setBranchLoadingByRepo((current) => isRepositoryOpen(repoId)
        ? { ...current, [repoId]: false }
        : withoutRecordKey(current, repoId));
      finishCacheRequest(repoId);
    }
  }

  async function refreshRemotes(repoId: string) {
    if (!isRepositoryOpen(repoId)) return;
    const api = getApi();
    if (!api) return;
    const controller = createController(repoId);
    const requestGeneration = beginCacheRequest(repoId);
    setRemoteLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setRemoteErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const snapshot = await api.withSignal(controller.signal).getRepositoryRemotes(repoId);
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setRemotes((current) => ({ ...current, [repoId]: snapshot }));
      }
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      if (!controller.signal.aborted && isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setRemoteErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not read repository remotes.") }));
      }
    } finally {
      releaseController(repoId, controller);
      setRemoteLoadingByRepo((current) => isRepositoryOpen(repoId)
        ? { ...current, [repoId]: false }
        : withoutRecordKey(current, repoId));
      finishCacheRequest(repoId);
    }
  }

  async function toggleFavorite(repoId: string | undefined, fullName: string, favorite: boolean) {
    const api = getApi();
    if (!api || !repoId) return;
    const requestGeneration = beginCacheRequest(repoId);
    try {
      const snapshot = await api.setRepositoryBranchFavorite(repoId, fullName, !favorite);
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setBranches((current) => ({ ...current, [repoId]: snapshot }));
      }
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setBranchErrors((current) => ({
          ...current,
          [repoId]: message || (error instanceof Error ? error.message : "Could not update branch favorite."),
        }));
      }
    } finally {
      finishCacheRequest(repoId);
    }
  }

  function setRemoteError(repoId: string, message: string) {
    setRemoteErrors((current) => ({ ...current, [repoId]: message }));
  }

  function clear(repoId: string) {
    for (const controller of controllersByRepoRef.current.get(repoId) || []) controller.abort();
    controllersByRepoRef.current.delete(repoId);
    setBranches((current) => withoutRecordKey(current, repoId));
    setBranchErrors((current) => withoutRecordKey(current, repoId));
    setBranchLoadingByRepo((current) => withoutRecordKey(current, repoId));
    setRemotes((current) => withoutRecordKey(current, repoId));
    setRemoteErrors((current) => withoutRecordKey(current, repoId));
    setRemoteLoadingByRepo((current) => withoutRecordKey(current, repoId));
  }

  return {
    branches,
    branchErrors,
    branchLoadingByRepo,
    remotes,
    remoteErrors,
    remoteLoadingByRepo,
    refreshBranches,
    refreshRemotes,
    toggleFavorite,
    setRemoteError,
    clear,
  };
}
