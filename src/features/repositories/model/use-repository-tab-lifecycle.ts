import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import type { RepositoryResponse } from "../../../api/client";
import type { WorkspaceSession } from "./workspace-session";

interface RepositoryTabLifecycleOptions {
  sessionRef: MutableRefObject<WorkspaceSession>;
  setSession: Dispatch<SetStateAction<WorkspaceSession>>;
  activateSessionTab: (repository: RepositoryResponse) => void;
  closeSessionTab: (session: WorkspaceSession, repoId: string) => {
    session: WorkspaceSession;
    closingActive: boolean;
    nextActiveRepoId?: string;
  };
  repositories: RepositoryResponse[];
  setSelectedRepository: Dispatch<SetStateAction<RepositoryResponse | undefined>>;
  clearOpenError: () => void;
  invalidateRepositoryUiCache: (repoId: string) => void;
  isWorkspacePage: () => boolean;
  setPage: (page: "welcome" | "workspace") => void;
}

export function useRepositoryTabLifecycle({
  sessionRef,
  setSession,
  activateSessionTab,
  closeSessionTab,
  repositories,
  setSelectedRepository,
  clearOpenError,
  invalidateRepositoryUiCache,
  isWorkspacePage,
  setPage,
}: RepositoryTabLifecycleOptions) {
  function activate(repository: RepositoryResponse) {
    clearOpenError();
    activateSessionTab(repository);
    setSelectedRepository(repository);
    setPage("workspace");
  }

  function close(repoId: string) {
    const { session, closingActive, nextActiveRepoId } = closeSessionTab(sessionRef.current, repoId);
    const nextRepository = repositories.find((repository) => repository.repoId === nextActiveRepoId);
    sessionRef.current = session;
    setSession(session);
    invalidateRepositoryUiCache(repoId);
    if (closingActive) setSelectedRepository(nextRepository);
    if (closingActive && isWorkspacePage()) setPage(nextRepository ? "workspace" : "welcome");
  }

  return { activate, close };
}
