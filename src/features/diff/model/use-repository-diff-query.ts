import { useEffect, useState } from "react";
import { GitCrestApiError, type DiffDocumentResponse, type GitCrestApiClient, type RepositoryResponse } from "../../../api/client";
import type { WorkspaceMode } from "../../repositories";

export type RepositoryDiffQueryState = {
  key: string;
  loading: boolean;
  document?: DiffDocumentResponse;
  error?: string;
};

type Options = {
  api?: GitCrestApiClient;
  mode: WorkspaceMode;
  repository?: RepositoryResponse;
  path?: string;
  scope?: "workingTree" | "index" | "commit";
  commitOid?: string;
};

export function useRepositoryDiffQuery({ api, mode, repository, path, scope, commitOid }: Options) {
  const [state, setState] = useState<RepositoryDiffQueryState>({ key: "", loading: false });
  const [retryVersion, setRetryVersion] = useState(0);
  const key = repository && path && scope
    ? `${repository.repoId}:${scope}:${commitOid || ""}:${path}`
    : "";

  useEffect(() => {
    if (mode !== "diff" || !repository || !path || !scope) {
      setState({ key: "", loading: false });
      return;
    }
    if (!api) return;

    let active = true;
    const requestKey = `${repository.repoId}:${scope}:${commitOid || ""}:${path}`;
    setState({ key: requestKey, loading: true });
    const request = scope === "commit" && commitOid
      ? api.getRepositoryCommitDiff(repository.repoId, commitOid, path)
      : scope === "workingTree" || scope === "index"
        ? api.getFileDiff(repository.repoId, path, scope)
        : Promise.reject(new Error("The selected commit diff is unavailable."));
    request
      .then((document) => { if (active) setState({ key: requestKey, loading: false, document }); })
      .catch((error: unknown) => {
        const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
        if (active) setState({ key: requestKey, loading: false, error: message || (error instanceof Error ? error.message : "Could not read this file diff.") });
      });
    return () => { active = false; };
  }, [mode, repository?.repoId, path, scope, commitOid, retryVersion, api]);

  function retry() {
    setRetryVersion((current) => current + 1);
  }

  function setWindowError(error: unknown) {
    setState((current) => ({
      ...current,
      loading: false,
      error: error instanceof Error ? error.message : "Could not open the Diff window.",
    }));
  }

  return { state, activeKey: key, retry, setWindowError };
}
