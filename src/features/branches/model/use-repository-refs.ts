import { useState } from "react";
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

  async function refreshBranches(repoId: string) {
    if (!isRepositoryOpen(repoId)) return;
    const api = getApi();
    if (!api) return;
    const requestGeneration = beginCacheRequest(repoId);
    setBranchLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setBranchErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const snapshot = await api.getRepositoryBranches(repoId);
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setBranches((current) => ({ ...current, [repoId]: snapshot }));
      }
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setBranchErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not read repository branches.") }));
      }
    } finally {
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
    const requestGeneration = beginCacheRequest(repoId);
    setRemoteLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setRemoteErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      const snapshot = await api.getRepositoryRemotes(repoId);
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setRemotes((current) => ({ ...current, [repoId]: snapshot }));
      }
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      if (isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setRemoteErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : "Could not read repository remotes.") }));
      }
    } finally {
      setRemoteLoadingByRepo((current) => isRepositoryOpen(repoId)
        ? { ...current, [repoId]: false }
        : withoutRecordKey(current, repoId));
      finishCacheRequest(repoId);
    }
  }

  function updateBranchSnapshot(repoId: string, snapshot: BranchSnapshotResponse) {
    setBranches((current) => ({ ...current, [repoId]: snapshot }));
  }

  function setBranchError(repoId: string, message: string) {
    setBranchErrors((current) => ({ ...current, [repoId]: message }));
  }

  function setRemoteError(repoId: string, message: string) {
    setRemoteErrors((current) => ({ ...current, [repoId]: message }));
  }

  function clear(repoId: string) {
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
    updateBranchSnapshot,
    setBranchError,
    setRemoteError,
    clear,
  };
}
