import { useState, type KeyboardEvent } from "react";
import type { RepositoryResponse } from "../../api/client";
import { ariaShortcut, displayShortcut, type ShortcutPreferences } from "../../features/settings";
import { isRepositoryReadFailure, RepositoryRecoveryPanel, RepositoryRemoveDialog } from "../../features/repositories";
import { getRepositoryDisplayName, repositoryParentLabels } from "../../shared/lib/repository-display-name";
import { useI18n } from "../../shared/i18n";
import { type DisplayError } from "../../shared/i18n/api-errors";
import { ErrorMessage } from "../../shared/ui/ErrorMessage";
import { Button } from "../../shared/ui/Button";
import { Icon } from "../../shared/ui/Icon";

interface WelcomePageProps {
  repositories: RepositoryResponse[];
  openingRepository: boolean;
  connected: boolean;
  shortcuts: ShortcutPreferences;
  isMacPlatform: boolean;
  openError: DisplayError;
  version?: string;
  onOpenLocalRepository: () => void;
  onCloneRepository: () => void;
  onNavigateWorkspace: () => void;
  onInitializeRepository: () => void;
  onOpenRepository: (repository: RepositoryResponse) => void;
  onToggleFavorite: (repository: RepositoryResponse) => void;
  onForgetRepository: (repository: RepositoryResponse) => void;
  onLocateRepository: (repository: RepositoryResponse) => void;
  readErrors?: Record<string, DisplayError>;
}

