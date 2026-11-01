import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useState } from "react";
import {
  GitCrestApiError,
  type BranchSnapshotResponse,
  type GitCrestApiClient,
  type RebasePreviewResponse,
  type RebaseBackupSnapshotResponse,
  type TaskSnapshotResponse,
} from "../../../api/client";
import type { components } from "../../../api/schema";

type RebaseTodoItem = components["schemas"]["RebaseTodoItem"];

const ACTIONS: RebaseTodoItem["action"][] = ["pick", "reword", "edit", "squash", "fixup", "drop"];

export function RebaseDialog({ api, repoId, branches, initialOntoOid, disabled, onClose, onStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  branches?: BranchSnapshotResponse;
  /** The branch tip to rebase onto at first, as when the dialog opens from a branch's menu. */
  initialOntoOid?: string;
  disabled: boolean;
  onClose: () => void;
  onStarted: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const targets = useMemo(
    () => (branches?.branches || []).filter((branch) => !branch.isCurrent),
    [branches],
  );
  const currentBranch = branches?.branches.find((branch) => branch.isCurrent);
  const defaultTarget = targets.find((branch) => branch.fullName === currentBranch?.upstream) || targets[0];
  const [ontoOid, setOntoOid] = useState(initialOntoOid || "");
  const [preview, setPreview] = useState<RebasePreviewResponse>();
  const [backupSnapshot, setBackupSnapshot] = useState<RebaseBackupSnapshotResponse>();
  const [selectedBackup, setSelectedBackup] = useState("");
  const [todo, setTodo] = useState<RebaseTodoItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [confirmPublishedRewrite, setConfirmPublishedRewrite] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [error, setError] = useState<DisplayError>("");

  useEffect(() => {
    const controller = new AbortController();
    void api.withSignal(controller.signal).getRepositoryRebaseBackups(repoId).then((snapshot) => {
      if (controller.signal.aborted) return;
      setBackupSnapshot(snapshot);
      setSelectedBackup(snapshot.backups[0]?.reference || "");
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason instanceof GitCrestApiError ? describeApiError(reason) : t("rb.loadBackups"));
    });
    return () => controller.abort();
  }, [api, repoId]);

  useEffect(() => {
    if (!ontoOid && defaultTarget) setOntoOid(defaultTarget.oid);
  }, [defaultTarget, ontoOid]);

  const dropCount = todo.filter((item) => item.action === "drop").length;
  const canStart = Boolean(
    preview?.canStart
      && preview.headOid
      && !disabled
      && !loading
      && !busy
      && (!dropCount || confirmDrop)
      && (!(preview.publishedCommitOids?.length) || confirmPublishedRewrite),
  );

  async function inspect() {
    if (!ontoOid || disabled || loading || busy) return;
    setLoading(true);
    setError("");
    setPreview(undefined);
    setTodo([]);
    setConfirmDrop(false);
    setConfirmPublishedRewrite(false);
    try {
      const next = await api.preflightRepositoryRebase(repoId, ontoOid);
      setPreview(next);
      setTodo(next.commits.map((commit) => ({ oid: commit.oid, action: "pick", message: null })));
    } catch (reason) {
      setError(describeApiError(reason, t("rb.inspectFailed")));
    } finally {
      setLoading(false);
    }
  }

  function updateTodo(index: number, update: Partial<RebaseTodoItem>) {
    setTodo((current) => current.map((item, position) => position === index ? { ...item, ...update } : item));
  }

  function moveTodo(index: number, delta: -1 | 1) {
    const nextIndex = index + delta;
    setTodo((current) => {
      if (nextIndex < 0 || nextIndex >= current.length) return current;
      const reordered = [...current];
      [reordered[index], reordered[nextIndex]] = [reordered[nextIndex]!, reordered[index]!];
      return reordered;
    });
  }

  async function start() {
    if (!canStart || !preview?.headOid) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.startRepositoryRebase(repoId, {
        expectedHeadOid: preview.headOid,
        expectedOntoOid: preview.ontoOid,
        previewRevision: preview.previewRevision,
        todo,
        confirmDrop,
        confirmPublishedRewrite,
      }));
    } catch (reason) {
      setError(describeApiError(reason, t("rb.startFailed")));
    } finally {
      setBusy(false);
    }
  }

  async function rollback() {
    const backup = backupSnapshot?.backups.find((item) => item.reference === selectedBackup);
    if (!backupSnapshot?.canRollback || !backupSnapshot.headOid || !backup || !confirmRollback || disabled || busy) return;
    setBusy(true);
    setError("");
    try {
      onStarted(await api.rollbackRepositoryRebase(repoId, {
        expectedHeadOid: backupSnapshot.headOid,
        backupReference: backup.reference,
        backupOid: backup.oid,
        confirmRollback: true,
      }));
    } catch (reason) {
      setError(describeApiError(reason, t("rb.rollbackFailed")));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog className="taskCenter rebaseDialog" role="dialog" aria-labelledby="rebase-dialog-title" onClose={onClose} busy={busy} closeLabel={t("rb.close")}>
      <DialogHeader className="taskCenterHeader">
        <div><h2 id="rebase-dialog-title">{t("rb.title")}</h2></div>

      </DialogHeader>
      <div className="workflowDialogBody">
        <label className="rebaseTargetField" htmlFor="rebase-onto">{t("rb.onto")}
          <select data-dialog-initial-focus id="rebase-onto" value={ontoOid} disabled={disabled || loading || busy || targets.length === 0} onChange={(event) => { setOntoOid(event.target.value); setPreview(undefined); setTodo([]); }}>
            {targets.map((branch) => <option key={`${branch.fullName}:${branch.oid}`} value={branch.oid}>{branch.fullName} · {branch.oid.slice(0, 9)}</option>)}
          </select>
        </label>
        {targets.length === 0 && <p className="cloneHelp">{t("rb.noTargets")}</p>}
        {disabled && <p className="cloneHelp">{t("rb.waitTask")}</p>}
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <section className="rebaseRollbackPanel" aria-labelledby="rebase-rollback-heading">
          <h3 id="rebase-rollback-heading">{t("rb.restoreHeading")}</h3>
          {backupSnapshot?.backups.length ? <>
            <label className="rebaseTargetField" htmlFor="rebase-backup">{t("rb.savedState")}
              <select id="rebase-backup" value={selectedBackup} disabled={disabled || busy} onChange={(event) => { setSelectedBackup(event.target.value); setConfirmRollback(false); }}>
                {backupSnapshot.backups.map((backup) => <option key={backup.reference} value={backup.reference}>{backup.subject || t("push.noSubject")} · {backup.oid.slice(0, 9)}</option>)}
              </select>
            </label>
            {!backupSnapshot.canRollback && <p className="cloneHelp">{t("rb.rollbackOnly")}</p>}
            <label className="rebaseConfirm"><input type="checkbox" checked={confirmRollback} onChange={(event) => setConfirmRollback(event.target.checked)} />{t("rb.rollbackConfirm")}</label>
            <Button variant="danger" size="compact" type="button" disabled={!backupSnapshot.canRollback || !confirmRollback || disabled || busy} onClick={() => void rollback()}>{busy ? t("rb.starting") : t("rb.restoreBtn")}</Button>
          </> : <p className="cloneHelp">{t("rb.noBackups")}</p>}
        </section>
        {loading && <p role="status">{t("rb.reviewing")}</p>}
        {preview && <>
          <div className="rebasePreviewFacts">
            <div className="repositoryFact"><span>{t("rb.branch")}</span><strong>{preview.currentBranch || t("rb.detached")}</strong></div>
            <div className="repositoryFact"><span>{t("rb.head")}</span><strong className="monoText">{preview.headOid?.slice(0, 12) || t("rb.unborn")}</strong></div>
            <div className="repositoryFact"><span>{t("rb.onto2")}</span><strong className="monoText">{preview.ontoOid.slice(0, 12)}</strong></div>
            <div className="repositoryFact"><span>{t("rb.commits")}</span><strong>{preview.commits.length}{preview.omittedCommitCount ? t("rb.omittedSuffix", { count: preview.omittedCommitCount }) : ""}</strong></div>
          </div>
          <section className="operationImpactNotice" aria-label={t("rb.impactAria")}>
            <h3>{t("rb.impactHeading")}</h3>
            <p>{t("rb.impactBody", { branch: preview.currentBranch || t("rb.detached"), onto: preview.ontoOid.slice(0, 12), count: todo.length, omitted: preview.omittedCommitCount ? t("rb.impactOmitted", { count: preview.omittedCommitCount }) : "" })}</p>
            {dropCount > 0 && <p>{t("rb.dropNote", { count: dropCount })}</p>}
            {preview.publishedCommitOids.length > 0 && <p>{t("rb.publishedNote", { count: preview.publishedCommitOids.length })}</p>}
            {preview.dirtyPaths.length > 0 && <p>{t("rb.dirtyNote", { count: preview.dirtyPaths.length })}</p>}
            <p>{t("rb.rollbackNote")}</p>
          </section>
          {!preview.canStart && <p className="taskCenterError" role="alert">{t("rb.cannotRebase")}</p>}
          {preview.publishedCommitOids.length > 0 && <label className="rebaseConfirm"><input type="checkbox" checked={confirmPublishedRewrite} onChange={(event) => setConfirmPublishedRewrite(event.target.checked)} />{t("rb.publishedConfirm", { count: preview.publishedCommitOids.length })}</label>}
          <ol className="rebaseTodoList" aria-label={t("rb.todoAria")}>
            {todo.map((item, index) => {
              const commit = preview.commits.find((entry) => entry.oid === item.oid);
              return <li key={item.oid}>
                <div className="rebaseTodoRow">
                  <span className="monoText rebaseTodoOid">{item.oid.slice(0, 9)}</span>
                  <select aria-label={t("rb.actionFor", { oid: item.oid.slice(0, 9) })} value={item.action} disabled={busy} onChange={(event) => updateTodo(index, { action: event.target.value as RebaseTodoItem["action"], message: event.target.value === "reword" ? item.message || commit?.subject || "" : null })}>
                    {ACTIONS.map((action) => <option key={action} value={action}>{action}</option>)}
                  </select>
                  <span className="rebaseTodoSubject" title={commit?.subject}>{commit?.subject || t("rb.noSubject")}</span>
                  <Button variant="quiet" size="compact" type="button" aria-label={t("rb.moveUp", { oid: item.oid.slice(0, 9) })} disabled={busy || index === 0} onClick={() => moveTodo(index, -1)}><UiIcon name="arrowUp" /></Button>
                  <Button variant="quiet" size="compact" type="button" aria-label={t("rb.moveDown", { oid: item.oid.slice(0, 9) })} disabled={busy || index === todo.length - 1} onClick={() => moveTodo(index, 1)}><UiIcon name="arrowDown" /></Button>
                </div>
                {item.action === "reword" && <textarea className="rebaseMessage" aria-label={t("rb.replacement", { oid: item.oid.slice(0, 9) })} value={item.message || ""} disabled={busy} onChange={(event) => updateTodo(index, { message: event.target.value })} rows={3} />}
              </li>;
            })}
          </ol>
          {dropCount > 0 && <label className="rebaseConfirm"><input type="checkbox" checked={confirmDrop} onChange={(event) => setConfirmDrop(event.target.checked)} />{t("rb.dropConfirm", { count: dropCount })}</label>}
        </>}

        {preview && <p className="cloneHelp">{t("rb.footer")}</p>}
      </div>
      <DialogFooter className="taskCenterActions"><Button variant="secondary" disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant={preview ? "quiet" : "primary"} type="button" disabled={!ontoOid || disabled || loading || busy} onClick={() => void inspect()}>{loading ? t("rb.reviewingBtn") : t("rb.refresh")}</Button>
          <Button variant="primary" type="button" disabled={!canStart} onClick={() => void start()}>{busy ? t("rb.starting") : t("rb.start")}</Button>
        </DialogFooter>
    </Dialog>;
}
