import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useEffect, useState } from "react";
import { type DiffContext, type DiffDocumentResponse, type GitCrestApiClient, type RepositoryResponse } from "../../../api/client";

export type RepositoryDiffQueryState = {
  key: string;
  loading: boolean;
  document?: DiffDocumentResponse;
  error?: DisplayError;
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
  /** Reads again whenever this changes, e.g. the revision of a related document. */
  refreshKey?: string;
};

export function useRepositoryDiffQuery({ api, enabled, repository, path, scope, commitOid, context = "hunks", refreshKey = "" }: Options) {
  const [state, setState] = useState<RepositoryDiffQueryState>({ key: "", loading: false });
  const [retryVersion, setRetryVersion] = useState(0);
  const key = repository && path && scope
    ? `${repository.repoId}:${scope}:${commitOid || ""}:${context}:${refreshKey}:${path}`
    : "";

  useEffect(() => {
    if (!enabled || !repository || !path || !scope) {
      setState({ key: "", loading: false });
      return;
    }
    if (!api) return;

    let active = true;
    const requestKey = `${repository.repoId}:${scope}:${commitOid || ""}:${context}:${refreshKey}:${path}`;
    // Reading the same diff again keeps the current one on screen until the new one arrives.
    setState((current) => ({ key: requestKey, loading: true, document: current.key === requestKey ? current.document : undefined }));
    const request = scope === "commit" && commitOid
      ? api.getRepositoryCommitDiff(repository.repoId, commitOid, path, context)
      : scope === "workingTree" || scope === "index"
        ? api.getFileDiff(repository.repoId, path, scope, context)
        : Promise.reject(new Error(t("err.commitDiffUnavailable")));
    request
      .then((document) => { if (active) setState({ key: requestKey, loading: false, document }); })
      .catch((error: unknown) => {

        if (active) setState({ key: requestKey, loading: false, error: describeApiError(error, t("err.readDiff")) });
      });
    return () => { active = false; };
  }, [enabled, repository?.repoId, path, scope, commitOid, context, refreshKey, retryVersion, api]);

  function retry() {
    setRetryVersion((current) => current + 1);
  }

  function setWindowError(error: unknown) {
    setState((current) => ({
      ...current,
      loading: false,
      error: describeApiError(error, t("err.openDiffWindow")),
    }));
  }

  return { state, activeKey: key, retry, setWindowError };
}