export function WelcomePage({ repositories, openingRepository, connected, shortcuts, isMacPlatform, openError, version, onOpenLocalRepository, onCloneRepository, onInitializeRepository, onOpenRepository, onToggleFavorite, onForgetRepository, onLocateRepository, readErrors = {} }: WelcomePageProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [removeCandidate, setRemoveCandidate] = useState<RepositoryResponse>();
  const [recoveryCandidate, setRecoveryCandidate] = useState<RepositoryResponse>();
  const unavailable = (repository: RepositoryResponse) => repository.availability === "missing" || Boolean(readErrors[repository.repoId]);
  const recoveryRepository = recoveryCandidate && repositories.find((repository) => repository.repoId === recoveryCandidate.repoId)
    && (unavailable(recoveryCandidate) || isRepositoryReadFailure(openError)) ? recoveryCandidate : undefined;
  const matches = repositories.filter((repository) => `${getRepositoryDisplayName(repository.path)} ${repository.path} ${repository.branch ?? ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const parentLabels = repositoryParentLabels(repositories.map((repository) => repository.path));
  const openRepository = (repository: RepositoryResponse) => { setRecoveryCandidate(repository); onOpenRepository(repository); };
  const openLocal = () => { setRecoveryCandidate(undefined); onOpenLocalRepository(); };
  function rowKeys(event: KeyboardEvent<HTMLElement>) {
    const row = event.currentTarget.closest(".repositoryRow");
    const list = row?.parentElement;
    if (!row || !list) return;
    const rows = [...list.querySelectorAll<HTMLButtonElement>(".repositoryRowOpen:not(:disabled)")];
    const primary = row.querySelector<HTMLButtonElement>(".repositoryRowOpen");
    const index = rows.indexOf(primary!);
    const actions = [...row.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const actionIndex = actions.indexOf(document.activeElement as HTMLButtonElement);
    const target = event.key === "ArrowDown" ? rows[Math.min(index + 1, rows.length - 1)]
      : event.key === "ArrowUp" ? rows[Math.max(0, index - 1)]
        : event.key === "Home" ? rows[0] : event.key === "End" ? rows[rows.length - 1]
          : event.key === "ArrowRight" ? actions[(actionIndex + 1) % actions.length]
            : event.key === "ArrowLeft" ? actions[(actionIndex - 1 + actions.length) % actions.length] : undefined;
    if (target) { event.preventDefault(); target.focus(); target.scrollIntoView?.({ block: "nearest" }); }
  }
  return <section className={`welcomePage${repositories.length ? " hasRepositories" : ""}`} aria-labelledby="welcome-title">
    <div className="welcomeIntro">
      <h1 id="welcome-title">{repositories.length ? t("welcome.recent") : t("welcome.title1")}</h1>
      {!repositories.length && <p>{t("welcome.subtitle")}</p>}
      <div className="welcomeActions" role="group" aria-label={t("welcome.repositoryActions")}>
        <Button variant="primary" disabled={openingRepository} onClick={openLocal} aria-keyshortcuts={ariaShortcut(shortcuts.openRepository, isMacPlatform)} title={t("welcome.openLocalTitle", { shortcut: displayShortcut(shortcuts.openRepository, isMacPlatform) })}><Icon name="plus" />{openingRepository ? t("welcome.opening") : t("welcome.openLocal")}</Button>
        <Button disabled={!connected} onClick={onCloneRepository} aria-keyshortcuts={ariaShortcut(shortcuts.cloneRepository, isMacPlatform)} title={t("welcome.cloneTitle", { shortcut: displayShortcut(shortcuts.cloneRepository, isMacPlatform) })}><Icon name="download" />{t("welcome.clone")}</Button>
        <Button disabled={openingRepository || !connected} onClick={() => { setRecoveryCandidate(undefined); onInitializeRepository(); }} aria-keyshortcuts={ariaShortcut(shortcuts.initializeRepository, isMacPlatform)} title={t("welcome.initTitle", { shortcut: displayShortcut(shortcuts.initializeRepository, isMacPlatform) })}>{t("welcome.init")}</Button>
      </div>
    </div>
    {openError && !recoveryRepository && <div className="welcomeError" role="alert"><ErrorMessage error={openError} /></div>}
    {recoveryRepository && <RepositoryRecoveryPanel repository={recoveryRepository} error={openError || readErrors[recoveryRepository.repoId]} busy={openingRepository || !connected} onLocate={() => onLocateRepository(recoveryRepository)} onRemove={() => setRemoveCandidate(recoveryRepository)} />}
    <section className="recentSection" aria-labelledby={repositories.length ? "welcome-title" : "recent-heading"}>
      {!repositories.length ? <><h2 id="recent-heading" className="recentEmptyHeading">{t("welcome.recent")}</h2><div className="emptyRepositories"><h3>{t("welcome.emptyTitle")}</h3><p>{t("welcome.emptyBody")}</p></div></> : <>
        <div className="recentListHeader">
          <label className="recentSearch"><Icon name="search" /><input type="search" aria-label={t("welcome.searchRecent")} placeholder={t("welcome.searchRecent")} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); document.querySelector<HTMLButtonElement>(".repositoryRowOpen:not(:disabled)")?.focus(); } else if (event.key === "Escape") setQuery(""); }} /></label>
          <span>{t("welcome.favoritesFirst")}</span>
        </div>
        <p className="recentKeyboardHelp" id="recent-keyboard-help">{t("welcome.keyboardHelp")}</p>
        <div className="repositoryList">
          {matches.map((repository) => {
            const missing = unavailable(repository);
            const state = missing ? "missing" : repository.detached ? "detached" : repository.state !== "normal" ? "busy" : "ready";
            return <div className={`repositoryRow repository-${state}`} key={repository.repoId} onKeyDown={rowKeys}>
              <span className="repositoryState" aria-label={t(`welcome.state.${state}`)} title={t(`welcome.state.${state}`)}><svg viewBox="0 0 16 16" aria-hidden="true">{state === "ready" ? <circle cx="8" cy="8" r="3.5" fill="currentColor" /> : <><path d="m8 2 6 11H2Z" /><path d="M8 6v3m0 2v.1" /></>}</svg></span>
              <button className="repositoryRowOpen" type="button" disabled={openingRepository || !connected} aria-describedby="recent-keyboard-help" title={missing ? t("rr.open") : repository.path} onClick={() => openRepository(repository)}>
                <span className="repositoryIdentity"><strong>{getRepositoryDisplayName(repository.path)}{repository.isFavorite ? t("welcome.favoriteSuffix") : ""}{parentLabels.has(repository.path) && <span className="repositoryParent" title={repository.path}> · {parentLabels.get(repository.path)}</span>}</strong><small>{missing ? t("welcome.unavailable", { path: repository.path }) : repository.path}</small></span>
                <span className="repositoryBranch">{!missing && !repository.detached && repository.head && <span className="recentHead">HEAD</span>}{missing ? t("rr.unavailable") : repository.detached ? t("welcome.detached") : repository.branch || t("welcome.unborn")}</span>
              </button>
              <button className="repositoryRowAction" tabIndex={-1} type="button" aria-label={repository.isFavorite ? t("welcome.unfavorite", { name: getRepositoryDisplayName(repository.path) }) : t("welcome.favorite", { name: getRepositoryDisplayName(repository.path) })} onClick={() => void onToggleFavorite(repository)}><Icon name="star" style={{ fill: repository.isFavorite ? "currentColor" : "none" }} /></button>
              {missing && <button className="repositoryRowAction" tabIndex={-1} type="button" disabled={openingRepository || !connected} onClick={() => { setRecoveryCandidate(repository); onLocateRepository(repository); }}>{t("welcome.locate")}</button>}
              <button className="repositoryRowAction" tabIndex={-1} type="button" aria-label={t("welcome.removeRecent", { name: getRepositoryDisplayName(repository.path) })} onClick={() => setRemoveCandidate(repository)}>{t("welcome.remove")}</button>
            </div>;
          })}
          {matches.length === 0 && <p className="recentNoMatches" role="status">{t("welcome.noMatches")}</p>}
        </div>
      </>}
    </section>
    <footer className="welcomeFooter"><span>{t("welcome.private")} · {t("welcome.onDevice")}</span><span>{version || t("welcome.localEngine")}</span></footer>
    {removeCandidate && <RepositoryRemoveDialog repository={removeCandidate} busy={openingRepository || !connected} onClose={() => setRemoveCandidate(undefined)} onConfirm={() => { const candidate = removeCandidate; setRemoveCandidate(undefined); void onForgetRepository(candidate); }} />}
  </section>;
}
export default WelcomePage;
