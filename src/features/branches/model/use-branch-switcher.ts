import { t } from "../../../shared/i18n";
import { useState } from "react";
import {
  GitCrestApiError,
  type BranchSwitchPreflightResponse,
  type GitCrestApiClient,
  type RepositoryResponse,
  type TaskSnapshotResponse,
} from "../../../api/client";

interface BranchSwitcherOptions {
  getApi: () => GitCrestApiClient | undefined;
  getRepository: () => RepositoryResponse | undefined;
  refreshBranches: (repoId: string) => void;
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  openTaskCenter: () => void;
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof GitCrestApiError) return error.body.error.message;
  return error instanceof Error ? error.message : fallback;
}

export function useBranchSwitcher({ getApi, getRepository, refreshBranches, onTaskAccepted, openTaskCenter }: BranchSwitcherOptions) {
  const [open, setOpen] = useState(false);
  const [targetName, setTargetName] = useState("");
  /** The target is a remote-tracking branch such as origin/feature. */
  const [targetRemote, setTargetRemote] = useState(false);
  const [preflight, setPreflight] = useState<BranchSwitchPreflightResponse>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function openSwitcher() {
    const repository = getRepository();
    if (!repository || repository.availability !== "available") return;
    setTargetName("");
    setTargetRemote(false);
    setPreflight(undefined);
    setError("");
    setOpen(true);
    refreshBranches(repository.repoId);
  }

  function close() {
    setOpen(false);
  }

  function chooseAnother() {
    setTargetName("");
    setTargetRemote(false);
    setPreflight(undefined);
    setError("");
  }

  async function inspect(name: string, remote = false) {
    const api = getApi();
    const repository = getRepository();
    if (!api || !repository) return;
    setTargetName(name);
    setTargetRemote(remote);
    setPreflight(undefined);
    setError("");
    setBusy(true);
    try {
      setPreflight(await api.preflightRepositoryBranchSwitch(repository.repoId, name, remote));
    } catch (reason) {
      setError(errorMessage(reason, t("bm.checkSwitch")));
    } finally {
      setBusy(false);
    }
  }

  async function continueSwitch() {
    const api = getApi();
    const repository = getRepository();
    if (!api || !repository || !targetName) return;
    setBusy(true);
    setError("");
    try {
      const nextPreflight = await api.preflightRepositoryBranchSwitch(repository.repoId, targetName, targetRemote);
      setPreflight(nextPreflight);
      if (nextPreflight.potentiallyOverwrittenPaths.length > 0) return;
      onTaskAccepted(await api.switchRepositoryBranch(repository.repoId, targetName, targetRemote));
      close();
      openTaskCenter();
    } catch (reason) {
      setError(errorMessage(reason, t("bm.switchFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function createBranch(name: string, options: { checkout?: boolean; worktreePath?: string } = {}) {
    const api = getApi();
    const repository = getRepository();
    const trimmed = name.trim();
    if (!api || !repository || !trimmed) return;
    setBusy(true);
    setError("");
    try {
      onTaskAccepted(await api.createRepositoryBranch(repository.repoId, trimmed, options));
      close();
      openTaskCenter();
    } catch (reason) {
      setError(errorMessage(reason, t("bm.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  function reviewAfterShelf(target: string, remote: boolean, nextPreflight: BranchSwitchPreflightResponse, message: string) {
    setTargetName(target);
    setTargetRemote(remote);
    setPreflight(nextPreflight);
    setError(message);
    setOpen(true);
  }

  async function runWhileBusy<T>(action: () => Promise<T>) {
    setBusy(true);
    try {
      return await action();
    } finally {
      setBusy(false);
    }
  }

  return {
    open,
    setOpen,
    targetName,
    targetRemote,
    preflight,
    error,
    setError,
    busy,
    openSwitcher,
    close,
    chooseAnother,
    inspect,
    continueSwitch,
    createBranch,
    reviewAfterShelf,
    runWhileBusy,
  };
}
