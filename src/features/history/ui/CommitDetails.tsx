import { useI18n } from "../../../shared/i18n";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import { useCommitTagCreation } from "../model/use-commit-tag-creation";
import { useRepositoryCommitDetail } from "../model/use-repository-commit-detail";
import { formatCommitDate } from "./format-commit-date";

export function CommitDetails({
  api,
  repoId,
  oid,
  selectedPath,
  showFiles = true,
  onOpenFile,
  onOpenDiffWindow,
  onWorkflow,
  onCreateBranch,
  onUseMessage,
  draftHasText = false,
  workflowDisabledReason,
  openTagRequest,
  tagShortcut,
  cherryPickShortcut,
  onTagRequestHandled,
}: {
  api: GitCrestApiClient;
  repoId: string;
  oid?: string;
  selectedPath?: string;
  /** The History view lists files beside the diff, so its inspector leaves them out. */
  showFiles?: boolean;
  onOpenFile?: (path: string, oid: string) => void;
  onOpenDiffWindow?: (path: string, oid: string) => void;
  onWorkflow?: (action: "merge" | "cherryPick" | "revert", oid: string) => void;
  onCreateBranch?: (oid: string) => void;
  /** Fills the commit draft with this commit's full message. */
  onUseMessage?: (message: string) => void;
  /** True when the commit draft already holds text, so replacing it needs a confirmation. */
  draftHasText?: boolean;
  workflowDisabledReason?: string;
  openTagRequest?: { repoId: string; oid: string; sequence: number };
  tagShortcut?: string;
  cherryPickShortcut?: string;
  onTagRequestHandled?: (sequence: number) => void;
}) {
  const { t } = useI18n();
  const state = useRepositoryCommitDetail(api, repoId, oid);
  const [copyMessage, setCopyMessage] = useState("");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const tagCreation = useCommitTagCreation(api, repoId, oid);
  useEffect(() => {
    setCopyMessage("");
    setConfirmReplace(false);
  }, [oid]);

  useEffect(() => {
    if (openTagRequest?.repoId !== repoId || openTagRequest.oid !== oid) return;
    tagCreation.openEditor();
    onTagRequestHandled?.(openTagRequest.sequence);
  }, [oid, onTagRequestHandled, openTagRequest, repoId, tagCreation.openEditor]);

  if (!oid) return <div className="detailsEmpty"><span className="detailsGlyph" aria-hidden="true">⌁</span><h2>{t("cd.none")}</h2><p>{t("cd.noneHint")}</p></div>;
  if (state.oid !== oid || state.loading) return <div className="commitDetailsState" role="status">{t("cd.loading")}</div>;
  if (state.error) return <div className="commitDetailsState" role="alert"><p>{state.error}</p></div>;
  const detail = state.detail;
  if (!detail) return null;
  const commitOid = detail.oid;
  async function copyCommitId() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("cd.clipboardUnavailable"));
      await navigator.clipboard.writeText(commitOid);
      setCopyMessage(t("cd.copied"));
    } catch {
      setCopyMessage(t("cd.copyFailed"));
    }
  }
  async function copyCommitMessage() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error(t("cd.clipboardUnavailable"));
      await navigator.clipboard.writeText(detail?.message ?? "");
      setCopyMessage(t("cd.messageCopied"));
    } catch {
      setCopyMessage(t("cd.copyMessageFailed"));
    }
  }
  function applyCommitMessage() {
    if (!onUseMessage || !detail) return;
    onUseMessage(detail.message);
    setConfirmReplace(false);
    setCopyMessage(t("cd.messageUsed"));
  }
  async function createAnnotatedTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await tagCreation.createTag();
  }
  return <div className="commitDetails">
    <div className="repositoryFact"><span>{t("cd.commit")}</span><strong className="monoText" title={detail.oid}>{detail.oid.slice(0, 12)}</strong></div>
    <div className="commitDetailLinks"><button className="textButton commitCopyButton" type="button" onClick={() => void copyCommitId()}>{t("cd.copySha")}</button>
    {copyMessage && <p className="commitCopyStatus" role="status">{copyMessage}</p>}
    <button className="textButton commitCopyButton" type="button" aria-keyshortcuts={tagShortcut} onClick={tagCreation.toggleEditor}>{tagCreation.editorOpen ? t("cd.cancelTag") : t("cd.createTag")}</button></div>
    {onWorkflow && <div className="commitWorkflowActions" aria-label={t("cd.actionsAria")}><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} title={workflowDisabledReason} onClick={() => onWorkflow("merge", commitOid)}>{t("cd.merge")}</button><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} aria-keyshortcuts={cherryPickShortcut} title={workflowDisabledReason} onClick={() => onWorkflow("cherryPick", commitOid)}>{t("cd.cherryPick")}</button><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} title={workflowDisabledReason} onClick={() => onWorkflow("revert", commitOid)}>{t("cd.revert")}</button>{onCreateBranch && <button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} title={workflowDisabledReason ?? t("cd.createBranchTitle")} onClick={() => onCreateBranch(commitOid)}>{t("cd.branchHere")}</button>}</div>}
    {tagCreation.editorOpen && <form className="commitTagForm" onSubmit={(event) => void createAnnotatedTag(event)}>
      <label>{t("cd.tagName")}<input aria-label={t("cd.tagName")} value={tagCreation.name} maxLength={255} required onChange={(event) => tagCreation.setName(event.target.value)} placeholder="v1.0.0" /></label>
      <label>{t("cd.annotation")}<textarea aria-label={t("cd.annotationAria")} value={tagCreation.message} maxLength={8192} onChange={(event) => tagCreation.setMessage(event.target.value)} placeholder={t("cd.annotationPlaceholder")} /></label>
      {tagCreation.error && <p className="commitTagError" role="alert">{tagCreation.error}</p>}
      <button className="secondaryButton" type="submit" disabled={tagCreation.busy || !tagCreation.name.trim()}>{tagCreation.busy ? t("cd.creatingTag") : t("cd.createAnnotated")}</button>
    </form>}
    {tagCreation.status && <p className="commitCopyStatus" role="status">{tagCreation.status}</p>}
    <div className="repositoryFact"><span>{t("cd.author")}</span><strong title={detail.authorEmail}>{detail.authorName}</strong></div>
    <div className="repositoryFact"><span>{t("cd.date")}</span><strong>{formatCommitDate(detail.committedAtMs)}</strong></div>
    {detail.parents.length > 0 && <div className="repositoryFact"><span>{t("cd.parents")}</span><strong className="monoText">{detail.parents.map((parent) => parent.slice(0, 8)).join(" ")}</strong></div>}
    <div className="commitDetailMessage">{detail.message}</div>
    <div className="commitDetailLinks"><button className="textButton commitCopyButton" type="button" onClick={() => void copyCommitMessage()}>{t("cd.copyMessage")}</button>
    {onUseMessage && <button className="textButton commitCopyButton" type="button" onClick={() => draftHasText ? setConfirmReplace(true) : applyCommitMessage()}>{t("cd.useMessage")}</button>}</div>
    {confirmReplace && <div className="commitDetailLinks" role="group" aria-label={t("cd.replaceDraftAria")}><span>{t("cd.replaceDraft")}</span>
    <button className="quietButton compact" type="button" onClick={applyCommitMessage}>{t("cd.replaceDraftYes")}</button>
    <button className="quietButton compact" type="button" onClick={() => setConfirmReplace(false)}>{t("cd.replaceDraftNo")}</button></div>}
    <div className="commitDetailStats"><strong>{detail.stats.filesChanged}</strong> {t("cd.files")} <span>+</span>{detail.stats.insertions} <span>−</span>{detail.stats.deletions}</div>
    {showFiles && <div className="commitDetailFiles" aria-label={t("cd.changedFiles")}>{detail.files.map((file) => <div className="commitDetailFileRow" key={file.path}><button className={`commitDetailFile${file.path === selectedPath ? " selected" : ""}`} type="button" aria-label={t("cd.openDiffFor", { path: file.path })} aria-pressed={file.path === selectedPath} onClick={() => onOpenFile?.(file.path, detail.oid)}><span title={file.path}>{file.path}</span><small>{file.additions === null || file.deletions === null ? t("cd.binary") : `+${file.additions} −${file.deletions}`}</small></button>{onOpenDiffWindow && <button className="commitDetailFileWindow" type="button" aria-label={t("cd.openWindowFor", { path: file.path })} title={t("cd.openWindowTitle")} onClick={() => onOpenDiffWindow(file.path, detail.oid)}>↗</button>}</div>)}</div>}
  </div>;
}
