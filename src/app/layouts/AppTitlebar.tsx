import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences, type Theme } from "../../features/settings";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";
import { useI18n } from "../../shared/i18n";
import { BrandMark } from "../../shared/ui/BrandMark";

export type AppPage = "welcome" | "workspace";

interface AppTitlebarProps {
  page: AppPage;
  openRepoIds: string[];
  repositories: RepositoryResponse[];
  selectedRepository?: RepositoryResponse;
  shortcuts: ShortcutPreferences;
  theme: Theme;
  status: string;
  connected: boolean;
  activeTaskCount: number;
  isMacPlatform: boolean;
  onPageChange: (page: AppPage) => void;
  onSelectRepository: (repository: RepositoryResponse) => void;
  onCloseRepository: (repoId: string) => void;
  onOpenCommandPalette: () => void;
  onCycleTheme: () => void;
  onOpenTasks: () => void;
  onOpenSettings: () => void;
}

export function AppTitlebar({
  page,
  openRepoIds,
  repositories,
  selectedRepository,
  shortcuts,
  theme,
  status,
  connected,
  activeTaskCount,
  isMacPlatform,
  onPageChange,
  onSelectRepository,
  onCloseRepository,
  onOpenCommandPalette,
  onCycleTheme,
  onOpenTasks,
  onOpenSettings,
}: AppTitlebarProps) {
  const { t } = useI18n();
  const connecting = status.startsWith("Starting");
  const connectionLabel = connected ? t("titlebar.coreConnected") : connecting ? t("titlebar.coreStarting") : t("titlebar.coreUnavailable");
  const themeName = theme === "system" ? t("theme.system") : theme === "dark" ? t("theme.dark") : t("theme.light");

  return (
    <header className="titlebar">
      <button className="brandButton" type="button" onClick={() => onPageChange("welcome")} aria-label={t("titlebar.goWelcome")}>
        <BrandMark className="brandMark" />
        <span className="brandName">GitCrest</span>
      </button>
      <nav className="pageTabs" aria-label={t("titlebar.primaryNav")}>
        <button type="button" className={page === "welcome" ? "pageTab active" : "pageTab"} onClick={() => onPageChange("welcome")}>{t("titlebar.welcome")}</button>
        <button type="button" className={page === "workspace" ? "pageTab active" : "pageTab"} onClick={() => onPageChange("workspace")}>{t("titlebar.workspace")}</button>
      </nav>
      <div className="repositoryTabs" role="tablist" aria-label={t("titlebar.openRepositories")}>
        {openRepoIds.map((repoId) => {
          const repository = repositories.find((item) => item.repoId === repoId);
          if (!repository) return null;
          const active = selectedRepository?.repoId === repoId;
          const displayName = getRepositoryDisplayName(repository.path);
          return (
            <div className={active ? "repositoryTab active" : "repositoryTab"} key={repoId}>
              <button type="button" role="tab" aria-selected={active} title={repository.path} onClick={() => { if (!active) onSelectRepository(repository); }}>
                {displayName}
              </button>
              <button type="button" className="closeRepositoryTab" aria-label={t("titlebar.closeTabLabel", { name: displayName })} title={t("titlebar.closeTab")} onClick={() => onCloseRepository(repoId)}>×</button>
            </div>
          );
        })}
      </div>
      <div className="titlebarSpacer" />
      <button className="quietButton searchShortcut" type="button" onClick={onOpenCommandPalette} aria-keyshortcuts={ariaShortcut(shortcuts.commandPalette, isMacPlatform)}>
        <span aria-hidden="true">⌕</span><span>{t("titlebar.searchCommands")}</span><kbd>{displayShortcut(shortcuts.commandPalette, isMacPlatform)}</kbd>
      </button>
      <button className="quietButton themeButton" type="button" onClick={onCycleTheme} aria-label={t("titlebar.themeLabel", { theme: themeName })} title={t("titlebar.themeTitle", { theme: themeName })}>
        <span aria-hidden="true">◐</span><span>{themeName}</span>
      </button>
      <button className="quietButton taskCenterButton" type="button" onClick={onOpenTasks} aria-label={t("titlebar.tasksLabel", { count: activeTaskCount })}>
        {t("titlebar.tasks")} <span className="countBadge">{activeTaskCount}</span>
      </button>
      <button className="quietButton" type="button" onClick={onOpenSettings} aria-keyshortcuts={ariaShortcut(shortcuts.settings, isMacPlatform)} title={t("titlebar.settingsTitle", { shortcut: displayShortcut(shortcuts.settings, isMacPlatform) })}>{t("titlebar.settings")}</button>
      <div className={`connectionBadge ${connected ? "connected" : ""}`} role="status" aria-live="polite" aria-label={status} title={status}>
        <span className="connectionDot" aria-hidden="true" />
        <span>{connectionLabel}</span>
      </div>
    </header>
  );
}
