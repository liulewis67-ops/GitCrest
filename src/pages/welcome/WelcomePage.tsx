import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { getRepositoryDisplayName } from "../../shared/lib/repository-display-name";
import { useI18n } from "../../shared/i18n";

const REPOSITORY_ROW_ACTION_CLASS_NAME = "repositoryRowAction min-h-[28px] rounded-[4px] border border-transparent bg-transparent px-[5px] text-muted text-xs cursor-pointer hover:border-line-strong hover:text-foreground";
const QUICK_ACTION_CLASS_NAME = "actionRow grid grid-cols-[31px_minmax(0,1fr)_auto] items-center w-full min-h-[58px] border-b border-line bg-transparent px-[4px] py-[8px] text-left enabled:hover:bg-surface-soft";
const QUICK_ACTION_ICON_CLASS_NAME = "actionIcon grid place-items-center w-[24px] h-[24px] border border-line rounded-[6px] text-accent-strong text-[14px]";
const QUICK_ACTION_ARROW_CLASS_NAME = "text-muted text-sm";

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
  const { t } = useI18n();
  return (
<section className="welcomePage flex min-h-0 flex-col overflow-y-auto px-[clamp(30px,8vw,112px)] pt-[clamp(30px,6vh,64px)] pb-[20px] max-[1120px]:px-[clamp(26px,6vw,72px)] max-[900px]:px-[24px] max-[900px]:pt-[30px] max-[900px]:pb-[16px]" aria-labelledby="welcome-title">
          <div className="welcomeIntro max-w-[710px]">
            <p className="m-0 mb-[10px] text-muted text-xs font-[750]">{t("welcome.eyebrow")}</p>
            <h1 id="welcome-title" className="m-0 text-[clamp(32px,4.2vw,49px)] font-[610] tracking-[-0.055em] leading-[1.07] max-[900px]:text-[35px]">{t("welcome.title1")}<br /><span className="text-foreground-secondary font-[480]">{t("welcome.title2")}</span></h1>
            <p className="mt-[15px] max-w-[450px] text-sm leading-[1.7] text-foreground-secondary">{t("welcome.subtitle")}</p>
            <div className="mt-[22px] flex flex-wrap items-center gap-[9px]">
              <button className="primaryButton" type="button" disabled={openingRepository} onClick={() => void onOpenLocalRepository()}>
                <span aria-hidden="true">＋</span> {openingRepository ? t("welcome.opening") : t("welcome.open")}
              </button>
              <button className="secondaryButton" type="button" disabled={!connected} onClick={() => { onCloneRepository() }} aria-keyshortcuts={ariaShortcut(shortcuts.cloneRepository, isMacPlatform)} title={t("welcome.cloneTitle", { shortcut: displayShortcut(shortcuts.cloneRepository, isMacPlatform) })}>{t("welcome.clone")}</button>
              <button className="textButton" type="button" onClick={() => onNavigateWorkspace()}>{t("welcome.previewWorkspace")}</button>
            </div>
          </div>
          {openError && <div className="max-w-[720px] mt-[13px] border border-[color-mix(in_srgb,var(--danger),transparent_55%)] rounded-[5px] bg-[color-mix(in_srgb,var(--danger),transparent_93%)] px-[11px] py-[9px] text-danger text-sm" role="alert">{openError}</div>}
          <div className="welcomeColumns grid grid-cols-[minmax(0,1.5fr)_minmax(280px,0.86fr)] gap-[clamp(30px,6vw,88px)] mt-[clamp(44px,8vh,76px)] max-[1120px]:gap-[32px] max-[900px]:grid-cols-[minmax(0,1fr)] max-[900px]:gap-[26px] max-[900px]:mt-[36px]">
            <section className="recentSection min-w-0" aria-labelledby="recent-heading">
              <div className="flex min-h-[42px] items-center justify-between border-b border-line pb-[11px]">
                <div><p className="m-0 mb-[5px] text-muted text-xs font-[750]">{t("welcome.library")}</p><h2 id="recent-heading" className="m-0 text-sm font-[620] tracking-[-.02em]">{t("welcome.recent")}</h2></div>
                <span className="quietButton compact" aria-label={t("welcome.favoritesFirstLabel")}>{t("welcome.favoritesFirst")}</span>
              </div>
              {repositories.length === 0 ? (
                <div className="emptyRepositories grid justify-items-center px-[22px] pt-[42px] pb-[34px] text-center max-[900px]:px-[12px] max-[900px]:py-[25px]">
                  <svg className="mb-[13px] h-[42px] w-[52px] flex-none" viewBox="0 0 52 42" aria-hidden="true">
                    <rect x="9" y="1" width="31" height="23" rx="5" transform="rotate(-8 24.5 12.5)" className="fill-surface stroke-line-strong" strokeWidth="1" />
                    <rect x="13" y="6" width="31" height="23" rx="5" transform="rotate(5 28.5 17.5)" className="fill-surface stroke-line-strong" strokeWidth="1" />
                    <rect x="10" y="11" width="31" height="23" rx="5" className="fill-raised stroke-line-strong" strokeWidth="1" />
                    <path d="m17 23 6-1.5 6 5.5" className="fill-none stroke-accent" strokeWidth="1" />
                  </svg>
                  <h3 className="m-0 text-sm font-[620]">{t("welcome.emptyTitle")}</h3>
                  <p className="m-[7px_0_9px] max-w-[310px] text-sm leading-[1.6] text-muted">{t("welcome.emptyBody")}</p>
                  <button className="border-0 bg-transparent p-[3px] text-accent-strong text-sm" type="button" onClick={() => void onOpenLocalRepository()}>{t("welcome.chooseFolder")} <span aria-hidden="true">→</span></button>
                </div>
              ) : (
                <div className="repositoryList grid pt-[5px]">
                  {repositories.map((repository) => (
                    <div key={repository.repoId} className="repositoryRow grid grid-cols-[15px_minmax(0,1fr)_auto_auto_auto] items-center gap-[7px] min-h-[54px] px-[4px] py-[5px] border-b border-line hover:bg-surface-soft">
                      <span className={`text-2xs ${repository.availability === "missing" ? "text-warning" : "text-green"}`} aria-hidden="true">{repository.availability === "missing" ? "!" : "●"}</span>
                      <button className="repositoryRowOpen grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[9px] min-w-0 min-h-[42px] border-0 bg-transparent px-0 py-[4px] text-left cursor-pointer disabled:cursor-default" type="button" disabled={openingRepository || repository.availability === "missing"} onClick={() => void onOpenRepository(repository)}>
                        <span className="min-w-0"><strong className="block overflow-hidden text-ellipsis whitespace-nowrap text-foreground-secondary text-sm font-[620]">{getRepositoryDisplayName(repository.path)}{repository.isFavorite ? t("welcome.favoriteSuffix") : ""}</strong><small className={`mt-[3px] block overflow-hidden text-ellipsis whitespace-nowrap text-xs ${repository.availability === "missing" ? "text-warning" : "text-muted"}`}>{repository.availability === "missing" ? t("welcome.unavailable", { path: repository.path }) : repository.path}</small></span>
                        <span className="repositoryBranch max-w-[112px] overflow-hidden text-muted text-xs text-ellipsis whitespace-nowrap">{repository.availability === "missing" ? t("welcome.missing") : repository.detached ? t("welcome.detached") : repository.branch || t("welcome.unborn")}</span>
                      </button>
                      <button className={REPOSITORY_ROW_ACTION_CLASS_NAME} type="button" aria-label={repository.isFavorite ? t("welcome.unfavorite", { name: getRepositoryDisplayName(repository.path) }) : t("welcome.favorite", { name: getRepositoryDisplayName(repository.path) })} onClick={() => void onToggleFavorite(repository)}>{repository.isFavorite ? "★" : "☆"}</button>
                      {repository.availability === "missing" && <button className={REPOSITORY_ROW_ACTION_CLASS_NAME} type="button" onClick={() => void onOpenLocalRepository()}>{t("welcome.locate")}</button>}
                      <button className={REPOSITORY_ROW_ACTION_CLASS_NAME} type="button" aria-label={t("welcome.removeRecent", { name: getRepositoryDisplayName(repository.path) })} onClick={() => void onForgetRepository(repository)}>{t("welcome.remove")}</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <aside className="quickActions min-w-0" aria-labelledby="quick-heading">
              <div className="flex min-h-[42px] items-center justify-between border-b border-line pb-[11px]">
                <div><p className="m-0 mb-[5px] text-muted text-xs font-[750]">{t("welcome.getStarted")}</p><h2 id="quick-heading" className="m-0 text-sm font-[620] tracking-[-.02em]">{t("welcome.quickActions")}</h2></div>
              </div>
                <button className={QUICK_ACTION_CLASS_NAME} type="button" disabled={openingRepository} onClick={() => void onOpenLocalRepository()} aria-keyshortcuts={ariaShortcut(shortcuts.openRepository, isMacPlatform)} title={t("welcome.openLocalTitle", { shortcut: displayShortcut(shortcuts.openRepository, isMacPlatform) })}>
                <span className={QUICK_ACTION_ICON_CLASS_NAME} aria-hidden="true">↗</span><span><strong className="block text-foreground-secondary text-sm font-[620]">{t("welcome.openLocal")}</strong><small className="mt-[3px] block text-muted text-xs">{t("welcome.openLocalHint")}</small></span><span className={QUICK_ACTION_ARROW_CLASS_NAME} aria-hidden="true">→</span>
              </button>
              <button className={QUICK_ACTION_CLASS_NAME} type="button" disabled={!connected} onClick={() => { onCloneRepository() }}>
                <span className={QUICK_ACTION_ICON_CLASS_NAME} aria-hidden="true">⇣</span><span><strong className="block text-foreground-secondary text-sm font-[620]">{t("welcome.cloneAction")}</strong><small className="mt-[3px] block text-muted text-xs">{t("welcome.cloneHint")}</small></span><span className={QUICK_ACTION_ARROW_CLASS_NAME} aria-hidden="true">→</span>
              </button>
              <button className={QUICK_ACTION_CLASS_NAME} type="button" disabled={openingRepository} onClick={() => void onInitializeRepository()} aria-keyshortcuts={ariaShortcut(shortcuts.initializeRepository, isMacPlatform)} title={t("welcome.initTitle", { shortcut: displayShortcut(shortcuts.initializeRepository, isMacPlatform) })}>
                <span className={QUICK_ACTION_ICON_CLASS_NAME} aria-hidden="true">＋</span><span><strong className="block text-foreground-secondary text-sm font-[620]">{t("welcome.init")}</strong><small className="mt-[3px] block text-muted text-xs">{t("welcome.initHint")}</small></span><span className={QUICK_ACTION_ARROW_CLASS_NAME} aria-hidden="true">→</span>
              </button>
              <div className="flex items-start gap-[7px] mt-[13px] text-muted text-xs leading-[1.5]"><span className="inline-grid flex-none place-items-center w-[14px] h-[14px] border border-line-strong rounded-full text-2xs" aria-hidden="true">i</span> {t("welcome.initNote")}</div>
            </aside>
          </div>
          <footer className="mt-auto flex items-center gap-[12px] pt-[28px] text-xs text-muted">
            <span className="max-[560px]:hidden">{t("welcome.private")}</span>
            <span className="footerDivider max-[560px]:hidden" />
            <span className="max-[560px]:hidden">{t("welcome.onDevice")}</span>
            <span className="footerSpacer" />
            <span className="max-[560px]:hidden">{version || t("welcome.localEngine")}</span>
            <button type="button" className="textButton" onClick={() => onNavigateWorkspace()}>{t("welcome.explore")} <span aria-hidden="true">→</span></button>
          </footer>
        </section>
  );
}

export default WelcomePage;
