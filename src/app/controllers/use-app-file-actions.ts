import { describeApiError } from "../../shared/i18n/api-errors";
import { type TaskSnapshotResponse } from "../../api/client";
import { getGitCrestBridge } from "../../api/bridge";
import { notify } from "../../shared/notices/notice-store";
import { httpsHostFromRemote } from "../../shared/lib/https-remote-host";
import type { Shell } from "./use-app-shell";
import type { Connection } from "./use-app-connection";
import type { Repositories } from "./use-app-repositories";
import type { DiffArea } from "./use-app-diff";
import type { Work } from "./use-app-work";
import type { Navigation } from "./use-app-navigation";

export function useAppFileActions(ctx: Shell & Connection & Repositories & DiffArea & Work & Navigation) {
  const { apiRef, openAccountSettings, remoteSnapshots, requestDiscard, selectedRepository, setNotice, setTasksOpen, t } = ctx;

  function configureTaskCredentials(task: TaskSnapshotResponse) {
    const remotes = task.repoId ? remoteSnapshots[task.repoId]?.remotes ?? [] : [];
    const hosts = remotes.flatMap((remote) => remote.fetchUrls.map(httpsHostFromRemote).filter((host): host is string => Boolean(host)));
    setTasksOpen(false);
    openAccountSettings([...new Set(hosts)]);
  }

  /** Rollback from the file tree: the whole unstaged diff goes to the same confirmation as a hunk discard. */
  async function rollbackFile(path: string) {
    const api = apiRef.current;
    if (!api || !selectedRepository) return;
    try {
      const document = await api.getFileDiff(selectedRepository.repoId, path, "workingTree");
      if (document.status !== "text" || document.hunks.length === 0) {
        setNotice(t("ctx.rollbackNoText", { path }));
        return;
      }
      requestDiscard(document, document.hunks.map((_, hunkIndex) => ({ hunkIndex })));
    } catch (error) {
      setNotice(describeApiError(error, t("ctx.rollbackNoText", { path })));
    }
  }

  function revealFile(absolutePath: string) {
    void getGitCrestBridge()?.showItemInFolder?.(absolutePath).catch((error: unknown) => {
      setNotice(describeApiError(error));
    });
  }

  async function copyCommitSha(oid: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(oid);
      notify.success(t("hv.copied", { oid: oid.slice(0, 7) }));
    } catch {
      setNotice(t("hv.copyFailed"));
    }
  }

  async function copyBranchName(name: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(name);
      notify.success(t("bs.copiedName", { name }));
    } catch {
      setNotice(t("bs.copyNameFailed"));
    }
  }

  return { configureTaskCredentials, rollbackFile, revealFile, copyCommitSha, copyBranchName };
}

export type FileActions = ReturnType<typeof useAppFileActions>;
