import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";
import { useI18n } from "../../shared/i18n";
import { BrandMark } from "../../shared/ui/BrandMark";
import { NewRepositoryTabMenu } from "./NewRepositoryTabMenu";

export type AppPage = "welcome" | "workspace";

interface AppTitlebarProps {
  page: AppPage;
  openRepoIds: string[];
  repositories: RepositoryResponse[];
  selectedRepository?: RepositoryResponse;
  shortcuts: ShortcutPreferences;
  status: string;
  connected: boolean;
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
  const connecting = status.startsWith("Starting");
  const connectionLabel = connected ? t("titlebar.coreConnected") : connecting ? t("titlebar.coreStarting") : t("titlebar.coreUnavailable");

  return (
    <header className="titlebar">
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
                {displayName}
              </button>
              <button type="button" className="closeRepositoryTab" aria-label={t("titlebar.closeTabLabel", { name: displayName })} title={t("titlebar.closeTab")} onClick={() => onCloseRepository(repoId)}>×</button>
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
        <span aria-hidden="true">⌕</span><span>{t("titlebar.searchCommands")}</span><kbd>{displayShortcut(shortcuts.commandPalette, isMacPlatform)}</kbd>
      </button>
      {/* Always reachable for task history; it only draws attention while something runs. */}
      <button className={`quietButton taskCenterButton${activeTaskCount > 0 ? " running" : ""}`} type="button" onClick={onOpenTasks} aria-label={t("titlebar.tasksLabel", { count: activeTaskCount })} title={t("titlebar.tasksLabel", { count: activeTaskCount })}>
        {activeTaskCount > 0 ? <><span className="loadingSpinner small" aria-hidden="true" /><span>{t("shell.tasksRunning", { count: activeTaskCount })}</span></> : <><svg className="titlebarIcon" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6" /></svg><span className="titlebarLabel">{t("titlebar.tasks")}</span></>}
      </button>
      <button className="quietButton settingsButton" type="button" onClick={onOpenSettings} aria-label={t("titlebar.settings")} aria-keyshortcuts={ariaShortcut(shortcuts.settings, isMacPlatform)} title={t("titlebar.settingsTitle", { shortcut: displayShortcut(shortcuts.settings, isMacPlatform) })}><svg className="titlebarIcon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.25" /><path d="M8 1.75v1.5M8 12.75v1.5M14.25 8h-1.5M3.25 8h-1.5M12.42 3.58l-1.06 1.06M4.64 11.36l-1.06 1.06M12.42 12.42l-1.06-1.06M4.64 4.64 3.58 3.58" /></svg></button>
      {/* A healthy connection is a quiet dot; starting or failing shows its label. */}
      <div className={`connectionBadge ${connected ? "connected" : connecting ? "starting" : "failed"}`} role="status" aria-live="polite" aria-label={status} title={status}>
        <span className="connectionDot" aria-hidden="true" />
        <span className={connected ? "srOnly" : undefined}>{connectionLabel}</span>
      </div>
    </header>
  );
}
