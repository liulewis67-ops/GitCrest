import { useEffect, useState } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import { isAbsoluteFolder } from "./worktree-path";
import { t } from "../../../shared/i18n";

export type WorktreeFolderProblem = "notEmpty" | "isFile";

export function worktreeFolderProblemMessage(problem: WorktreeFolderProblem) {
  return problem === "isFile"
    ? t("wt.folderIsFile")
    : t("wt.folderNotEmpty");
}

/**
 * Asks the engine, shortly after typing stops, whether the folder can receive a new worktree. The check is a
 * convenience: when it cannot be made, creation is still validated by the engine on submit.
 */
export function useWorktreeFolderCheck(api: GitCrestApiClient | undefined, repoId: string, folder: string, enabled: boolean) {
  const [problem, setProblem] = useState<{ folder: string; value: WorktreeFolderProblem }>();

  useEffect(() => {
    const candidate = folder.trim();
    if (!api || !enabled || !candidate || !isAbsoluteFolder(candidate)) {
      setProblem(undefined);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      let request: Promise<{ status: string }>;
      try {
        request = api.withSignal(controller.signal).checkWorktreeFolder(repoId, candidate);
      } catch {
        return;
      }
      void request.then((result) => {
        if (controller.signal.aborted) return;
        setProblem(result.status === "notEmpty" || result.status === "isFile" ? { folder: candidate, value: result.status } : undefined);
      }).catch(() => {
        if (!controller.signal.aborted) setProblem(undefined);
      });
    }, 350);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, repoId, folder, enabled]);

  return problem && problem.folder === folder.trim() ? problem.value : undefined;
}
