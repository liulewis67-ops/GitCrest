import { t } from "../../../shared/i18n";
import { useEffect, useState } from "react";
import type { CommitDetailResponse, GitCrestApiClient } from "../../../api/client";

function isCommitDetail(value: unknown): value is CommitDetailResponse {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<CommitDetailResponse>;
  return typeof detail.oid === "string"
    && Array.isArray(detail.parents)
    && typeof detail.authorName === "string"
    && typeof detail.authorEmail === "string"
    && typeof detail.committedAtMs === "number"
    && typeof detail.message === "string"
    && Boolean(detail.stats && typeof detail.stats.filesChanged === "number" && typeof detail.stats.insertions === "number" && typeof detail.stats.deletions === "number")
    && Array.isArray(detail.files);
}

export function useRepositoryCommitDetail(api: GitCrestApiClient, repoId: string, oid?: string) {
  const [state, setState] = useState<{ oid?: string; detail?: CommitDetailResponse; error?: string; loading: boolean }>({ loading: false });

  useEffect(() => {
    const controller = new AbortController();
    if (!oid) {
      setState({ loading: false });
      return () => controller.abort();
    }
    setState({ oid, loading: true });
    void api.withSignal(controller.signal).getRepositoryCommit(repoId, oid).then((response) => {
      if (!isCommitDetail(response)) throw new Error(t("err.commitDetailInvalid"));
      if (!controller.signal.aborted) setState({ oid, detail: response, loading: false });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setState({ oid, error: reason instanceof Error ? reason.message : t("err.commitDetail"), loading: false });
    });
    return () => controller.abort();
  }, [api, oid, repoId]);

  return state;
}
