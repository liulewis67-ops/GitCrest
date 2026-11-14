import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useState } from "react";
import { withPreservedChanges } from "../../shelves";
import { isOperationFlowEnabled } from "../../../shared/preferences/operation-flow";
import { startOperation } from "../../operations";
import { getBranchChangePolicy, setBranchChangePolicy, type BranchChangeMode } from "../../../shared/preferences/branch-change-policy";
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
  /** A durable operation was started; it waits at explicit steps the user takes in the Task Center. */
  onOperationStarted?: () => void;
  /** The opt-in is on but this core cannot run operations, so the usual flow was used instead. */
  onOperationUnavailable?: () => void;
}

function errorMessage(error: unknown, fallback: string) {
  return describeApiError(error, fallback);
}

export function useBranchSwitcher({ getApi, getRepository, refreshBranches, onTaskAccepted, onOperationStarted, onOperationUnavailable }: BranchSwitcherOptions) {
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
  const [choosingChanges, setChoosingChanges] = useState(false);

  function openSwitcher() {
    const repository = getRepository();
    if (!repository || repository.availability !== "available") return;
    setTargetName("");
    setChoosingChanges(false);
    setTargetRemote(false);
    setTargetCommit(false);
    setPreflight(undefined);
    setError("");
    setOpen(true);
    refreshBranches(repository.repoId);
  }

  function close() {
    setOpen(false);
    setChoosingChanges(false);
  }

  function chooseAnother() {
    setChoosingChanges(false);
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
    setChoosingChanges(false);
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

  async function continueSwitch(selection?: BranchChangeMode, remember = false) {
    const api = getApi();
    const repository = getRepository();
    if (!api || !repository || !targetName || busy) return;
    setBusy(true);
    setError("");
    try {
      const nextPreflight = await api.preflightRepositoryBranchSwitch(repository.repoId, targetName, targetRemote, targetCommit);
      setPreflight(nextPreflight);
      const policy = getBranchChangePolicy();
      if (!nextPreflight.isClean && nextPreflight.potentiallyOverwrittenPaths.length > 0 && policy === "ask" && !selection) {
        setChoosingChanges(true);
        setOpen(true);
        return;
      }
      const mode = selection ?? (policy === "keep" ? "keep" : "carry");
      if (selection && remember) setBranchChangePolicy(selection);
      setChoosingChanges(false);
      const preserving = mode === "keep" || nextPreflight.potentiallyOverwrittenPaths.length > 0;
      // A remote branch would first create a local one, which the operation API does not do; a commit is a detached checkout.
      if (isOperationFlowEnabled() && preserving && !targetRemote) {
        const started = await startOperation(api, repository.repoId, {
          command: targetCommit ? { kind: "checkoutDetached", targetOid: targetName } : { kind: "checkoutBranch", name: targetName },
          preservation: mode === "keep" ? "keepOnSourceBranch" : "restore",
        }, crypto.randomUUID());
        if (started.kind === "started") {
          close();
          if (started.created.task) onTaskAccepted(started.created.task);
          onOperationStarted?.();
          refreshBranches(repository.repoId);
          return;
        }
        onOperationUnavailable?.();
      }
      const switchBranch = () => api.switchRepositoryBranch(repository.repoId, targetName, targetRemote, targetCommit);
      await withPreservedChanges(api, repository.repoId, switchBranch, (task) => {
        close();
        onTaskAccepted(task);
      }, {
        keepOnSourceBranch: mode === "keep",
        saveBeforeOperation: mode === "keep" || nextPreflight.potentiallyOverwrittenPaths.length > 0,
      });
      close();
    } catch (reason) {
      setError(errorMessage(reason, t("bm.switchFailed")));
      setOpen(true);
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
    choosingChanges,
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
