import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences, type Theme } from "../../features/settings";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";

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
  const connecting = status.startsWith("Starting");
  const connectionLabel = connected ? "Core connected" : connecting ? "Starting core" : "Core unavailable";

  return (
    <header className="titlebar">
      <button className="brandButton" type="button" onClick={() => onPageChange("welcome")} aria-label="Go to Welcome">
        <span className="brandMark" aria-hidden="true">G</span>
        <span className="brandName">GitCrest</span>
      </button>
      <nav className="pageTabs" aria-label="Primary navigation">
        <button type="button" className={page === "welcome" ? "pageTab active" : "pageTab"} onClick={() => onPageChange("welcome")}>Welcome</button>
        <button type="button" className={page === "workspace" ? "pageTab active" : "pageTab"} onClick={() => onPageChange("workspace")}>Workspace</button>
      </nav>
      <div className="repositoryTabs" role="tablist" aria-label="Open repositories">
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
              <button type="button" className="closeRepositoryTab" aria-label={`Close ${displayName} tab`} title="Close tab" onClick={() => onCloseRepository(repoId)}>×</button>
            </div>
          );
        })}
      </div>
      <div className="titlebarSpacer" />
      <button className="quietButton searchShortcut" type="button" onClick={onOpenCommandPalette} aria-keyshortcuts={ariaShortcut(shortcuts.commandPalette, isMacPlatform)}>
        <span aria-hidden="true">⌕</span><span>Search commands</span><kbd>{displayShortcut(shortcuts.commandPalette, isMacPlatform)}</kbd>
      </button>
      <button className="quietButton themeButton" type="button" onClick={onCycleTheme} aria-label={`Color theme: ${theme}. Activate to cycle theme`} title={`Theme: ${theme}`}>
        <span aria-hidden="true">◐</span><span>{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}</span>
      </button>
      <button className="quietButton taskCenterButton" type="button" onClick={onOpenTasks} aria-label={`Background tasks, ${activeTaskCount} active`}>
        Tasks <span className="countBadge">{activeTaskCount}</span>
      </button>
      <button className="quietButton" type="button" onClick={onOpenSettings} aria-keyshortcuts={ariaShortcut(shortcuts.settings, isMacPlatform)} title={`Settings (${displayShortcut(shortcuts.settings, isMacPlatform)})`}>Settings</button>
      <div className={`connectionBadge ${connected ? "connected" : ""}`} role="status" aria-live="polite" aria-label={status} title={status}>
        <span className="connectionDot" aria-hidden="true" />
        <span>{connectionLabel}</span>
      </div>
    </header>
  );
}
