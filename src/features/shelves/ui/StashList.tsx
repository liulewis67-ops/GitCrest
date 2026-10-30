import { useEffect, useRef, useState } from "react";
import { GitCrestApiError, type CommitDetailResponse, type GitCrestApiClient, type StashEntryResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

type StashFile = { path: string; oid: string; untracked: boolean; additions: number | null; deletions: number | null };

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof GitCrestApiError) return error.body.error.message;
  return error instanceof Error ? error.message : fallback;
}

function formatDate(ms: number) {
  return ms > 0 ? new Date(ms).toLocaleString() : "";
}

/**
 * Entries made with `git stash`, listed beside the shelves and marked as Git stash. They are read
 * only here: each shows its changed files, and a file opens in the usual read-only diff.
 */
export function StashList({ api, repoId, refreshKey, onOpenFile }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  /** Shows one file of a stash commit in the read-only diff. */
  onOpenFile: (path: string, oid: string) => void;
}) {
  const { t } = useI18n();
  const [stashes, setStashes] = useState<StashEntryResponse[]>();
  const [error, setError] = useState("");
  const [openOid, setOpenOid] = useState<string>();
  const [files, setFiles] = useState<StashFile[]>();
  const [filesError, setFilesError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    api.withSignal(controller.signal).getRepositoryStashes(repoId)
      .then((list) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(list.stashes)) throw new Error(t("stash.loadFailed"));
        setStashes(list.stashes);
        setError("");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason, t("stash.loadFailed")));
      });
    return () => controller.abort();
  }, [api, repoId, refreshKey, attempt]);

  async function toggle(stash: StashEntryResponse) {
    if (openOid === stash.oid) {
      setOpenOid(undefined);
      return;
    }
    const request = ++requestRef.current;
    setOpenOid(stash.oid);
    setFiles(undefined);
    setFilesError("");
    try {
      const parts: Array<{ detail: CommitDetailResponse; untracked: boolean }> = [{ detail: await api.getRepositoryCommit(repoId, stash.oid), untracked: false }];
      if (stash.untrackedOid) parts.push({ detail: await api.getRepositoryCommit(repoId, stash.untrackedOid), untracked: true });
      if (request !== requestRef.current) return;
      setFiles(parts.flatMap(({ detail, untracked }) => detail.files.map((file) => ({
        path: file.path,
        oid: detail.oid,
        untracked,
        additions: file.additions,
        deletions: file.deletions,
      }))));
    } catch (reason) {
      if (request === requestRef.current) setFilesError(errorMessage(reason, t("stash.filesFailed")));
    }
  }

  // Nothing to show for a repository without stashes: shelves are the whole story there.
  if (!error && (!stashes || stashes.length === 0)) return null;
  return <section className="stashList" aria-label={t("stash.title")}>
    <div className="navGroupTitle"><span>{t("stash.title")}</span>{stashes && <span className="countBadge">{stashes.length}</span>}</div>
    <p className="cloneHelp">{t("stash.readOnlyHint")}</p>
    {error && <div className="shelfInlineError" role="alert"><span>{error}</span> <button type="button" className="textButton" onClick={() => setAttempt((value) => value + 1)}>{t("stash.retry")}</button></div>}
    {stashes?.map((stash) => {
      const open = openOid === stash.oid;
      return <div className={`shelfListItem stashItem${open ? " active" : ""}`} key={stash.oid}>
        <button className="shelfSelectButton" type="button" aria-expanded={open} aria-label={t("stash.showFiles", { name: stash.message })} onClick={() => void toggle(stash)}>
          <span className="shelfItemName" title={stash.message}>{stash.message || `stash@{${stash.index}}`}</span>
          <span className="shelfItemMeta"><span className="commitRefBadge">{t("stash.source")}</span> stash@{`{${stash.index}}`}{stash.branch ? ` · ${stash.branch}` : ""}{stash.untrackedOid ? ` · ${t("stash.hasUntracked")}` : ""} · {formatDate(stash.createdAtMs)}</span>
        </button>
        {open && <div className="shelfDetail" role="region" aria-label={t("stash.filesAria", { name: stash.message })}>
          {!files && !filesError && <p role="status" className="cloneHelp">{t("stash.loadingFiles")}</p>}
          {filesError && <p role="alert" className="shelfInlineError">{filesError}</p>}
          {files?.length === 0 && <p className="cloneHelp">{t("stash.noFiles")}</p>}
          {files?.map((file) => <button className="commitDetailFile" type="button" key={`${file.oid}:${file.path}`} aria-label={t("cd.openDiffFor", { path: file.path })} onClick={() => onOpenFile(file.path, file.oid)}>
            <span title={file.path}>{file.path}</span>
            <small>{file.untracked ? t("stash.untracked") : file.additions === null || file.deletions === null ? t("cd.binary") : `+${file.additions} −${file.deletions}`}</small>
          </button>)}
        </div>}
      </div>;
    })}
  </section>;
}
