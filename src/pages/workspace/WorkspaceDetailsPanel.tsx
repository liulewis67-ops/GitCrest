import { useI18n } from "../../shared/i18n";
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
  onCreateBranch: (oid: string) => void;
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
  onCreateBranch,
}: WorkspaceDetailsPanelProps) {
  const { t } = useI18n();
  const workflowDisabledReason = !connected
    ? t("details.connectFirst")
    : repository?.availability !== "available"
      ? t("details.repoUnavailable")
      : hasActiveRepositoryTask
        ? t("details.waitTask")
        : undefined;

  return (
    <aside className="detailsPanel" aria-label={t("details.aria")}>
      <div className="panelHeading">{repository ? t("details.headingRepository") : t("details.headingCommit")}</div>
      {repository && isFullGitObjectId(selectedCommit) && api ? <Suspense fallback={<div className="detailsEmpty" role="status" aria-live="polite">{t("details.loading")}</div>}><CommitDetails api={api} repoId={repository.repoId} oid={selectedCommit} onOpenFile={onOpenFile} onOpenDiffWindow={onOpenDiffWindow} workflowDisabledReason={workflowDisabledReason} openTagRequest={openTagRequest} onTagRequestHandled={onTagRequestHandled} tagShortcut={ariaShortcut(shortcuts.createTag, isMacPlatform)} cherryPickShortcut={ariaShortcut(shortcuts.cherryPick, isMacPlatform)} onWorkflow={onWorkflow} onCreateBranch={onCreateBranch} /></Suspense> : repository ? (
        <div className="repositoryDetails">
          <span className="detailsGlyph" aria-hidden="true">G</span>
          <h2>{getRepositoryDisplayName(repository.path)}</h2>
          <p>{repository.path}</p>
          <div className="repositoryFact"><span>{t("details.branch")}</span><strong>{repository.detached ? t("details.detachedHead") : repository.branch || t("details.unborn")}</strong></div>
          <div className="repositoryFact"><span>{selectedCommit && selectedCommit !== repository.head ? t("details.selectedCommit") : t("details.head")}</span><strong className="monoText">{selectedCommit?.slice(0, 12) || t("details.noCommits")}</strong></div>
          <div className="repositoryFact"><span>{t("details.repoId")}</span><strong className="monoText">{repository.repoId.slice(0, 17)}…</strong></div>
        </div>
      ) : (
        <><div className="detailsEmpty"><span className="detailsGlyph" aria-hidden="true">⌁</span><h2>{t("details.noneSelected")}</h2><p>{t("details.selectHint")}</p></div><div className="detailPlaceholder"><span>{t("details.author")}</span><strong>—</strong><span>{t("details.commit")}</span><strong className="monoText">—</strong></div></>
      )}
    </aside>
  );
}

export default WorkspaceDetailsPanel;
