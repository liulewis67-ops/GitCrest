import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";

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
<section className="welcomePage flex min-h-0 flex-col overflow-y-auto px-[clamp(30px,8vw,112px)] pt-[clamp(30px,6vh,64px)] pb-[20px] max-[1120px]:px-[clamp(26px,6vw,72px)] max-[900px]:px-[24px] max-[900px]:pt-[30px] max-[900px]:pb-[16px]" aria-labelledby="welcome-title">
          <div className="welcomeIntro max-w-[710px]">
            <p className="m-0 mb-[10px] text-muted text-[9px] font-[750] tracking-[.14em]">LOCAL GIT WORKSPACE</p>
            <h1 id="welcome-title" className="m-0 text-[clamp(32px,4.2vw,49px)] font-[610] tracking-[-0.055em] leading-[1.07]">Your repositories,<br /><span className="text-foreground-secondary font-[480]">in good order.</span></h1>
            <p className="mt-[15px] max-w-[450px] text-[13px] leading-[1.7] text-foreground-secondary">Review changes, follow branches, and make deliberate commits from one quiet place.</p>
            <div className="mt-[22px] flex flex-wrap items-center gap-[9px]">
              <button className="primaryButton" type="button" disabled={openingRepository} onClick={() => void onOpenLocalRepository()}>
                <span aria-hidden="true">＋</span> {openingRepository ? "Opening repository…" : "Open a repository"}
              </button>
              <button className="secondaryButton" type="button" disabled={!connected} onClick={() => { onCloneRepository() }} aria-keyshortcuts={ariaShortcut(shortcuts.cloneRepository, isMacPlatform)} title={`Clone repository (${displayShortcut(shortcuts.cloneRepository, isMacPlatform)})`}>Clone repository</button>
              <button className="textButton" type="button" onClick={() => onNavigateWorkspace()}>Preview workspace</button>
            </div>
          </div>
          {openError && <div className="openRepositoryError" role="alert">{openError}</div>}
          <div className="welcomeColumns grid grid-cols-[minmax(0,1.5fr)_minmax(280px,0.86fr)] gap-[clamp(30px,6vw,88px)] mt-[clamp(44px,8vh,76px)] max-[1120px]:gap-[32px] max-[900px]:grid-cols-[minmax(0,1fr)] max-[900px]:gap-[26px] max-[900px]:mt-[36px]">
            <section className="recentSection min-w-0" aria-labelledby="recent-heading">
              <div className="flex min-h-[42px] items-center justify-between border-b border-line pb-[11px]">
                <div><p className="m-0 mb-[5px] text-muted text-[9px] font-[750] tracking-[.14em]">YOUR LIBRARY</p><h2 id="recent-heading" className="m-0 text-[13px] font-[620] tracking-[-.02em]">Recent repositories</h2></div>
                <span className="quietButton compact" aria-label="Favorites first, then most recently opened">Favorites first</span>
              </div>
              {repositories.length === 0 ? (
                <div className="emptyRepositories">
                  <div className="emptyGlyph" aria-hidden="true"><span /><span /><span /></div>
                  <h3>No repositories yet</h3>
                  <p className="text-muted">Open a local Git repository to see its changes, branches, and history here.</p>
                  <button className="inlineAction" type="button" onClick={() => void onOpenLocalRepository()}>Choose a folder <span aria-hidden="true">→</span></button>
                </div>
              ) : (
                <div className="repositoryList">
                  {repositories.map((repository) => (
                    <div key={repository.repoId} className={`repositoryRow ${repository.availability === "missing" ? "repositoryMissing" : ""}`}>
                      <span className="repoStatusGlyph" aria-hidden="true">{repository.availability === "missing" ? "!" : "●"}</span>
                      <button className="repositoryRowOpen" type="button" disabled={openingRepository || repository.availability === "missing"} onClick={() => void onOpenRepository(repository)}>
                        <span className="repositoryRowText"><strong>{getRepositoryDisplayName(repository.path)}{repository.isFavorite ? " · Favorite" : ""}</strong><small>{repository.availability === "missing" ? `Unavailable · ${repository.path}` : repository.path}</small></span>
                        <span className="repositoryBranch">{repository.availability === "missing" ? "Missing" : repository.detached ? "Detached" : repository.branch || "Unborn"}</span>
                      </button>
                      <button className="repositoryRowAction" type="button" aria-label={repository.isFavorite ? `Remove ${getRepositoryDisplayName(repository.path)} from favorites` : `Favorite ${getRepositoryDisplayName(repository.path)}`} onClick={() => void onToggleFavorite(repository)}>{repository.isFavorite ? "★" : "☆"}</button>
                      {repository.availability === "missing" && <button className="repositoryRowAction" type="button" onClick={() => void onOpenLocalRepository()}>Locate</button>}
                      <button className="repositoryRowAction" type="button" aria-label={`Remove ${getRepositoryDisplayName(repository.path)} from recent repositories`} onClick={() => void onForgetRepository(repository)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <aside className="quickActions min-w-0" aria-labelledby="quick-heading">
              <div className="flex min-h-[42px] items-center justify-between border-b border-line pb-[11px]">
                <div><p className="m-0 mb-[5px] text-muted text-[9px] font-[750] tracking-[.14em]">GET STARTED</p><h2 id="quick-heading" className="m-0 text-[13px] font-[620] tracking-[-.02em]">Quick actions</h2></div>
              </div>
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
          <footer className="mt-auto flex items-center gap-[12px] pt-[28px] text-[9px] text-muted">
            <span className="max-[560px]:hidden">Private by default</span>
            <span className="footerDivider max-[560px]:hidden" />
            <span className="max-[560px]:hidden">Your repositories stay on this device</span>
            <span className="footerSpacer" />
            <span className="max-[560px]:hidden">{version || "Local engine"}</span>
            <button type="button" className="textButton" onClick={() => onNavigateWorkspace()}>Explore the workspace <span aria-hidden="true">→</span></button>
          </footer>
        </section>
  );
}

export default WelcomePage;
