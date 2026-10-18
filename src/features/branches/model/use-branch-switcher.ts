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
  const [preflight, setPreflight] = useState<BranchSwitchPreflightResponse>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function openSwitcher() {
    const repository = getRepository();
    if (!repository || repository.availability !== "available") return;
    setTargetName("");
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
    setPreflight(undefined);
    setError("");
  }

  async function inspect(name: string) {
    const api = getApi();
    const repository = getRepository();
    if (!api || !repository) return;
    setTargetName(name);
    setPreflight(undefined);
    setError("");
    setBusy(true);
    try {
      setPreflight(await api.preflightRepositoryBranchSwitch(repository.repoId, name));
    } catch (reason) {
      setError(errorMessage(reason, "Could not check this branch switch."));
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
      const nextPreflight = await api.preflightRepositoryBranchSwitch(repository.repoId, targetName);
      setPreflight(nextPreflight);
      if (nextPreflight.potentiallyOverwrittenPaths.length > 0) return;
      onTaskAccepted(await api.switchRepositoryBranch(repository.repoId, targetName));
      close();
      openTaskCenter();
    } catch (reason) {
      setError(errorMessage(reason, "Could not switch branches."));
    } finally {
      setBusy(false);
    }
  }

  async function createBranch(name: string) {
    const api = getApi();
    const repository = getRepository();
    const trimmed = name.trim();
    if (!api || !repository || !trimmed) return;
    setBusy(true);
    setError("");
    try {
      onTaskAccepted(await api.createRepositoryBranch(repository.repoId, trimmed));
      close();
      openTaskCenter();
    } catch (reason) {
      setError(errorMessage(reason, "Could not create this branch."));
    } finally {
      setBusy(false);
    }
  }

  function reviewAfterShelf(target: string, nextPreflight: BranchSwitchPreflightResponse, message: string) {
    setTargetName(target);
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
