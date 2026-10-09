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
  onOpenFile,
  onOpenDiffWindow,
  onWorkflow,
  workflowDisabledReason,
  openTagRequest,
  tagShortcut,
  cherryPickShortcut,
  onTagRequestHandled,
}: {
  api: GitCrestApiClient;
  repoId: string;
  oid?: string;
  onOpenFile?: (path: string, oid: string) => void;
  onOpenDiffWindow?: (path: string, oid: string) => void;
  onWorkflow?: (action: "merge" | "cherryPick" | "revert", oid: string) => void;
  workflowDisabledReason?: string;
  openTagRequest?: { repoId: string; oid: string; sequence: number };
  tagShortcut?: string;
  cherryPickShortcut?: string;
  onTagRequestHandled?: (sequence: number) => void;
}) {
  const state = useRepositoryCommitDetail(api, repoId, oid);
  const [copyMessage, setCopyMessage] = useState("");
  const tagCreation = useCommitTagCreation(api, repoId, oid);
  useEffect(() => {
    setCopyMessage("");
  }, [oid]);

  useEffect(() => {
    if (openTagRequest?.repoId !== repoId || openTagRequest.oid !== oid) return;
    tagCreation.openEditor();
    onTagRequestHandled?.(openTagRequest.sequence);
  }, [oid, onTagRequestHandled, openTagRequest, repoId, tagCreation.openEditor]);

  if (!oid) return <div className="detailsEmpty"><span className="detailsGlyph" aria-hidden="true">⌁</span><h2>No commit selected</h2><p>Select a commit in the graph to inspect its message, author, and changed files.</p></div>;
  if (state.oid !== oid || state.loading) return <div className="commitDetailsState" role="status">Loading commit details…</div>;
  if (state.error) return <div className="commitDetailsState" role="alert"><p>{state.error}</p></div>;
  const detail = state.detail;
  if (!detail) return null;
  const commitOid = detail.oid;
  async function copyCommitId() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(commitOid);
      setCopyMessage("Full commit SHA copied.");
    } catch {
      setCopyMessage("Clipboard access is unavailable. Select the commit ID to copy it.");
    }
  }
  async function createAnnotatedTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await tagCreation.createTag();
  }
  return <div className="commitDetails">
    <div className="repositoryFact"><span>COMMIT</span><strong className="monoText" title={detail.oid}>{detail.oid.slice(0, 12)}</strong></div>
    <button className="textButton commitCopyButton" type="button" onClick={() => void copyCommitId()}>Copy SHA</button>
    {copyMessage && <p className="commitCopyStatus" role="status">{copyMessage}</p>}
    <button className="textButton commitCopyButton" type="button" aria-keyshortcuts={tagShortcut} onClick={tagCreation.toggleEditor}>{tagCreation.editorOpen ? "Cancel tag" : "Create tag"}</button>
    {onWorkflow && <div className="commitWorkflowActions" aria-label="Commit actions"><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} title={workflowDisabledReason} onClick={() => onWorkflow("merge", commitOid)}>Merge</button><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} aria-keyshortcuts={cherryPickShortcut} title={workflowDisabledReason} onClick={() => onWorkflow("cherryPick", commitOid)}>Cherry-pick</button><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} title={workflowDisabledReason} onClick={() => onWorkflow("revert", commitOid)}>Revert</button></div>}
    {tagCreation.editorOpen && <form className="commitTagForm" onSubmit={(event) => void createAnnotatedTag(event)}>
      <label>Tag name<input aria-label="Tag name" value={tagCreation.name} maxLength={255} required onChange={(event) => tagCreation.setName(event.target.value)} placeholder="v1.0.0" /></label>
      <label>Annotation message<textarea aria-label="Tag annotation" value={tagCreation.message} maxLength={8192} onChange={(event) => tagCreation.setMessage(event.target.value)} placeholder="Describe this release" /></label>
      {tagCreation.error && <p className="commitTagError" role="alert">{tagCreation.error}</p>}
      <button className="secondaryButton" type="submit" disabled={tagCreation.busy || !tagCreation.name.trim()}>{tagCreation.busy ? "Creating tag…" : "Create annotated tag"}</button>
    </form>}
    {tagCreation.status && <p className="commitCopyStatus" role="status">{tagCreation.status}</p>}
    <div className="repositoryFact"><span>AUTHOR</span><strong>{detail.authorName}</strong></div>
    <div className="repositoryFact"><span>DATE</span><strong>{formatCommitDate(detail.committedAtMs)}</strong></div>
    <div className="commitDetailMessage">{detail.message}</div>
    <div className="commitDetailStats"><strong>{detail.stats.filesChanged}</strong> files <span>+</span>{detail.stats.insertions} <span>−</span>{detail.stats.deletions}</div>
    <div className="commitDetailFiles" aria-label="Changed files">{detail.files.map((file) => <div className="commitDetailFileRow" key={file.path}><button className="commitDetailFile" type="button" aria-label={`Open commit diff for ${file.path}`} onClick={() => onOpenFile?.(file.path, detail.oid)}><span title={file.path}>{file.path}</span><small>{file.additions === null || file.deletions === null ? "binary" : `+${file.additions} −${file.deletions}`}</small></button>{onOpenDiffWindow && <button className="commitDetailFileWindow" type="button" aria-label={`Open commit diff window for ${file.path}`} title="Open in a read-only Diff window" onClick={() => onOpenDiffWindow(file.path, detail.oid)}>↗</button>}</div>)}</div>
  </div>;
}
