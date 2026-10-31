import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useState } from "react";
import {
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
  return describeApiError(error, fallback);
}

export function useBranchSwitcher({ getApi, getRepository, refreshBranches, onTaskAccepted, openTaskCenter }: BranchSwitcherOptions) {
  const [open, setOpen] = useState(false);
  const [targetName, setTargetName] = useState("");
  /** The target is a remote-tracking branch such as origin/feature. */
  const [targetRemote, setTargetRemote] = useState(false);
  /** The target is a commit id, checked out with a detached HEAD. */
  const [targetCommit, setTargetCommit] = useState(false);
  /** The branch each repository was on when a commit checkout was reviewed, so a detached HEAD can return to it. */
  const [returnBranches, setReturnBranches] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<BranchSwitchPreflightResponse>();
  const [error, setError] = useState<DisplayError>("");
  const [busy, setBusy] = useState(false);

  function openSwitcher() {
    const repository = getRepository();
    if (!repository || repository.availability !== "available") return;
    setTargetName("");
    setTargetRemote(false);
    setTargetCommit(false);
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
    setTargetCommit(false);
    setPreflight(undefined);
    setError("");
  }

  async function inspect(name: string, remote = false, commit = false) {
    const api = getApi();
    const repository = getRepository();
    if (!api || !repository) return;
    setTargetName(name);
    setTargetRemote(remote);
    setTargetCommit(commit);
    if (commit && repository.branch) setReturnBranches((current) => ({ ...current, [repository.repoId]: repository.branch! }));
    setPreflight(undefined);
    setError("");
    setBusy(true);
    try {
      setPreflight(await api.preflightRepositoryBranchSwitch(repository.repoId, name, remote, commit));
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
      const nextPreflight = await api.preflightRepositoryBranchSwitch(repository.repoId, targetName, targetRemote, targetCommit);
      setPreflight(nextPreflight);
      if (nextPreflight.potentiallyOverwrittenPaths.length > 0) return;
      onTaskAccepted(await api.switchRepositoryBranch(repository.repoId, targetName, targetRemote, targetCommit));
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

  /** Opens the switcher on a commit, ready to review the checkout. */
  function checkoutCommit(oid: string) {
    openSwitcher();
    void inspect(oid, false, true);
  }

  function reviewAfterShelf(target: string, remote: boolean, nextPreflight: BranchSwitchPreflightResponse, message: string, commit = false) {
    setTargetName(target);
    setTargetRemote(remote);
    setTargetCommit(commit);
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
    targetCommit,
    returnBranches,
    preflight,
    error,
    setError,
    busy,
    openSwitcher,
    close,
    chooseAnother,
    inspect,
    checkoutCommit,
    continueSwitch,
    createBranch,
    reviewAfterShelf,
    runWhileBusy,
  };
}
