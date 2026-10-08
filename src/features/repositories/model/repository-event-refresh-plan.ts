import type { GitCrestEventEnvelope } from "../../../api/bridge";

export interface RepositoryEventRefreshPlan {
  refreshRepositories: boolean;
  reportRepositoryRefreshError: boolean;
  repoId?: string;
  status?: { full: boolean; paths: string[] };
  refreshBranches: boolean;
  refreshRemotes: boolean;
  refreshHistory: boolean;
}

function refreshSelectedRepository(repoId?: string, reportRepositoryRefreshError = false): RepositoryEventRefreshPlan {
  return {
    refreshRepositories: true,
    reportRepositoryRefreshError,
    repoId,
    status: repoId ? { full: true, paths: [] } : undefined,
    refreshBranches: Boolean(repoId),
    refreshRemotes: Boolean(repoId),
    refreshHistory: Boolean(repoId),
  };
}

export function getRepositoryEventRefreshPlan(
  event: GitCrestEventEnvelope,
  sequenceGap: boolean,
  selectedRepoId: string | undefined,
  isRepositoryOpen: (repoId: string) => boolean,
): RepositoryEventRefreshPlan | undefined {
  if (sequenceGap) return refreshSelectedRepository(selectedRepoId);
  if (event.type === "connection.resyncRequired") return refreshSelectedRepository(selectedRepoId, true);

  if (event.type === "status.changed") {
    if (!event.repoId) return undefined;
    const paths = Array.isArray(event.payload.paths)
      ? event.payload.paths.filter((path): path is string => typeof path === "string")
      : [];
    return {
      refreshRepositories: false,
      reportRepositoryRefreshError: false,
      repoId: event.repoId,
      status: { full: event.payload.full === true || paths.length === 0, paths },
      refreshBranches: false,
      refreshRemotes: false,
      refreshHistory: false,
    };
  }

  if (event.type === "repository.updated") {
    if (!event.repoId) return undefined;
    return {
      refreshRepositories: true,
      reportRepositoryRefreshError: false,
      repoId: event.repoId,
      status: { full: true, paths: [] },
      refreshBranches: true,
      refreshRemotes: true,
      refreshHistory: false,
    };
  }

  if (event.type === "log.refsChanged") {
    if (!event.repoId || !isRepositoryOpen(event.repoId)) return undefined;
    return {
      refreshRepositories: false,
      reportRepositoryRefreshError: false,
      repoId: event.repoId,
      refreshBranches: true,
      refreshRemotes: false,
      refreshHistory: true,
    };
  }

  if (["task.started", "task.progress", "task.completed", "task.failed"].includes(event.type)) return undefined;
  const repoId = event.repoId || selectedRepoId;
  return {
    refreshRepositories: true,
    reportRepositoryRefreshError: false,
    repoId,
    status: repoId ? { full: true, paths: [] } : undefined,
    refreshBranches: Boolean(repoId),
    refreshRemotes: Boolean(repoId),
    refreshHistory: Boolean(repoId && isRepositoryOpen(repoId)),
  };
}
