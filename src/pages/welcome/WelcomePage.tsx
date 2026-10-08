import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings/shortcut-preferences";

interface WelcomePageProps {
  repositories: RepositoryResponse[];
  openingRepository: boolean;
  connected: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  openError: string;
  version?: string;
  onOpenLocalRepository: () => void;
  onCloneRepository: () => void;
  onNavigateWorkspace: () => void;
  onInitializeRepository: () => void;
  onOpenRepository: (repository: RepositoryResponse) => void;
  onToggleFavorite: (repository: RepositoryResponse) => void;
  onForgetRepository: (repository: RepositoryResponse) => void;
}

function repositoryName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

export function WelcomePage({
  repositories,
  openingRepository,
  connected,
  shortcuts,
  isMacPlatform,
  openError,
  version,
  onOpenLocalRepository,
  onCloneRepository,
  onNavigateWorkspace,
  onInitializeRepository,
  onOpenRepository,
  onToggleFavorite,
  onForgetRepository,
}: WelcomePageProps) {
  return (
<section className="welcomePage" aria-labelledby="welcome-title">
          <div className="welcomeIntro">
            <p className="sectionEyebrow">LOCAL GIT WORKSPACE</p>
            <h1 id="welcome-title">Your repositories,<br /><span>in good order.</span></h1>
            <p className="welcomeSummary">Review changes, follow branches, and make deliberate commits from one quiet place.</p>
            <div className="welcomeActions">
              <button className="primaryButton" type="button" disabled={openingRepository} onClick={() => void onOpenLocalRepository()}>
                <span aria-hidden="true">＋</span> {openingRepository ? "Opening repository…" : "Open a repository"}
              </button>
              <button className="secondaryButton" type="button" disabled={!connected} onClick={() => { onCloneRepository() }} aria-keyshortcuts={ariaShortcut(shortcuts.cloneRepository, isMacPlatform)} title={`Clone repository (${displayShortcut(shortcuts.cloneRepository, isMacPlatform)})`}>Clone repository</button>
              <button className="textButton" type="button" onClick={() => onNavigateWorkspace()}>Preview workspace</button>
            </div>
          </div>
          {openError && <div className="openRepositoryError" role="alert">{openError}</div>}
          <div className="welcomeColumns">
            <section className="recentSection" aria-labelledby="recent-heading">
              <div className="sectionHeading">
                <div><p className="sectionEyebrow">YOUR LIBRARY</p><h2 id="recent-heading">Recent repositories</h2></div>
                <span className="quietButton compact" aria-label="Favorites first, then most recently opened">Favorites first</span>
              </div>
              {repositories.length === 0 ? (
                <div className="emptyRepositories">
                  <div className="emptyGlyph" aria-hidden="true"><span /><span /><span /></div>
                  <h3>No repositories yet</h3>
                  <p>Open a local Git repository to see its changes, branches, and history here.</p>
                  <button className="inlineAction" type="button" onClick={() => void onOpenLocalRepository()}>Choose a folder <span aria-hidden="true">→</span></button>
                </div>
              ) : (
                <div className="repositoryList">
                  {repositories.map((repository) => (
                    <div key={repository.repoId} className={`repositoryRow ${repository.availability === "missing" ? "repositoryMissing" : ""}`}>
                      <span className="repoStatusGlyph" aria-hidden="true">{repository.availability === "missing" ? "!" : "●"}</span>
                      <button className="repositoryRowOpen" type="button" disabled={openingRepository || repository.availability === "missing"} onClick={() => void onOpenRepository(repository)}>
                        <span className="repositoryRowText"><strong>{repositoryName(repository.path)}{repository.isFavorite ? " · Favorite" : ""}</strong><small>{repository.availability === "missing" ? `Unavailable · ${repository.path}` : repository.path}</small></span>
                        <span className="repositoryBranch">{repository.availability === "missing" ? "Missing" : repository.detached ? "Detached" : repository.branch || "Unborn"}</span>
                      </button>
                      <button className="repositoryRowAction" type="button" aria-label={repository.isFavorite ? `Remove ${repositoryName(repository.path)} from favorites` : `Favorite ${repositoryName(repository.path)}`} onClick={() => void onToggleFavorite(repository)}>{repository.isFavorite ? "★" : "☆"}</button>
                      {repository.availability === "missing" && <button className="repositoryRowAction" type="button" onClick={() => void onOpenLocalRepository()}>Locate</button>}
                      <button className="repositoryRowAction" type="button" aria-label={`Remove ${repositoryName(repository.path)} from recent repositories`} onClick={() => void onForgetRepository(repository)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <aside className="quickActions" aria-labelledby="quick-heading">
              <div className="sectionHeading"><div><p className="sectionEyebrow">GET STARTED</p><h2 id="quick-heading">Quick actions</h2></div></div>
                <button className="actionRow" type="button" disabled={openingRepository} onClick={() => void onOpenLocalRepository()} aria-keyshortcuts={ariaShortcut(shortcuts.openRepository, isMacPlatform)} title={`Open local repository (${displayShortcut(shortcuts.openRepository, isMacPlatform)})`}>
                <span className="actionIcon" aria-hidden="true">↗</span><span><strong>Open local repository</strong><small>Choose an existing folder</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <button className="actionRow" type="button" disabled={!connected} onClick={() => { onCloneRepository() }}>
                <span className="actionIcon" aria-hidden="true">⇣</span><span><strong>Clone a repository</strong><small>Bring a remote project here</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <button className="actionRow" type="button" disabled={openingRepository} onClick={() => void onInitializeRepository()} aria-keyshortcuts={ariaShortcut(shortcuts.initializeRepository, isMacPlatform)} title={`Initialize a repository (${displayShortcut(shortcuts.initializeRepository, isMacPlatform)})`}>
                <span className="actionIcon" aria-hidden="true">＋</span><span><strong>Initialize a repository</strong><small>Start tracking a new project</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <div className="actionFootnote"><span className="infoIcon" aria-hidden="true">i</span> Initialize creates Git metadata only in the folder you select and keeps its files.</div>
            </aside>
          </div>
          <footer className="welcomeFooter"><span>Private by default</span><span className="footerDivider" /><span>Your repositories stay on this device</span><span className="footerSpacer" /><span>{version || "Local engine"}</span><button type="button" className="textButton" onClick={() => onNavigateWorkspace()}>Explore the workspace <span aria-hidden="true">→</span></button></footer>
        </section>
  );
}

export default WelcomePage;