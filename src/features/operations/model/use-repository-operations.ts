import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient, OperationActionKind, OperationRecoveryResponse, RepoId } from "../../../api/client";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { buildActionSubmission } from "./operation-recovery";

/**
 * Active (non-terminal) operations of one repository, read from the backend each time: the backend owns
 * the durable state, so closing or reloading the renderer never loses a recovery in progress.
 */
export function useRepositoryOperations(getApi: () => GitCrestApiClient | undefined, repoId: RepoId | undefined) {
  const [operations, setOperations] = useState<OperationRecoveryResponse[]>([]);
  const [error, setError] = useState<DisplayError>("");
  const [submitting, setSubmitting] = useState("");
  const controllerRef = useRef<AbortController>();
  const generationRef = useRef(0);

  useEffect(() => () => {
    generationRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = undefined;
  }, []);

  async function refresh() {
    const api = getApi();
    if (!api || !repoId) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    const generation = ++generationRef.current;
    controllerRef.current = controller;
    try {
      const active = await api.withSignal(controller.signal).listActiveRepositoryOperations(repoId);
      if (!controller.signal.aborted && generationRef.current === generation) {
        setOperations(active);
        setError("");
      }
    } catch (reason) {
      if (!controller.signal.aborted && generationRef.current === generation) {
        setError(describeApiError(reason, t("err.operationList")));
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
    }
  }

  /** `requestId` should be reused for a retry of the same click so a lost response replays instead of repeating. */
  async function submitAction(operation: OperationRecoveryResponse, kind: OperationActionKind, requestId: string) {
    const api = getApi();
    if (!api || !repoId) return;
    setSubmitting(operation.operationId);
    try {
      await api.submitRepositoryOperationAction(repoId, operation.operationId, buildActionSubmission(operation, kind, requestId));
      setError("");
      await refresh();
    } catch (reason) {
      setError(describeApiError(reason, t("err.operationAction")));
    } finally {
      setSubmitting("");
    }
  }

  return { operations, error, submitting, refresh, submitAction };
}
