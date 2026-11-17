import { MetaList } from "../../../shared/ui/MetaList";
import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import type { GitCrestApiClient, StashEntryResponse, StashImportedResponse, StatusSnapshotResponse, TaskSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { MenuButton } from "../../../shared/ui/MenuButton";
import { StashActionDialog, type StashAction } from "./StashActionDialog";

type StashFile = { path: string; oid: string; untracked: boolean; additions: number | null; deletions: number | null };

function errorMessage(error: unknown, fallback: string) {
  return describeApiError(error, fallback);
}

function formatDate(ms: number) {
  return ms > 0 ? new Date(ms).toLocaleString() : "";
}

export function StashList({ api, repoId, refreshKey, statusSnapshot, disabled = false, onOpenFile, onTaskStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  statusSnapshot?: StatusSnapshotResponse;
  /** Git operations cannot start now, so stash changes are unavailable. */
  disabled?: boolean;
  /** Apply or pop started as a background task. */
  onTaskStarted?: (task: TaskSnapshotResponse) => void;
  /** Shows one file of a stash commit in the read-only diff. */
  onOpenFile: (path: string, oid: string) => void;
}) {
  const { t } = useI18n();
  const [stashes, setStashes] = useState<StashEntryResponse[]>();
  const [error, setError] = useState<DisplayError>("");
  const [openOid, setOpenOid] = useState<string>();
  const [files, setFiles] = useState<StashFile[]>();
  const [filesError, setFilesError] = useState<DisplayError>("");
  const [attempt, setAttempt] = useState(0);
  const [imported, setImported] = useState<StashImportedResponse>();
  const [action, setAction] = useState<{ kind: StashAction; stash: StashEntryResponse }>();
  const untrackedOid = stashes?.find((stash) => stash.oid === openOid)?.untrackedOid;

  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api.withSignal(controller.signal).getRepositoryStashes(repoId)
      .then((list) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(list.stashes)) throw new Error(t("stash.loadFailed"));
        setStashes(list.stashes);
        setOpenOid((oid) => list.stashes.some((stash) => stash.oid === oid) ? oid : undefined);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorMessage(reason, t("stash.loadFailed")));
      });
    return () => controller.abort();
  }, [api, repoId, refreshKey, statusSnapshot, attempt]);

  useEffect(() => {
    setFiles(undefined);
    setFilesError("");
    if (!openOid) return;
    const controller = new AbortController();
    const request = api.withSignal(controller.signal);
    const oids = untrackedOid ? [openOid, untrackedOid] : [openOid];
    void Promise.all(oids.map((oid) => request.getRepositoryCommit(repoId, oid))).then((parts) => {
      if (controller.signal.aborted) return;
      setFiles(parts.flatMap((detail) => detail.files.map((file) => ({
        path: file.path,
        oid: detail.oid,
        untracked: detail.oid === untrackedOid,
        additions: file.additions,
        deletions: file.deletions,
      }))));
    }).catch((reason) => {
      if (!controller.signal.aborted) setFilesError(errorMessage(reason, t("stash.filesFailed")));
    });
    return () => controller.abort();
  }, [api, repoId, openOid, untrackedOid]);

  return <section className="stashList" aria-label={t("stash.title")}>
    {imported && (imported.dropStatus === "failed"
      ? <p className="shelfInlineError" role="alert">{t("stash.importDropFailed", { name: imported.name })}</p>
      : <p className="cloneHelp" role="status">{t("stash.imported", { name: imported.name })}</p>)}
    {!stashes && !error && <p className="navEmpty" role="status">{t("stash.loading")}</p>}
    {error && <div className="shelfInlineError" role="alert">
      {stashes && <p>{t("stash.stale")}</p>}
      <span><ErrorMessage error={error} /></span> <button type="button" className="textButton" onClick={() => setAttempt((value) => value + 1)}>{t("stash.retry")}</button>
    </div>}
    {!error && stashes?.length === 0 && <EmptyState>{t("stash.empty")}</EmptyState>}
    {stashes?.map((stash) => {
      const open = openOid === stash.oid;
      return <div className={`shelfListItem stashItem${open ? " active" : ""}`} key={stash.oid}>
        <button className="shelfSelectButton" type="button" aria-expanded={open} aria-label={t("stash.showFiles", { name: stash.message })} onClick={() => {
          setOpenOid(open ? undefined : stash.oid);
          setFiles(undefined);
          setFilesError("");
        }}>
          <span className="shelfItemName" title={stash.message}>{stash.message || `stash@{${stash.index}}`}</span>
          <MetaList className="shelfItemMeta" items={[`stash@{${stash.index}}`, stash.branch, stash.untrackedOid && t("stash.hasUntracked"), formatDate(stash.createdAtMs)]} />
        </button>
        <MenuButton
          className="quietButton compact iconButton"
          label={t("stash.actionsFor", { name: stash.message || `stash@{${stash.index}}` })}
          title={t("stash.actions")}
          menuLabel={t("stash.actionsFor", { name: stash.message || `stash@{${stash.index}}` })}
          disabled={disabled}
          items={[
            { id: "apply", label: t("stash.apply"), onSelect: () => setAction({ kind: "apply", stash }) },
            { id: "pop", label: t("stash.pop"), onSelect: () => setAction({ kind: "pop", stash }) },
            { id: "import", label: t("stash.import"), separatorBefore: true, onSelect: () => setAction({ kind: "import", stash }) },
            { id: "drop", label: t("stash.drop"), danger: true, separatorBefore: true, onSelect: () => setAction({ kind: "drop", stash }) },
          ]}
        ><span aria-hidden="true"><UiIcon name="more" /></span></MenuButton>
        {open && <div className="shelfDetail" role="region" aria-label={t("stash.filesAria", { name: stash.message })}>
          {!files && !filesError && <p role="status" className="cloneHelp">{t("stash.loadingFiles")}</p>}
          {filesError && <p role="alert" className="shelfInlineError"><ErrorMessage error={filesError} /></p>}
          {files?.length === 0 && <p className="cloneHelp">{t("stash.noFiles")}</p>}
          {files?.map((file) => <button className="commitDetailFile" type="button" key={`${file.oid}:${file.path}`} aria-label={t("cd.openDiffFor", { path: file.path })} onClick={() => onOpenFile(file.path, file.oid)}>
            <span title={file.path}>{file.path}</span>
            <small>{file.untracked ? t("stash.untracked") : file.additions === null || file.deletions === null ? t("cd.binary") : `+${file.additions} −${file.deletions}`}</small>
          </button>)}
        </div>}
      </div>;
    })}
    {action && <StashActionDialog
      api={api}
      repoId={repoId}
      stash={action.stash}
      action={action.kind}
      disabled={disabled}
      onClose={() => setAction(undefined)}
      onTaskStarted={(task) => { setAction(undefined); onTaskStarted?.(task); }}
      onChanged={(result) => {
        setAction(undefined);
        setImported(result);
        setAttempt((value) => value + 1);
      }}
    />}
  </section>;
}
