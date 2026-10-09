import { lazy, Suspense } from "react";
import type { GitCrestApiClient, RepositoryResponse } from "../../api/client";
import type { WorkflowAction } from "../../features/workflows";
import { ariaShortcut, type ShortcutPreferences } from "../../features/settings";
import { isFullGitObjectId, loadCommitDetails } from "../../features/history";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";

const CommitDetails = lazy(loadCommitDetails);

interface WorkspaceDetailsPanelProps {
  repository?: RepositoryResponse;
  selectedCommit?: string;
  api?: GitCrestApiClient;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
  openTagRequest?: { repoId: string; oid: string; sequence: number };
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  onOpenFile: (path: string, oid: string) => void;
  onOpenDiffWindow: (path: string, oid: string) => void;
  onTagRequestHandled: (sequence: number) => void;
  onWorkflow: (action: WorkflowAction, oid: string) => void;
}

export function WorkspaceDetailsPanel({
  repository,
  selectedCommit,
  api,
  connected,
  hasActiveRepositoryTask,
  openTagRequest,
  shortcuts,
  isMacPlatform,
  onOpenFile,
  onOpenDiffWindow,
  onTagRequestHandled,
  onWorkflow,
}: WorkspaceDetailsPanelProps) {
  const workflowDisabledReason = !connected
    ? "Connect to the Git engine to start this operation."
    : repository?.availability !== "available"
      ? "This repository is unavailable."
      : hasActiveRepositoryTask
        ? "Wait for the current repository task."
        : undefined;

  return (
    <aside className="detailsPanel" aria-label="Commit details">
      <div className="panelHeading">{repository ? "REPOSITORY" : "COMMIT DETAILS"}</div>
      {repository && isFullGitObjectId(selectedCommit) && api ? <Suspense fallback={<div className="detailsEmpty" role="status" aria-live="polite">Loading commit details…</div>}><CommitDetails api={api} repoId={repository.repoId} oid={selectedCommit} onOpenFile={onOpenFile} onOpenDiffWindow={onOpenDiffWindow} workflowDisabledReason={workflowDisabledReason} openTagRequest={openTagRequest} onTagRequestHandled={onTagRequestHandled} tagShortcut={ariaShortcut(shortcuts.createTag, isMacPlatform)} cherryPickShortcut={ariaShortcut(shortcuts.cherryPick, isMacPlatform)} onWorkflow={onWorkflow} /></Suspense> : repository ? (
        <div className="repositoryDetails">
          <span className="detailsGlyph" aria-hidden="true">G</span>
          <h2>{getRepositoryDisplayName(repository.path)}</h2>
          <p>{repository.path}</p>
          <div className="repositoryFact"><span>BRANCH</span><strong>{repository.detached ? "Detached HEAD" : repository.branch || "Unborn"}</strong></div>
          <div className="repositoryFact"><span>{selectedCommit && selectedCommit !== repository.head ? "SELECTED COMMIT" : "HEAD"}</span><strong className="monoText">{selectedCommit?.slice(0, 12) || "No commits"}</strong></div>
          <div className="repositoryFact"><span>REPO ID</span><strong className="monoText">{repository.repoId.slice(0, 17)}…</strong></div>
        </div>
      ) : (
        <><div className="detailsEmpty"><span className="detailsGlyph" aria-hidden="true">⌁</span><h2>No commit selected</h2><p>Select a commit in the graph to inspect its message, author, and changed files.</p></div><div className="detailPlaceholder"><span>AUTHOR</span><strong>—</strong><span>COMMIT</span><strong className="monoText">—</strong></div></>
      )}
    </aside>
  );
}

export default WorkspaceDetailsPanel;
