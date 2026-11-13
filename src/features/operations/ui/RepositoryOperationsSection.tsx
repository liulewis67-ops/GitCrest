import { useEffect, useRef } from "react";
import type { GitCrestApiClient, OperationActionKind, OperationRecoveryResponse, RepoId } from "../../../api/client";
import { useRepositoryOperations } from "../model/use-repository-operations";
import { OperationRecoveryList } from "./OperationRecoveryList";

/** Self-contained recovery section for one repository; renders nothing while it has no active operations. */
export function RepositoryOperationsSection({ api, repoId }: { api: GitCrestApiClient; repoId: RepoId }) {
  const { operations, error, submitting, refresh, submitAction } = useRepositoryOperations(() => api, repoId);
  // One id per (operation, version, kind): a retry after a lost response replays instead of repeating.
  const requestIds = useRef(new Map<string, string>());
  useEffect(() => { void refresh(); }, [api, repoId]);

  function submit(operation: OperationRecoveryResponse, kind: OperationActionKind) {
    const key = `${operation.operationId}:${operation.version}:${kind}`;
    let requestId = requestIds.current.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      requestIds.current.set(key, requestId);
    }
    void submitAction(operation, kind, requestId);
  }

  return <OperationRecoveryList operations={operations} error={error} submitting={submitting} onSubmit={submit} />;
}
