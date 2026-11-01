import { Icon as UiIcon } from "../../shared/ui/Icon";
import { getGitCrestBridge } from "../../api/bridge";
import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";
import { useI18n } from "../../shared/i18n";
import { BrandMark } from "../../shared/ui/BrandMark";
import { WindowControls } from "../../shared/ui/WindowControls";
import { NewRepositoryTabMenu } from "./NewRepositoryTabMenu";
import { SettingsMenu } from "./SettingsMenu";
import { useState } from "react";
import { QuickGuideDialog } from "./QuickGuideDialog";

export type AppPage = "welcome" | "workspace";

const windowControls = getGitCrestBridge()?.windowControls;

interface AppTitlebarProps {
  page: AppPage;
  openRepoIds: string[];
  repositories: RepositoryResponse[];
  selectedRepository?: RepositoryResponse;
  shortcuts: ShortcutPreferences;
  status: string;
  connected: boolean;
  /** Whether the core is still starting or restarting; read from the status text when omitted. */
  connecting?: boolean;
  /** Offered while the core is unavailable, so a stopped core can be started again without quitting. */
  onRestartCore?: () => void;
  activeTaskCount: number;
  isMacPlatform: boolean;
  openingRepository: boolean;
  onPageChange: (page: AppPage) => void;
  onSelectRepository: (repository: RepositoryResponse) => void;
  onCloseRepository: (repoId: string) => void;
  onOpenLocalRepository: () => void;
  onCloneRepository: () => void;
  onInitializeRepository: () => void;
  onOpenCommandPalette: () => void;
  onOpenTasks: () => void;
  onOpenSettings: () => void;
}

export function AppTitlebar({
  page,
  openRepoIds,
  repositories,
  selectedRepository,
  shortcuts,
  status,
  connected,
  connecting: connectingProp,
  onRestartCore,
  activeTaskCount,
  isMacPlatform,
  openingRepository,
  onPageChange,
  onSelectRepository,
  onCloseRepository,
  onOpenLocalRepository,
  onCloneRepository,
  onInitializeRepository,
  onOpenCommandPalette,
  onOpenTasks,
  onOpenSettings,
}: AppTitlebarProps) {
  const { t } = useI18n();
  const connecting = connectingProp ?? status.startsWith("Starting");
  const connectionLabel = connected ? t("titlebar.coreConnected") : connecting ? t("titlebar.coreStarting") : t("titlebar.coreUnavailable");

  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <><header className="titlebar">
      <button className="brandButton" type="button" onClick={() => onPageChange("welcome")} aria-label={t("titlebar.goWelcome")} title={t("titlebar.goWelcome")}>
        <BrandMark className="brandMark" />
        <span className="brandName">GitCrest</span>
      </button>
      <div className="repositoryTabs" role="tablist" aria-label={t("titlebar.openRepositories")}>
        {openRepoIds.map((repoId) => {
          const repository = repositories.find((item) => item.repoId === repoId);
          if (!repository) return null;
          const selected = selectedRepository?.repoId === repoId;
          const active = selected && page === "workspace";
          const displayName = getRepositoryDisplayName(repository.path);
          return (
            <div className={active ? "repositoryTab active" : "repositoryTab"} key={repoId}>
              <button type="button" role="tab" aria-selected={active} title={repository.path} onClick={() => { if (selected) onPageChange("workspace"); else onSelectRepository(repository); }}>
                <svg className="repositoryTabIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M12.5 11V3.25a.75.75 0 0 0-.75-.75H5a1.5 1.5 0 0 0-1.5 1.5v8" /><path d="M3.5 12a1.5 1.5 0 0 1 1.5-1.5h7.5V13.5H5A1.5 1.5 0 0 1 3.5 12Z" /></svg>
                <span className="repositoryTabName">{displayName}</span>
              </button>
              <button type="button" className="closeRepositoryTab" aria-label={t("titlebar.closeTabLabel", { name: displayName })} title={t("titlebar.closeTab")} onClick={() => onCloseRepository(repoId)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg></button>
            </div>
          );
        })}
      </div>
      <NewRepositoryTabMenu
        connected={connected}
        openingRepository={openingRepository}
        shortcuts={shortcuts}
        isMacPlatform={isMacPlatform}
        onOpenLocalRepository={onOpenLocalRepository}
        onCloneRepository={onCloneRepository}
        onInitializeRepository={onInitializeRepository}
      />
      <div className="titlebarSpacer" />
      <button className="quietButton searchShortcut" type="button" onClick={onOpenCommandPalette} aria-keyshortcuts={ariaShortcut(shortcuts.commandPalette, isMacPlatform)}>
        <span aria-hidden="true"><UiIcon name="search" /></span><span>{t("titlebar.searchCommands")}</span><kbd>{displayShortcut(shortcuts.commandPalette, isMacPlatform)}</kbd>
      </button>
      {/* Always reachable for task history; it only draws attention while something runs. */}
      <button className={`quietButton taskCenterButton${activeTaskCount > 0 ? " running" : ""}`} type="button" onClick={onOpenTasks} aria-label={t("titlebar.tasksLabel", { count: activeTaskCount })} title={t("titlebar.tasksLabel", { count: activeTaskCount })}>
        {activeTaskCount > 0 ? <><span className="loadingSpinner small" aria-hidden="true" /><span>{t("shell.tasksRunning", { count: activeTaskCount })}</span></> : <><svg className="titlebarIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6" /></svg><span className="titlebarLabel">{t("titlebar.tasks")}</span></>}
      </button>
      <SettingsMenu shortcuts={shortcuts} isMacPlatform={isMacPlatform} onOpenSettings={onOpenSettings} />
      <button type="button" className="quietButton titlebarHelp" onClick={() => setHelpOpen(true)}>{t("guide.help")}</button>
      {/* A healthy connection is a quiet dot; starting or failing shows its label. */}
      <div className={`connectionBadge ${connected ? "connected" : connecting ? "starting" : "failed"}`} role="status" aria-live="polite" aria-label={status} title={status}>
        <span className="connectionDot" aria-hidden="true" />
        <span className={connected ? "srOnly" : undefined}>{connectionLabel}</span>
      </div>
      {!connected && !connecting && onRestartCore && <button className="quietButton compact" type="button" title={status} onClick={onRestartCore}>{t("titlebar.restartCore")}</button>}
      <WindowControls controls={windowControls} />
    </header>{helpOpen && <QuickGuideDialog shortcuts={shortcuts} isMacPlatform={isMacPlatform} onClose={() => setHelpOpen(false)} />}</>
  );
}
