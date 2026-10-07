import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { GitCrestApiClient, GitCrestApiError, type RepositoryResponse } from "./api/client";
import type { components } from "./api/schema";
import "./App.css";

type Theme = "system" | "light" | "dark";
type Page = "welcome" | "workspace";
type WorkspaceMode = "graph" | "diff";
type RepositoryTabState = { mode: WorkspaceMode; selectedCommit?: string; graphScrollTop: number };
type WorkspaceSession = { openRepoIds: string[]; activeRepoId?: string; tabs: Record<string, RepositoryTabState> };

const WORKSPACE_SESSION_KEY = "gitcrest-workspace-session-v1";

function readWorkspaceSession(): WorkspaceSession {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(WORKSPACE_SESSION_KEY) || "null");
    if (!value || typeof value !== "object") return { openRepoIds: [], tabs: {} };
    const session = value as Partial<WorkspaceSession>;
    const openRepoIds = Array.isArray(session.openRepoIds)
      ? [...new Set(session.openRepoIds.filter((id): id is string => typeof id === "string"))]
      : [];
    const tabs: WorkspaceSession["tabs"] = {};
    if (session.tabs && typeof session.tabs === "object") {
      for (const [repoId, state] of Object.entries(session.tabs)) {
        if (!state || typeof state !== "object") continue;
        const candidate = state as Partial<RepositoryTabState>;
        tabs[repoId] = {
          mode: candidate.mode === "diff" ? "diff" : "graph",
          ...(typeof candidate.selectedCommit === "string" ? { selectedCommit: candidate.selectedCommit } : {}),
          graphScrollTop: typeof candidate.graphScrollTop === "number" && Number.isFinite(candidate.graphScrollTop)
            ? Math.max(0, candidate.graphScrollTop)
            : 0,
        };
      }
    }
    return {
      openRepoIds,
      ...(typeof session.activeRepoId === "string" ? { activeRepoId: session.activeRepoId } : {}),
      tabs,
    };
  } catch {
    return { openRepoIds: [], tabs: {} };
  }
}

const themeCycle: Theme[] = ["system", "light", "dark"];

function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  } catch {
    return fallback;
  }
}

function repositoryName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

function ResizeSeparator({
  orientation,
  edge,
  value,
  min,
  max,
  label,
  onResize,
}: {
  orientation: "vertical" | "horizontal";
  edge: "left" | "right" | "bottom";
  value: number;
  min: number;
  max: number;
  label: string;
  onResize: (value: number) => void;
}) {
  const drag = useRef<{ pointerId: number; coordinate: number; value: number }>();

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      coordinate: orientation === "vertical" ? event.clientX : event.clientY,
      value,
    };
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== event.pointerId) return;
    const sign = edge === "left" ? 1 : -1;
    const delta = orientation === "horizontal"
      ? (event.clientY - drag.current.coordinate) * (edge === "bottom" ? -1 : 1)
      : (event.clientX - drag.current.coordinate) * sign;
    onResize(Math.max(min, Math.min(max, drag.current.value + delta)));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const increaseKeys = orientation === "vertical" ? ["ArrowRight", "ArrowUp"] : ["ArrowUp", "ArrowRight"];
    const decreaseKeys = orientation === "vertical" ? ["ArrowLeft", "ArrowDown"] : ["ArrowDown", "ArrowLeft"];
    if (increaseKeys.includes(event.key)) {
      event.preventDefault();
      onResize(Math.min(max, value + 16));
    } else if (decreaseKeys.includes(event.key)) {
      event.preventDefault();
      onResize(Math.max(min, value - 16));
    } else if (event.key === "Home") {
      event.preventDefault();
      onResize(min);
    } else if (event.key === "End") {
      event.preventDefault();
      onResize(max);
    }
  }

  return (
    <div
      className={`resizeSeparator ${orientation}`}
      role="separator"
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => { drag.current = undefined; }}
      onPointerCancel={() => { drag.current = undefined; }}
      onKeyDown={onKeyDown}
    />
  );
}

