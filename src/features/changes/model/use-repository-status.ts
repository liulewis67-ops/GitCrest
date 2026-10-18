import { t } from "../../../shared/i18n";
import { useEffect, useRef, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type StatusSnapshotResponse } from "../../../api/client";
import { mergeStatusScope } from "../../../api/status-snapshot";

type PendingStatusRefresh = { full: boolean; forceRefresh: boolean; paths: Set<string> };

interface RepositoryStatusOptions {
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

export function useRepositoryStatus({
  getApi,
  isRepositoryOpen,
  getCacheGeneration,
  beginCacheRequest,
  finishCacheRequest,
}: RepositoryStatusOptions) {
  const [snapshots, setSnapshots] = useState<Record<string, StatusSnapshotResponse>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loadingByRepo, setLoadingByRepo] = useState<Record<string, boolean>>({});
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;
  const pendingRefreshesRef = useRef(new Map<string, PendingStatusRefresh>());
  const activeRefreshesRef = useRef(new Set<string>());
  const controllersByRepoRef = useRef(new Map<string, AbortController>());

  useEffect(() => () => {
    for (const controller of controllersByRepoRef.current.values()) controller.abort();
    controllersByRepoRef.current.clear();
  }, []);

  async function refreshScope(repoId: string, full: boolean, paths: string[] = [], forceRefresh = false) {
    if (!isRepositoryOpen(repoId)) return;
    const pending = pendingRefreshesRef.current.get(repoId) || { full: false, forceRefresh: false, paths: new Set<string>() };
    pending.forceRefresh ||= forceRefresh;
    if (full || paths.length === 0) {
      pending.full = true;
      pending.paths.clear();
    } else if (!pending.full) {
      for (const path of paths) pending.paths.add(path);
      if (pending.paths.size > 256) {
        pending.full = true;
        pending.paths.clear();
      }
    }
    pendingRefreshesRef.current.set(repoId, pending);
    if (activeRefreshesRef.current.has(repoId)) return;

    const api = getApi();
    if (!api) return;
    activeRefreshesRef.current.add(repoId);
    const controller = new AbortController();
    controllersByRepoRef.current.set(repoId, controller);
    let requestGeneration = beginCacheRequest(repoId);
    setLoadingByRepo((current) => ({ ...current, [repoId]: true }));
    setErrors((current) => ({ ...current, [repoId]: "" }));
    try {
      while (pendingRefreshesRef.current.has(repoId)) {
        const requested = pendingRefreshesRef.current.get(repoId)!;
        pendingRefreshesRef.current.delete(repoId);
        requestGeneration = getCacheGeneration(repoId);
        if (controller.signal.aborted) break;
        const useFull = requested.full || !snapshotsRef.current[repoId] || requested.paths.size === 0;
        const snapshot = useFull
          ? await api.withSignal(controller.signal).getRepositoryStatus(repoId, requested.forceRefresh)
          : await api.withSignal(controller.signal).getRepositoryStatusPaths(repoId, [...requested.paths]);
        if (!isRepositoryOpen(repoId) || getCacheGeneration(repoId) !== requestGeneration) continue;
        const next = !useFull && snapshotsRef.current[repoId]
          ? mergeStatusScope(snapshotsRef.current[repoId]!, snapshot, [...requested.paths])
          : snapshot;
        snapshotsRef.current = { ...snapshotsRef.current, [repoId]: next };
        setSnapshots((current) => ({ ...current, [repoId]: next }));
      }
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      if (!controller.signal.aborted && isRepositoryOpen(repoId) && getCacheGeneration(repoId) === requestGeneration) {
        setErrors((current) => ({ ...current, [repoId]: message || (error instanceof Error ? error.message : t("err.refreshStatus")) }));
      }
    } finally {
      activeRefreshesRef.current.delete(repoId);
      if (controllersByRepoRef.current.get(repoId) === controller) controllersByRepoRef.current.delete(repoId);
      setLoadingByRepo((current) => isRepositoryOpen(repoId)
        ? { ...current, [repoId]: false }
        : withoutRecordKey(current, repoId));
      finishCacheRequest(repoId);
      if (pendingRefreshesRef.current.has(repoId)) {
        const next = pendingRefreshesRef.current.get(repoId)!;
        void refreshScope(repoId, next.full, [...next.paths], next.forceRefresh);
      }
    }
  }

  function clear(repoId: string) {
    controllersByRepoRef.current.get(repoId)?.abort();
    snapshotsRef.current = withoutRecordKey(snapshotsRef.current, repoId);
    pendingRefreshesRef.current.delete(repoId);
    setSnapshots((current) => withoutRecordKey(current, repoId));
    setErrors((current) => withoutRecordKey(current, repoId));
    setLoadingByRepo((current) => withoutRecordKey(current, repoId));
  }

  return {
    snapshots,
    errors,
    loadingByRepo,
    refreshScope,
    refresh: (repoId: string, forceRefresh = false) => refreshScope(repoId, true, [], forceRefresh),
    clear,
  };
}
