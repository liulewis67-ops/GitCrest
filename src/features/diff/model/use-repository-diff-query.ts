import { t } from "../../../shared/i18n";
import { useEffect, useState } from "react";
import { GitCrestApiError, type DiffContext, type DiffDocumentResponse, type GitCrestApiClient, type RepositoryResponse } from "../../../api/client";

export type RepositoryDiffQueryState = {
  key: string;
  loading: boolean;
  document?: DiffDocumentResponse;
  error?: string;
};

type Options = {
  api?: GitCrestApiClient;
  /** False while no view shows this diff, so nothing is requested. */
  enabled: boolean;
  repository?: RepositoryResponse;
  path?: string;
  scope?: "workingTree" | "index" | "commit";
  commitOid?: string;
  context?: DiffContext;
};

export function useRepositoryDiffQuery({ api, enabled, repository, path, scope, commitOid, context = "hunks" }: Options) {
  const [state, setState] = useState<RepositoryDiffQueryState>({ key: "", loading: false });
  const [retryVersion, setRetryVersion] = useState(0);
  const key = repository && path && scope
    ? `${repository.repoId}:${scope}:${commitOid || ""}:${context}:${path}`
    : "";

  useEffect(() => {
    if (!enabled || !repository || !path || !scope) {
      setState({ key: "", loading: false });
      return;
    }
    if (!api) return;

    let active = true;
    const requestKey = `${repository.repoId}:${scope}:${commitOid || ""}:${context}:${path}`;
    setState({ key: requestKey, loading: true });
    const request = scope === "commit" && commitOid
      ? api.getRepositoryCommitDiff(repository.repoId, commitOid, path, context)
      : scope === "workingTree" || scope === "index"
        ? api.getFileDiff(repository.repoId, path, scope, context)
        : Promise.reject(new Error(t("err.commitDiffUnavailable")));
    request
      .then((document) => { if (active) setState({ key: requestKey, loading: false, document }); })
      .catch((error: unknown) => {
        const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
        if (active) setState({ key: requestKey, loading: false, error: message || (error instanceof Error ? error.message : t("err.readDiff")) });
      });
    return () => { active = false; };
  }, [enabled, repository?.repoId, path, scope, commitOid, context, retryVersion, api]);

  function retry() {
    setRetryVersion((current) => current + 1);
  }

  function setWindowError(error: unknown) {
    setState((current) => ({
      ...current,
      loading: false,
      error: error instanceof Error ? error.message : t("err.openDiffWindow"),
    }));
  }

  return { state, activeKey: key, retry, setWindowError };
}