function App() {
  const commandKey = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";
  const [status, setStatus] = useState("Starting local GitCrest core...");
  const [version, setVersion] = useState("");
  const [repositories, setRepositories] = useState<RepositoryResponse[]>([]);
  const [selectedRepository, setSelectedRepository] = useState<RepositoryResponse>();
  const [openError, setOpenError] = useState("");
  const [openingRepository, setOpeningRepository] = useState(false);
  const apiRef = useRef<GitCrestApiClient>();
  const [page, setPage] = useState<Page>("welcome");
  const [workspaceSession, setWorkspaceSession] = useState<WorkspaceSession>(readWorkspaceSession);
  const workspaceSessionRef = useRef(workspaceSession);
  workspaceSessionRef.current = workspaceSession;
  const mode = selectedRepository ? workspaceSession.tabs[selectedRepository.repoId]?.mode || "graph" : "graph";
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const stored = window.localStorage.getItem("gitcrest-theme");
      return stored === "light" || stored === "dark" ? stored : "system";
    } catch {
      return "system";
    }
  });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [sidebarWidth, setSidebarWidth] = useState(() => readStoredNumber("gitcrest-sidebar-width", 236, 190, 340));
  const [detailsWidth, setDetailsWidth] = useState(() => readStoredNumber("gitcrest-details-width", 284, 220, 420));
  const [workbenchHeight, setWorkbenchHeight] = useState(() => readStoredNumber("gitcrest-workbench-height", 204, 144, 360));
  const [layoutLoadedFor, setLayoutLoadedFor] = useState<string>();
  const connected = status === "Connected to local Rust core";
  const connecting = status.startsWith("Starting");
  const connectionLabel = connected ? "Core connected" : connecting ? "Starting core" : "Core unavailable";

  function activateRepository(repository: RepositoryResponse) {
    setOpenError("");
    setWorkspaceSession((current) => ({
      ...current,
      openRepoIds: [...current.openRepoIds.filter((repoId) => repoId !== repository.repoId), repository.repoId],
      activeRepoId: repository.repoId,
      tabs: {
        ...current.tabs,
        [repository.repoId]: current.tabs[repository.repoId] || { mode: "graph", graphScrollTop: 0 },
      },
    }));
    setSelectedRepository(repository);
    setPage("workspace");
  }

  function changeWorkspaceMode(nextMode: WorkspaceMode) {
    if (!selectedRepository) {
      setPage("workspace");
      return;
    }
    setWorkspaceSession((current) => ({
      ...current,
      tabs: {
        ...current.tabs,
        [selectedRepository.repoId]: {
          ...(current.tabs[selectedRepository.repoId] || { graphScrollTop: 0 }),
          mode: nextMode,
        },
      },
    }));
  }

  function closeRepositoryTab(repoId: string) {
    const current = workspaceSessionRef.current;
    const openRepoIds = current.openRepoIds.filter((id) => id !== repoId);
    const closingActive = current.activeRepoId === repoId;
    const nextActiveRepoId = closingActive
      ? openRepoIds[openRepoIds.length - 1]
      : current.activeRepoId;
    const nextRepository = repositories.find((repository) => repository.repoId === nextActiveRepoId);
    setWorkspaceSession({ ...current, openRepoIds, activeRepoId: nextActiveRepoId });
    if (closingActive) setSelectedRepository(nextRepository);
    if (closingActive && page === "workspace") setPage(nextRepository ? "workspace" : "welcome");
  }

  async function openLocalRepository() {
    setOpenError("");
    try {
      const path = await window.gitcrest.chooseRepository();
      if (!path) return;
      const api = apiRef.current;
      if (!api) throw new Error("The Git engine is still starting. Try again in a moment.");
      setOpeningRepository(true);
      const repository = await api.openRepository(path);
      setRepositories((current) => [repository, ...current.filter((item) => item.repoId !== repository.repoId)]);
      activateRepository(repository);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setOpenError(message || (error instanceof Error ? error.message : "Could not open this repository."));
    } finally {
      setOpeningRepository(false);
    }
  }

  async function initializeLocalRepository() {
    setOpenError("");
    try {
      const path = await window.gitcrest.chooseRepository();
      if (!path) return;
      const api = apiRef.current;
      if (!api) throw new Error("The Git engine is still starting. Try again in a moment.");
      setOpeningRepository(true);
      const repository = await api.initializeRepository(path);
      setRepositories((current) => [repository, ...current.filter((item) => item.repoId !== repository.repoId)]);
      activateRepository(repository);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setOpenError(message || (error instanceof Error ? error.message : "Could not initialize this folder."));
    } finally {
      setOpeningRepository(false);
    }
  }

  async function toggleFavorite(repository: RepositoryResponse) {
    const api = apiRef.current;
    if (!api) return;
    setOpenError("");
    try {
      const updated = await api.setRepositoryFavorite(repository.repoId, !repository.isFavorite);
      setRepositories((current) => current.map((item) => item.repoId === updated.repoId ? updated : item)
        .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || right.lastAccessedAt - left.lastAccessedAt));
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not update this favorite.");
    }
  }

  async function forgetRepository(repository: RepositoryResponse) {
    const api = apiRef.current;
    if (!api) return;
    setOpenError("");
    try {
      await api.forgetRepository(repository.repoId);
      setRepositories((current) => current.filter((item) => item.repoId !== repository.repoId));
      setSelectedRepository((current) => current?.repoId === repository.repoId ? undefined : current);
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Could not remove this recent repository.");
    }
  }

  async function openRecentRepository(repository: RepositoryResponse) {
    const api = apiRef.current;
    if (!api || repository.availability !== "available") return;
    setOpenError("");
    setOpeningRepository(true);
    try {
      const opened = await api.getRepository(repository.repoId);
      setRepositories((current) => [opened, ...current.filter((item) => item.repoId !== opened.repoId)]
        .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || right.lastAccessedAt - left.lastAccessedAt));
      activateRepository(opened);
    } catch (error) {
      const message = error instanceof GitCrestApiError ? error.body.error.message : undefined;
      setOpenError(message || (error instanceof Error ? error.message : "Could not reopen this repository."));
      void refreshRepositories(api).catch(() => undefined);
    } finally {
      setOpeningRepository(false);
    }
  }

  async function refreshRepositories(api: GitCrestApiClient, restoreWorkspace = false) {
    const currentRepositories = await api.listRepositories();
    setRepositories(currentRepositories);
    if (restoreWorkspace) {
      const saved = workspaceSessionRef.current;
      const availableIds = saved.openRepoIds.filter((repoId) =>
        currentRepositories.some((repository) => repository.repoId === repoId && repository.availability === "available"));
      const activeRepoId = saved.activeRepoId && availableIds.includes(saved.activeRepoId)
        ? saved.activeRepoId
        : availableIds[availableIds.length - 1];
      const activeRepository = currentRepositories.find((repository) => repository.repoId === activeRepoId);
      setWorkspaceSession({ ...saved, openRepoIds: availableIds, activeRepoId });
      setSelectedRepository(activeRepository);
      setPage(activeRepository ? "workspace" : "welcome");
    } else {
      setSelectedRepository((current) => currentRepositories.find((repository) => repository.repoId === current?.repoId));
    }
  }

  useEffect(() => {
    let cancelled = false;
    let unsubscribeFromEvents: (() => void) | undefined;

    async function connect() {
      try {
        const connection = await window.gitcrest.getSidecarConnection();
        const api = new GitCrestApiClient(connection.baseUrl, connection.token);
        apiRef.current = api;
        const body = await api.getVersion();
        if (!cancelled) {
          setVersion(`${body.name} ${body.version} (API v${body.apiVersion})`);
          setStatus("Connected to local Rust core");
        }
        await refreshRepositories(api, true);

        const unsubscribe = await window.gitcrest.subscribeToEvents((event: components["schemas"]["EventEnvelope"]) => {
          if (event.type === "connection.resyncRequired") {
            void refreshRepositories(api).catch((syncError: unknown) => {
              if (!cancelled) {
                setStatus(syncError instanceof Error ? syncError.message : "Failed to refresh repository state");
              }
            });
          }
        });
        if (cancelled) unsubscribe();
        else unsubscribeFromEvents = unsubscribe;
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Failed to connect to local Rust core");
      }
    }

    void connect();
    return () => {
      cancelled = true;
      apiRef.current = undefined;
      unsubscribeFromEvents?.();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_SESSION_KEY, JSON.stringify(workspaceSession));
    } catch {
      // Repository tabs remain available for this session if local storage is unavailable.
    }
  }, [workspaceSession]);

  useEffect(() => {
    const systemTheme = typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: light)")
      : undefined;
    const applyTheme = () => {
      document.documentElement.dataset.theme = theme === "system" ? (systemTheme?.matches ? "light" : "dark") : theme;
    };
    applyTheme();
    systemTheme?.addEventListener("change", applyTheme);
    try {
      window.localStorage.setItem("gitcrest-theme", theme);
    } catch {
      // The theme remains available for this session when storage is unavailable.
    }
    return () => systemTheme?.removeEventListener("change", applyTheme);
  }, [theme]);

  useEffect(() => {
    const repoId = selectedRepository?.repoId;
    if (!repoId) {
      setLayoutLoadedFor(undefined);
      return;
    }
    setLayoutLoadedFor(undefined);
    setSidebarWidth(readStoredNumber(`gitcrest-layout-${repoId}-sidebar-width`, readStoredNumber("gitcrest-sidebar-width", 236, 190, 340), 190, 340));
    setDetailsWidth(readStoredNumber(`gitcrest-layout-${repoId}-details-width`, readStoredNumber("gitcrest-details-width", 284, 220, 420), 220, 420));
    setWorkbenchHeight(readStoredNumber(`gitcrest-layout-${repoId}-workbench-height`, readStoredNumber("gitcrest-workbench-height", 204, 144, 360), 144, 360));
    setLayoutLoadedFor(repoId);
  }, [selectedRepository?.repoId]);

  useEffect(() => {
    const repoId = selectedRepository?.repoId;
    if (!repoId || layoutLoadedFor !== repoId) return;
    try {
      window.localStorage.setItem(`gitcrest-layout-${repoId}-sidebar-width`, String(sidebarWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-details-width`, String(detailsWidth));
      window.localStorage.setItem(`gitcrest-layout-${repoId}-workbench-height`, String(workbenchHeight));
    } catch {
      // Layout resizing remains available for this session if storage is unavailable.
    }
  }, [layoutLoadedFor, selectedRepository?.repoId, sidebarWidth, detailsWidth, workbenchHeight]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        setPaletteQuery("");
      } else if (event.key === "Escape") {
        setPaletteOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const layoutStyle = {
    "--sidebar-width": `${sidebarWidth}px`,
    "--details-width": `${detailsWidth}px`,
    "--workbench-height": `${workbenchHeight}px`,
  } as CSSProperties;

  const nextTheme = () => setTheme(themeCycle[(themeCycle.indexOf(theme) + 1) % themeCycle.length]);
  const commands = [
    { id: "welcome", label: "Go to Welcome", detail: "Return to recent repositories and quick actions", available: true, run: () => setPage("welcome") },
    { id: "workspace", label: "Go to Workspace", detail: "Open the Changes, Graph, and Commit workspace", available: true, run: () => setPage("workspace") },
    { id: "theme", label: "Cycle color theme", detail: `Current: ${theme}; next: ${themeCycle[(themeCycle.indexOf(theme) + 1) % themeCycle.length]}`, available: true, run: nextTheme },
    { id: "open", label: "Open local repository", detail: "Choose a local Git repository folder", available: true, run: () => { void openLocalRepository(); } },
    { id: "clone", label: "Clone repository", detail: "Clone task flow arrives with S1.6", available: false, run: () => undefined },
    { id: "diff", label: "Open Diff view", detail: "Select a changed file after opening a repository", available: false, run: () => undefined },
  ];
  const filteredCommands = commands.filter((command) => `${command.label} ${command.detail}`.toLowerCase().includes(paletteQuery.toLowerCase()));

  return (
    <main className="appShell" style={layoutStyle}>
      <header className="titlebar">
        <button className="brandButton" type="button" onClick={() => setPage("welcome")} aria-label="Go to Welcome">
          <span className="brandMark" aria-hidden="true">G</span>
          <span className="brandName">GitCrest</span>
        </button>
        <nav className="pageTabs" aria-label="Primary navigation">
          <button type="button" className={page === "welcome" ? "pageTab active" : "pageTab"} onClick={() => setPage("welcome")}>Welcome</button>
          <button type="button" className={page === "workspace" ? "pageTab active" : "pageTab"} onClick={() => setPage("workspace")}>Workspace</button>
        </nav>
        <div className="repositoryTabs" role="tablist" aria-label="Open repositories">
          {workspaceSession.openRepoIds.map((repoId) => {
            const repository = repositories.find((item) => item.repoId === repoId);
            if (!repository) return null;
            const active = selectedRepository?.repoId === repoId;
            return (
              <div className={active ? "repositoryTab active" : "repositoryTab"} key={repoId}>
                <button type="button" role="tab" aria-selected={active} title={repository.path} onClick={() => { if (!active) void openRecentRepository(repository); }}>
                  {repositoryName(repository.path)}
                </button>
                <button type="button" className="closeRepositoryTab" aria-label={`Close ${repositoryName(repository.path)} tab`} title="Close tab" onClick={() => closeRepositoryTab(repoId)}>×</button>
              </div>
            );
          })}
        </div>
        <div className="titlebarSpacer" />
        <button className="quietButton searchShortcut" type="button" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K Meta+K">
          <span aria-hidden="true">⌕</span><span>Search commands</span><kbd>{commandKey} K</kbd>
        </button>
        <button className="quietButton themeButton" type="button" onClick={nextTheme} aria-label={`Color theme: ${theme}. Activate to cycle theme`} title={`Theme: ${theme}`}>
          <span aria-hidden="true">◐</span><span>{theme === "system" ? "System" : theme === "dark" ? "Dark" : "Light"}</span>
        </button>
        <div className={`connectionBadge ${connected ? "connected" : ""}`} role="status" aria-live="polite" aria-label={status} title={status}>
          <span className="connectionDot" aria-hidden="true" />
          <span>{connectionLabel}</span>
        </div>
      </header>

      {page === "welcome" ? (
        <section className="welcomePage" aria-labelledby="welcome-title">
          <div className="welcomeIntro">
            <p className="sectionEyebrow">LOCAL GIT WORKSPACE</p>
            <h1 id="welcome-title">Your repositories,<br /><span>in good order.</span></h1>
            <p className="welcomeSummary">Review changes, follow branches, and make deliberate commits from one quiet place.</p>
            <div className="welcomeActions">
              <button className="primaryButton" type="button" disabled={openingRepository} onClick={() => void openLocalRepository()}>
                <span aria-hidden="true">＋</span> {openingRepository ? "Opening repository…" : "Open a repository"}
              </button>
              <button className="secondaryButton" type="button" disabled title="Clone task flow arrives with S1.6">Clone repository</button>
              <button className="textButton" type="button" onClick={() => setPage("workspace")}>Preview workspace</button>
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
                  <button className="inlineAction" type="button" onClick={() => void openLocalRepository()}>Choose a folder <span aria-hidden="true">→</span></button>
                </div>
              ) : (
                <div className="repositoryList">
                  {repositories.map((repository) => (
                    <div key={repository.repoId} className={`repositoryRow ${repository.availability === "missing" ? "repositoryMissing" : ""}`}>
                      <span className="repoStatusGlyph" aria-hidden="true">{repository.availability === "missing" ? "!" : "●"}</span>
                      <button className="repositoryRowOpen" type="button" disabled={openingRepository || repository.availability === "missing"} onClick={() => void openRecentRepository(repository)}>
                        <span className="repositoryRowText"><strong>{repositoryName(repository.path)}{repository.isFavorite ? " · Favorite" : ""}</strong><small>{repository.availability === "missing" ? `Unavailable · ${repository.path}` : repository.path}</small></span>
                        <span className="repositoryBranch">{repository.availability === "missing" ? "Missing" : repository.detached ? "Detached" : repository.branch || "Unborn"}</span>
                      </button>
                      <button className="repositoryRowAction" type="button" aria-label={repository.isFavorite ? `Remove ${repositoryName(repository.path)} from favorites` : `Favorite ${repositoryName(repository.path)}`} onClick={() => void toggleFavorite(repository)}>{repository.isFavorite ? "★" : "☆"}</button>
                      {repository.availability === "missing" && <button className="repositoryRowAction" type="button" onClick={() => void openLocalRepository()}>Locate</button>}
                      <button className="repositoryRowAction" type="button" aria-label={`Remove ${repositoryName(repository.path)} from recent repositories`} onClick={() => void forgetRepository(repository)}>Remove</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <aside className="quickActions" aria-labelledby="quick-heading">
              <div className="sectionHeading"><div><p className="sectionEyebrow">GET STARTED</p><h2 id="quick-heading">Quick actions</h2></div></div>
              <button className="actionRow" type="button" disabled={openingRepository} onClick={() => void openLocalRepository()}>
                <span className="actionIcon" aria-hidden="true">↗</span><span><strong>Open local repository</strong><small>Choose an existing folder</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <button className="actionRow" type="button" disabled title="Clone task flow arrives with S1.6">
                <span className="actionIcon" aria-hidden="true">⇣</span><span><strong>Clone a repository</strong><small>Bring a remote project here</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <button className="actionRow" type="button" disabled={openingRepository} onClick={() => void initializeLocalRepository()}>
                <span className="actionIcon" aria-hidden="true">＋</span><span><strong>Initialize a repository</strong><small>Start tracking a new project</small></span><span className="actionArrow" aria-hidden="true">→</span>
              </button>
              <div className="actionFootnote"><span className="infoIcon" aria-hidden="true">i</span> Initialize creates Git metadata only in the folder you select and keeps its files.</div>
            </aside>
          </div>
          <footer className="welcomeFooter"><span>Private by default</span><span className="footerDivider" /><span>Your repositories stay on this device</span><span className="footerSpacer" /><span>{version || "Local engine"}</span><button type="button" className="textButton" onClick={() => setPage("workspace")}>Explore the workspace <span aria-hidden="true">→</span></button></footer>
        </section>
      ) : (
        <section className="workspacePage" aria-label="Git workspace">
          <div className="workspaceToolbar">
            <div className="workspaceCrumb"><span className="crumbMark" aria-hidden="true">G</span><span>Workspace</span><span className="crumbSlash">/</span><span className="mutedText">{selectedRepository?.path || "No repository open"}</span></div>
            <div className="toolbarActions">
              <button className={mode === "graph" ? "modeButton active" : "modeButton"} type="button" onClick={() => changeWorkspaceMode("graph")}>Graph</button>
              <button className={mode === "diff" ? "modeButton active" : "modeButton"} type="button" disabled title="Select a changed file after opening a repository" onClick={() => changeWorkspaceMode("diff")}>Diff</button>
              <span className="toolbarDivider" />
              <button className="quietButton compact" type="button" disabled title="Branch selection arrives with S4.2"><span className="branchGlyph" aria-hidden="true">⑂</span> {selectedRepository ? selectedRepository.detached ? `Detached · ${selectedRepository.head?.slice(0, 7)}` : selectedRepository.branch || "Unborn branch" : "No branch"}</button>
            </div>
          </div>

          <div className="workArea">
            <aside className="navigationPanel" aria-label="Repository navigation">
              <div className="panelHeading"><span>REPOSITORY</span><button className="panelMenu" type="button" disabled aria-label="Repository options">···</button></div>
              <div className="navGroup"><div className="navGroupTitle"><span>Changes</span><span className="countBadge">0</span></div><div className="navEmpty">{selectedRepository ? "Status snapshot arrives in S1.4" : "No repository open"}</div></div>
              <div className="navDivider" />
              <div className="navGroup"><div className="navGroupTitle">Branches</div><div className="navEmpty">{selectedRepository ? selectedRepository.branch || (selectedRepository.detached ? "Detached HEAD" : "Unborn branch") : "Open a repository to view branches"}</div></div>
              <div className="navDivider" />
              <div className="navGroup"><div className="navGroupTitle">Remotes</div><button className="navEmpty navAction" type="button" disabled title="Open a repository to view remotes">No remotes</button></div>
              <div className="navGroup"><div className="navGroupTitle">Shelves</div><button className="navEmpty navAction" type="button" disabled title="Shelves arrive with S5.3">No shelves</button></div>
              <div className="panelFooter"><span className="statusIcon" aria-hidden="true">●</span> {connected ? "Engine ready" : connecting ? "Connecting to engine" : "Engine unavailable"}</div>
            </aside>
            <ResizeSeparator orientation="vertical" edge="left" value={sidebarWidth} min={190} max={340} label="Resize repository navigation" onResize={setSidebarWidth} />

            <section className="mainPanel" aria-label="Commit graph">
              <div className="panelHeading mainPanelHeading"><div className="viewTitle"><span className="viewGlyph" aria-hidden="true">◌</span><span>{mode === "graph" ? "Commit graph" : "Diff viewer"}</span><span className="subtleTag">LOCAL</span></div><button className="quietButton compact" type="button" disabled title="Open a repository to refresh its history">Refresh <span aria-hidden="true">↻</span></button></div>
              {mode === "graph" ? (
                <div className="graphEmpty">
                  <div className="graphIllustration" aria-hidden="true"><div className="graphLine" /><span className="graphNode nodeOne" /><span className="graphNode nodeTwo" /><span className="graphNode nodeThree" /><span className="graphNode nodeFour" /></div>
                  <p className="sectionEyebrow">A CLEAR VIEW OF YOUR HISTORY</p>
                  <h2>{selectedRepository ? selectedRepository.head ? "Repository ready" : "No commits yet" : "Your commit graph starts here"}</h2>
                  <p>{selectedRepository ? `${selectedRepository.path}${selectedRepository.branch ? ` · ${selectedRepository.branch}` : selectedRepository.detached ? " · detached HEAD" : " · unborn branch"}` : "Open a repository to explore commits, branches, and the changes that connect them."}</p>
                  {!selectedRepository && <button className="secondaryButton" type="button" onClick={() => void openLocalRepository()} disabled={openingRepository}>Open repository <span aria-hidden="true">→</span></button>}
                </div>
              ) : <div className="graphEmpty"><h2>Choose a changed file</h2><p>Diff review becomes available when a repository is open.</p></div>}
              <div className="panelFooter mainPanelFooter"><span>History is read from your local repository</span><span className="footerSpacer" />{version || "Local engine"}</div>
            </section>
            <ResizeSeparator orientation="vertical" edge="right" value={detailsWidth} min={220} max={420} label="Resize commit details" onResize={setDetailsWidth} />

            <aside className="detailsPanel" aria-label="Commit details">
              <div className="panelHeading">{selectedRepository ? "REPOSITORY" : "COMMIT DETAILS"}</div>
              {selectedRepository ? (
                <div className="repositoryDetails">
                  <span className="detailsGlyph" aria-hidden="true">G</span>
                  <h2>{repositoryName(selectedRepository.path)}</h2>
                  <p>{selectedRepository.path}</p>
                  <div className="repositoryFact"><span>BRANCH</span><strong>{selectedRepository.detached ? "Detached HEAD" : selectedRepository.branch || "Unborn"}</strong></div>
                  <div className="repositoryFact"><span>HEAD</span><strong className="monoText">{selectedRepository.head?.slice(0, 12) || "No commits"}</strong></div>
                  <div className="repositoryFact"><span>REPO ID</span><strong className="monoText">{selectedRepository.repoId.slice(0, 17)}…</strong></div>
                </div>
              ) : (
                <><div className="detailsEmpty"><span className="detailsGlyph" aria-hidden="true">⌁</span><h2>No commit selected</h2><p>Select a commit in the graph to inspect its message, author, and changed files.</p></div><div className="detailPlaceholder"><span>AUTHOR</span><strong>—</strong><span>COMMIT</span><strong className="monoText">—</strong></div></>
              )}
            </aside>
          </div>

          <ResizeSeparator orientation="horizontal" edge="bottom" value={workbenchHeight} min={144} max={360} label="Resize changes and commit area" onResize={setWorkbenchHeight} />
          <section className="workbench" aria-label="Changes and commit">
            <div className="workbenchSection"><div className="workbenchTitle">Working tree <span className="countBadge">0</span></div><p>{selectedRepository ? "Status snapshot is coming next" : "No changed files"}</p><small>{selectedRepository ? "Full status and file grouping arrive with S1.4." : "Changes will appear here when a repository is open."}</small></div>
            <div className="workbenchSection stagedSection"><div className="workbenchTitle">Staged changes <span className="countBadge">0</span></div><div className="stagedEmpty">Nothing staged</div><small>Review a file and stage the parts you want to commit.</small></div>
            <div className="workbenchSection commitSection"><div className="workbenchTitle">Commit message</div><textarea aria-label="Commit message" placeholder="Describe the changes you want to commit…" disabled /><div className="commitControls"><label className="disabledCheck"><input type="checkbox" disabled /> Amend</label><button className="primaryButton commitButton" type="button" disabled title="Open a repository and stage changes to commit">Commit <span aria-hidden="true">⌄</span></button></div><small>Commit becomes available when staged changes and a message are ready.</small></div>
          </section>
          <footer className="statusbar"><span className="statusIcon" aria-hidden="true">●</span>{connected ? "Git engine ready" : connecting ? "Connecting to Git engine" : "Git engine unavailable"}<span className="statusbarDivider" /><span>{version || "API v1"}</span><span className="footerSpacer" /><span>Repository actions planned for S1</span></footer>
        </section>
      )}

      {paletteOpen && (
        <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaletteOpen(false); }}>
          <section
            className="commandPalette"
            role="dialog"
            aria-modal="true"
            aria-labelledby="palette-title"
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter") return;
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".commandItem:not(:disabled)"));
              if (items.length === 0) return;
              const current = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "Enter") {
                event.preventDefault();
                (current >= 0 ? items[current] : items[0]).click();
                return;
              }
              event.preventDefault();
              const next = event.key === "ArrowDown"
                ? (current + 1) % items.length
                : (current <= 0 ? items.length - 1 : current - 1);
              items[next].focus();
            }}
          >
            <h2 id="palette-title" className="srOnly">Command palette</h2>
            <div className="paletteSearch"><span aria-hidden="true">⌕</span><input autoFocus aria-label="Search commands" placeholder="Search commands…" value={paletteQuery} onChange={(event) => setPaletteQuery(event.target.value)} /><kbd>ESC</kbd></div>
          <div className="paletteContext">{page === "welcome" ? "WELCOME" : selectedRepository ? `WORKSPACE · ${repositoryName(selectedRepository.path).toUpperCase()}` : "WORKSPACE · NO REPOSITORY"}</div>
            <div className="commandList">
              {filteredCommands.map((command) => (
                <button key={command.id} className="commandItem" type="button" disabled={!command.available} onClick={() => { command.run(); setPaletteOpen(false); }}>
                  <span className="commandItemMain"><strong>{command.label}</strong><small>{command.detail}</small></span>
                  {command.available ? <kbd>{command.id === "workspace" ? `${commandKey} 2` : command.id === "welcome" ? `${commandKey} 1` : "↵"}</kbd> : <span className="unavailableTag">Unavailable</span>}
                </button>
              ))}
              {filteredCommands.length === 0 && <p className="noCommands">No commands match “{paletteQuery}”.</p>}
            </div>
            <div className="paletteFooter"><span>↑ ↓ Navigate</span><span>Enter Run command</span><span>Esc Close</span></div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
