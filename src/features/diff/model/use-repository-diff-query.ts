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
  shelfId?: string;
  context?: DiffContext;
  /** Reads again whenever this changes, e.g. the revision of a related document. */
  refreshKey?: string;
};

export function useRepositoryDiffQuery({ api, enabled, repository, path, scope, commitOid, shelfId, context = "hunks", refreshKey = "" }: Options) {
  const [state, setState] = useState<RepositoryDiffQueryState & { viewKey?: string }>({ key: "", loading: false });
  const [retryVersion, setRetryVersion] = useState(0);
  const key = repository && path && scope
    ? JSON.stringify([repository.repoId, scope, commitOid, shelfId, context, refreshKey, path])
    : "";
  // Staging changes the local comparison scope and status, not the editor's file.
  // Keep that editor mounted while the replacement document is read. Commit,
  // shelf, context, repository and path changes still require a fresh view.
  const viewKey = repository && path && scope
    ? JSON.stringify([repository.repoId, scope === "commit" ? scope : "local", commitOid, shelfId, context, path])
    : "";
  const visibleState = enabled && state.key !== key && state.viewKey === viewKey && state.document
    ? { key, loading: true, document: state.document }
    : state;

  useEffect(() => {
    if (!enabled || !repository || !path || !scope) {
      setState({ key: "", loading: false });
      return;
    }
    if (!api) return;

    let active = true;
    const requestKey = key;
    // Reading the same diff again keeps the current one on screen until the new one arrives.
    setState((current) => ({ key: requestKey, viewKey, loading: true, document: current.viewKey === viewKey ? current.document : undefined }));
    const request = shelfId
      ? api.getRepositoryShelfDiff(repository.repoId, shelfId, path)
      : scope === "commit" && commitOid
      ? api.getRepositoryCommitDiff(repository.repoId, commitOid, path, context)
      : scope === "workingTree" || scope === "index"
        ? api.getFileDiff(repository.repoId, path, scope, context)
        : Promise.reject(new Error(t("err.commitDiffUnavailable")));
    request
      .then((document) => { if (active) setState({ key: requestKey, viewKey, loading: false, document }); })
      .catch((error: unknown) => {

        if (active) setState({ key: requestKey, viewKey, loading: false, error: describeApiError(error, t("err.readDiff")) });
      });
    return () => { active = false; };
  }, [enabled, key, retryVersion, api]);

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

  return { state: visibleState, activeKey: key, retry, setWindowError };
}
