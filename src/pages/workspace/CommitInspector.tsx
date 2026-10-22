import { useI18n } from "../../shared/i18n";
import { lazy, Suspense, useEffect, useRef, type ReactNode } from "react";
import type { GitCrestApiClient, RepositoryResponse } from "../../api/client";
import { ariaShortcut, type ShortcutPreferences } from "../../features/settings";
import { isFullGitObjectId, loadCommitDetails } from "../../features/history";

const CommitDetails = lazy(loadCommitDetails);

interface CommitInspectorProps {
  repository: RepositoryResponse;
  selectedCommit?: string;
  api?: GitCrestApiClient;
  /** Docked beside the content on wide windows; floating over it on narrower ones. */
  overlay: boolean;
  /** History lists the commit's files beside the diff already. */
  showFiles: boolean;
  selectedFilePath?: string;
  openTagRequest?: { repoId: string; oid: string; sequence: number };
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  actions?: ReactNode;
  onClose: () => void;
  onOpenFile: (path: string, oid: string) => void;
  onOpenDiffWindow: (path: string, oid: string) => void;
  onTagRequestHandled: (sequence: number) => void;
}

/** Optional details of the selected commit: SHA, author, date, parents, message and tag creation. */
export function CommitInspector({
  repository,
  selectedCommit,
  api,
  overlay,
  showFiles,
  selectedFilePath,
  openTagRequest,
  shortcuts,
  isMacPlatform,
  actions,
  onClose,
  onOpenFile,
  onOpenDiffWindow,
  onTagRequestHandled,
}: CommitInspectorProps) {
  const { t } = useI18n();
  const closeRef = useRef<HTMLButtonElement>(null);

  // A floating inspector takes focus so keyboard users land in it; Esc returns them.
  useEffect(() => {
    if (overlay) closeRef.current?.focus();
  }, [overlay]);

  return (
    <aside
      className={`detailsPanel inspector${overlay ? " overlay" : ""}`}
      aria-label={t("details.aria")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && overlay && !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [role='menu']"))) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="sidePanelHeader">
        <span className="sidePanelTitle">{t("details.aria")}</span>
        <span className="sidePanelSpacer" />
        {actions}
        <button ref={closeRef} className="quietButton compact iconButton" type="button" aria-label={t("panel.closeDetails")} title={t("panel.closeDetails")} onClick={onClose}><span aria-hidden="true">✕</span></button>
      </div>
      {isFullGitObjectId(selectedCommit) && api ? <Suspense fallback={<div className="detailsEmpty" role="status" aria-live="polite">{t("details.loading")}</div>}>
        <CommitDetails
          api={api}
          repoId={repository.repoId}
          oid={selectedCommit}
          selectedPath={selectedFilePath}
          showFiles={showFiles}
          onOpenFile={onOpenFile}
          onOpenDiffWindow={onOpenDiffWindow}
          openTagRequest={openTagRequest}
          onTagRequestHandled={onTagRequestHandled}
          tagShortcut={ariaShortcut(shortcuts.createTag, isMacPlatform)}
          cherryPickShortcut={ariaShortcut(shortcuts.cherryPick, isMacPlatform)}
        />
      </Suspense> : <div className="detailsEmpty"><h2>{t("details.noneSelected")}</h2><p>{t("details.selectHint")}</p></div>}
    </aside>
  );
}
