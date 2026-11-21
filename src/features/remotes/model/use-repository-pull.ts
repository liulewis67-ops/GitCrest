import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useRef, useState } from "react";
import {
  GitCrestApiError,
  type GitCrestApiClient,
  type TaskSnapshotResponse,
} from "../../../api/client";
import type { components } from "../../../api/schema";
import { startOperation } from "../../operations";
import { withPreservedChanges } from "../../shelves";
import { isOperationFlowEnabled } from "../../../shared/preferences/operation-flow";
import { pushNotice } from "../../../shared/notices/notice-store";

type PullStrategy = components["schemas"]["PullRequest"]["strategy"];

interface RepositoryPullOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  onSelectRepository: (repoId: string) => void;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  /** A durable operation was started; it waits at explicit steps the user takes in the Task Center. */
  onOperationStarted?: () => void;
  /** The opt-in is on but this core cannot run operations, so the usual pull was used instead. */
  onOperationUnavailable?: () => void;
  refreshRepositoryStatus: (repoId: string) => void;
}

export function useRepositoryPull({
  getApi,
  repoId,
  onSelectRepository,
  onTaskAccepted,
  onOperationStarted,
  onOperationUnavailable,
  refreshRepositoryStatus,
}: RepositoryPullOptions) {
  const [open, setOpen] = useState(false);
  const [preflight, setPreflight] = useState<components["schemas"]["PullPreflight"]>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const inFlight = useRef(false);

  async function refreshPreflight(targetRepoId = repoId) {
    const api = getApi();
    if (!api || !targetRepoId) return;
    setLoading(true);
    setError("");
    try {
      setPreflight(await api.preflightRepositoryPull(targetRepoId));
    } catch (requestError) {
      setPreflight(undefined);
      setError(describeApiError(requestError, t("err.pullPreview")));
    } finally {
      setLoading(false);
    }
  }

  async function openDialog(targetRepoId = repoId, reviewOnly = false) {
    const api = getApi();
    if (!api || !targetRepoId || inFlight.current) return;
    inFlight.current = true;
    onSelectRepository(targetRepoId);
    setOpen(false);
    setPreflight(undefined);
    setError("");
    setLoading(true);
    try {
      const current = await api.preflightRepositoryPull(targetRepoId);
      setPreflight(current);
      if (current.repoId !== targetRepoId) throw new Error(t("err.pullPreview"));
      if (reviewOnly || current.hasConflicts || current.operationInProgress || current.mergeRequiresPreservation
        || (current.ahead > 0 && current.behind > 0)) {
        setOpen(true);
        return;
      }
      if (current.behind === 0) {
        pushNotice({ key: `pull-current:${targetRepoId}`, kind: "success", message: t("pull.upToDate") });
        return;
      }
      setBusy(true);
      await runPull(api, targetRepoId, current, "merge");
    } catch (requestError) {
      setError(describeApiError(requestError, t("err.pullStart")));
      setOpen(true);
    } finally {
      inFlight.current = false;
      setLoading(false);
      setBusy(false);
    }
  }

  async function runPull(api: GitCrestApiClient, targetRepoId: string, current: components["schemas"]["PullPreflight"], strategy: PullStrategy) {
    // A fast-forward needs no durable operation steps or strategy decision.
    if (isOperationFlowEnabled() && (!current.isClean || (current.ahead > 0 && current.behind > 0))) {
      const started = await startOperation(api, targetRepoId, {
        command: { kind: strategy === "merge" ? "pullMerge" : "pullRebase" }, preservation: "restore",
      }, crypto.randomUUID());
      if (started.kind === "started") {
        setOpen(false);
        if (started.created.task) onTaskAccepted(started.created.task);
        onOperationStarted?.();
        refreshRepositoryStatus(targetRepoId);
        return;
      }
      onOperationUnavailable?.();
    }
    const pull = () => api.pullRepository(targetRepoId, {
      expectedLocalOid: current.localOid, expectedTrackingOid: current.trackingOid, strategy,
    });
    const accept = (task: TaskSnapshotResponse) => { setOpen(false); onTaskAccepted(task); };
    const preserving = strategy === "rebase" ? !current.isClean : current.mergeRequiresPreservation;
    if (!preserving) { accept(await pull()); return; }
    await withPreservedChanges(api, targetRepoId, pull, accept, { saveBeforeOperation: true });
  }

  async function submit(strategy: PullStrategy) {
    const api = getApi();
    const preview = preflight;
    if (!api || !repoId || !preview || preview.repoId !== repoId || preview.hasConflicts || preview.operationInProgress || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const current = await api.preflightRepositoryPull(repoId);
      if (current.localOid !== preview.localOid || current.trackingOid !== preview.trackingOid
        || current.hasConflicts || current.operationInProgress) {
        setPreflight(current);
        return;
      }
      await runPull(api, repoId, current, strategy);
    } catch (requestError) {
      setError(describeApiError(requestError, t("err.pullStart")));
      setOpen(true);
      if (requestError instanceof GitCrestApiError && ["PULL_PREFLIGHT_STALE", "PULL_REQUIRES_CLEAN"].includes(requestError.body.error.code)) {
        void refreshPreflight(repoId);
        refreshRepositoryStatus(repoId);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return { open, setOpen, preflight, loading, busy, error, refreshPreflight, openDialog, submit };
}
