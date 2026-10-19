import { useI18n } from "../../shared/i18n";
import { BrandMark } from "../../shared/ui/BrandMark";
import type { ReactNode } from "react";
import type { RepositoryResponse } from "../../api/client";
import type { ShortcutPreferences } from "../../features/settings";
import type { WorkspaceMode } from "../../features/repositories";
import { ariaShortcut, displayShortcut } from "../../features/settings";

interface WorkspacePageProps {
  selectedRepository?: RepositoryResponse;
  selectedFilePath?: string;
  mode: WorkspaceMode;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  connected: boolean;
  connecting: boolean;
  version?: string;
  hasActiveRepositoryTask: boolean;
  pushDisabledReason: string;
  pullDisabledReason: string;
  children: ReactNode;
  onChangeWorkspaceMode: (mode: WorkspaceMode) => void;
  onOpenPushDialog: () => void;
  onOpenPullDialog: () => void;
  onFetchRepository: () => void;
  onOpenBranchSwitcher: () => void;
}

export function WorkspacePage({
  selectedRepository,
  selectedFilePath,
  mode,
  shortcuts,
  isMacPlatform,
  connected,
  connecting,
  version,
  hasActiveRepositoryTask,
  pushDisabledReason,
  pullDisabledReason,
  children,
  onChangeWorkspaceMode,
  onOpenPushDialog,
  onOpenPullDialog,
  onFetchRepository,
  onOpenBranchSwitcher,
}: WorkspacePageProps) {
  const { t } = useI18n();
  return (
    <section className="workspacePage" aria-label={t("page.aria")}>
      <div className="workspaceToolbar">
        <div className="workspaceCrumb"><BrandMark className="crumbMark" /><span>{t("titlebar.workspace")}</span><span className="crumbSlash">/</span><span className="mutedText">{selectedRepository?.path || t("page.noRepository")}</span></div>
        <div className="toolbarActions">
          <button className={mode === "graph" ? "modeButton active" : "modeButton"} type="button" onClick={() => onChangeWorkspaceMode("graph")}>{t("page.graph")}</button>
          <button className={mode === "diff" ? "modeButton active" : "modeButton"} type="button" disabled={!selectedFilePath} aria-keyshortcuts={ariaShortcut(shortcuts.openDiff, isMacPlatform)} title={!selectedFilePath ? t("page.selectToOpenDiff") : t("page.openSelectedDiff", { shortcut: displayShortcut(shortcuts.openDiff, isMacPlatform) })} onClick={() => onChangeWorkspaceMode("diff")}>{t("page.diff")}</button>
          <span className="toolbarDivider" />
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} aria-keyshortcuts={ariaShortcut(shortcuts.push, isMacPlatform)} title={pushDisabledReason || t("page.pushTitle", { shortcut: displayShortcut(shortcuts.push, isMacPlatform) })} onClick={() => onOpenPushDialog()}>{t("page.push")}</button>
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} title={pullDisabledReason || t("page.pullTitle", { shortcut: displayShortcut(shortcuts.pull, isMacPlatform) })} onClick={() => onOpenPullDialog()}>{t("page.pull")}</button>
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available" || hasActiveRepositoryTask} aria-keyshortcuts={ariaShortcut(shortcuts.fetch, isMacPlatform)} title={selectedRepository ? t("page.fetchTitle", { shortcut: displayShortcut(shortcuts.fetch, isMacPlatform) }) : t("page.openToFetch")} onClick={onFetchRepository}>{t("page.fetch")}</button>
          <span className="toolbarDivider" />
          <button className="quietButton compact" type="button" disabled={!selectedRepository || !connected || selectedRepository.availability !== "available"} title={selectedRepository ? t("page.switchBranches", { shortcut: displayShortcut(shortcuts.branchSwitcher, isMacPlatform) }) : t("page.openToSwitch")} onClick={onOpenBranchSwitcher}><span className="branchGlyph" aria-hidden="true">⑂</span> {selectedRepository ? selectedRepository.detached ? t("page.detached", { oid: selectedRepository.head?.slice(0, 7) ?? "" }) : selectedRepository.branch || t("page.unbornBranch") : t("page.noBranch")}</button>
        </div>
      </div>

      {children}
      <footer className="statusbar"><span className="statusIcon" aria-hidden="true">●</span>{connected ? t("page.engineReady") : connecting ? t("page.engineConnecting") : t("page.engineUnavailable")}<span className="statusbarDivider" /><span>{version || "API v1"}</span><span className="footerSpacer" /><span>{t("page.planned")}</span></footer>
    </section>
  );
}

export default WorkspacePage;
