import { useI18n } from "../../../shared/i18n";
import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { GitCrestApiClient, type BlameDocumentResponse, type DiffDocumentResponse, type StatusSnapshotResponse } from "../../../api/client";
import { getGitCrestBridge } from "../../../api/bridge";
import { useCoreRestartCount } from "../../../shared/hooks/use-core-restart-count";
import { BrandMark } from "../../../shared/ui/BrandMark";
import { WindowControls } from "../../../shared/ui/WindowControls";
import { ariaShortcut, displayShortcut, matchesShortcut, readShortcutPreferences, SHORTCUT_PREFERENCES_KEY, type ShortcutPreferences } from "../../settings";
import { BlameAnnotation, createBlameLookup, type BlameLookup } from "./BlameAnnotation";

type View = "split" | "unified";
/** One tab's blame: loading while neither is set. */
type TabBlame = { document?: BlameDocumentResponse; error?: string };
type DiffTab = {
  key: string;
  path: string;
  scope: "workingTree" | "index" | "commit";
  commitOid?: string;
};
const MAX_DIFF_TABS = 100;
const SplitDiff = lazy(() => import("./SplitDiff").then(({ SplitDiff }) => ({ default: SplitDiff })));

export function DiffWindow() {
  const { t } = useI18n();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const repoId = params.get("repoId") || "";
  const initialPath = params.get("path") || "";
  const initialScope = params.get("scope");
  const initialCommitOid = params.get("commitOid") || undefined;
  const [api, setApi] = useState<GitCrestApiClient>();
  const [tabs, setTabs] = useState<DiffTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState("");
  const [document, setDocument] = useState<DiffDocumentResponse>();
  // Blame annotates either layout; once on it stays on across tabs, and each tab's blame loads once.
  const [blameOn, setBlameOn] = useState(false);
  const [blames, setBlames] = useState<Record<string, TabBlame>>({});
  const requestedBlames = useRef(new Set<string>());
  const [error, setError] = useState("");
  const [tabsTruncated, setTabsTruncated] = useState(false);
  const [view, setView] = useState<View>("split");
  const coreRestarts = useCoreRestartCount();
  const tabsLoadedRef = useRef(false);
  const [shortcuts, setShortcuts] = useState<ShortcutPreferences>(() => {
    try {
      return readShortcutPreferences(window.localStorage.getItem(SHORTCUT_PREFERENCES_KEY));
    } catch {
      return readShortcutPreferences(null);
    }
  });
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const activeTab = tabs.find((tab) => tab.key === activeTabKey);
  const blameDisabled = document?.status !== "text" || ["added", "untracked", "deleted", "ignored", "conflicted"].includes(document.changeKind);
  const activeBlame = blameOn && activeTab && !blameDisabled ? blames[activeTab.key] : undefined;
  const blameLookup = useMemo(() => activeBlame?.document ? createBlameLookup(activeBlame.document) : undefined, [activeBlame?.document]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === SHORTCUT_PREFERENCES_KEY) setShortcuts(readShortcutPreferences(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [role=dialog]"))) return;
      if (!matchesShortcut(event, shortcuts.toggleDiffView, isMac)) return;
      event.preventDefault();
      setView((current) => current === "unified" ? "split" : "unified");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMac, shortcuts.toggleDiffView]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!repoId || !initialPath || !["workingTree", "index", "commit"].includes(initialScope || "") || (initialScope === "commit" && !initialCommitOid)) {
      setError(t("dw.invalid"));
      return () => { active = false; };
    }
    const bridge = getGitCrestBridge();
    if (!bridge) {
      setError(t("dw.noBridge"));
      return () => { active = false; };
    }
    void bridge.getSidecarConnection().then(async (connection) => {
      if (connection.windowAccess !== "readOnly") throw new Error(t("dw.readOnlyOnly"));
      const client = new GitCrestApiClient(connection.baseUrl, connection.token).withSignal(controller.signal);
      // A restarted core keeps the open tabs; only the client moves to the new core.
      if (tabsLoadedRef.current) {
        if (active) {
          setError("");
          setApi(client);
        }
        return;
      }
      const initial: DiffTab = {
        key: tabKey(initialPath, initialScope as DiffTab["scope"], initialCommitOid),
        path: initialPath,
        scope: initialScope as DiffTab["scope"],
        ...(initialCommitOid ? { commitOid: initialCommitOid } : {}),
      };
      const siblingTabs = initial.scope === "commit"
        ? (await client.getRepositoryCommit(repoId, initial.commitOid!)).files.map((file) => ({
          key: tabKey(file.path, "commit", initial.commitOid), path: file.path, scope: "commit" as const, commitOid: initial.commitOid,
        }))
        : tabsFromStatus(await client.getRepositoryStatus(repoId));
      const uniqueTabs = [initial, ...siblingTabs.filter((tab) => tab.key !== initial.key)];
      if (active) {
        setTabsTruncated(uniqueTabs.length > MAX_DIFF_TABS);
        // Diffs the main window sent while these tabs loaded are already open, and the latest of them stays active.
        setTabs((requested) => addTabs(uniqueTabs.slice(0, MAX_DIFF_TABS), requested));
        setActiveTabKey((current) => current || initial.key);
        setApi(client);
        tabsLoadedRef.current = true;
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : t("dw.loadFilesFailed"));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [initialCommitOid, initialPath, initialScope, repoId, coreRestarts]);

  // The main window reuses this window for its repository: each further Diff opens as a tab, and the last one shows.
  useEffect(() => getGitCrestBridge()?.subscribeToDiffWindowRequests?.((requests) => {
    const requested = requests.filter((request) => request.repoId === repoId).map((request): DiffTab => ({
      key: tabKey(request.path, request.scope, request.commitOid),
      path: request.path,
      scope: request.scope,
      ...(request.commitOid ? { commitOid: request.commitOid } : {}),
    }));
    if (requested.length === 0) return;
    setTabs((current) => addTabs(current, requested));
    setActiveTabKey(requested[requested.length - 1].key);
  }), [repoId]);

  useEffect(() => {
    if (!api || !activeTab) return;
    let active = true;
    const controller = new AbortController();
    const requestClient = api.withSignal(controller.signal);
    setDocument(undefined);
    setError("");
    const request = activeTab.scope === "commit" && activeTab.commitOid
      ? requestClient.getRepositoryCommitDiff(repoId, activeTab.commitOid, activeTab.path)
      : activeTab.scope === "workingTree" || activeTab.scope === "index"
        ? requestClient.getFileDiff(repoId, activeTab.path, activeTab.scope)
        : Promise.reject(new Error(t("dw.noCommitId")));
    void request.then((result) => {
      if (active) setDocument(result);
    }).catch((reason: unknown) => {
      if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : t("dw.loadDiffFailed"));
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeTab?.key, api, repoId]);

  // A restarted core gets a new client; blames that failed against the old one are asked for again.
  useEffect(() => {
    requestedBlames.current.clear();
    setBlames((current) => Object.fromEntries(Object.entries(current).filter(([, entry]) => entry.document)));
  }, [api]);

  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    if (!blameOn || !api || !activeTab || blameDisabled) return;
    const tab = activeTab;
    if (requestedBlames.current.has(tab.key)) return;
    requestedBlames.current.add(tab.key);
    setBlames((current) => ({ ...current, [tab.key]: {} }));
    // Switching tabs keeps the request: its result is stored under its own tab for when that tab comes back.
    void api.getRepositoryBlame(repoId, tab.path, tab.scope === "commit" ? tab.commitOid : undefined).then((document) => {
      setBlames((current) => ({ ...current, [tab.key]: { document } }));
    }).catch((reason: unknown) => {
      // A failure from a client the window has since replaced is not this tab's answer.
      if (apiRef.current !== api) return;
      requestedBlames.current.delete(tab.key);
      setBlames((current) => ({ ...current, [tab.key]: { error: reason instanceof Error ? reason.message : t("dw.loadBlameFailed") } }));
    });
  }, [blameOn, api, activeTab?.key, blameDisabled, repoId]);

  function closeTab(tab: DiffTab) {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((item) => item.key === tab.key);
    const next = tabs.filter((item) => item.key !== tab.key);
    setTabs(next);
    if (activeTabKey === tab.key) setActiveTabKey(next[Math.max(0, index - 1)]?.key || next[0]?.key || "");
  }

  const headerPath = activeTab?.path || initialPath;
  const headerScope = activeTab?.scope || (initialScope as DiffTab["scope"] | null);
  const toggleTitle = t("dw.toggleTitle", { shortcut: displayShortcut(shortcuts.toggleDiffView, isMac) });

  return (
    <main className="diffWindow" aria-label={t("dw.aria")}>
      {/* The header is the window's title bar: which file and side, how to read it, and the window controls. */}
      <header className="diffWindowHeader">
        <div className="diffWindowTitle">
          <BrandMark className="diffWindowBrand" />
          {headerPath
            ? <h1 title={headerPath}><span className="diffWindowFileName">{fileName(headerPath)}</span>{directoryName(headerPath) && <span className="diffWindowDirectory">{directoryName(headerPath)}</span>}</h1>
            : <h1><span className="diffWindowFileName">{t("dw.fileDiff")}</span></h1>}
          {headerScope && <span className={`diffWindowScope scope-${headerScope}`}>{scopeLabel(headerScope, t)}</span>}
          <span className="diffWindowReadOnly">{t("dw.readOnly")}</span>
        </div>
        <div className="viewSwitcher diffWindowViewToggle" role="group" aria-label={t("dw.layout")}>
          <button type="button" className={view === "split" ? "viewTab active" : "viewTab"} aria-pressed={view === "split"} aria-keyshortcuts={ariaShortcut(shortcuts.toggleDiffView, isMac)} title={toggleTitle} onClick={() => setView("split")}>
            <svg className="viewTabIcon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M8 2.5v11" /></svg>{t("dw.split")}
          </button>
          <button type="button" className={view === "unified" ? "viewTab active" : "viewTab"} aria-pressed={view === "unified"} aria-keyshortcuts={ariaShortcut(shortcuts.toggleDiffView, isMac)} title={toggleTitle} onClick={() => setView("unified")}>
            <svg className="viewTabIcon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 8h12" /></svg>{t("dw.unified")}
          </button>
        </div>
        {/* Blame is an annotation over either layout, so it toggles on its own rather than being a third layout. */}
        <div className="viewSwitcher diffWindowBlameToggle">
          <button type="button" className={blameOn ? "viewTab active" : "viewTab"} aria-pressed={blameOn} disabled={blameDisabled} title={blameDisabled ? t("dw.blameDisabled") : t("dw.blameShow")} onClick={() => setBlameOn((on) => !on)}>
            <svg className="viewTabIcon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="5" cy="5" r="2" /><path d="M2 13c0-1.9 1.3-3.2 3-3.2s3 1.3 3 3.2M10 5h4M10 8h4M10 11h4" /></svg>{t("dw.blame")}
          </button>
        </div>
        <WindowControls controls={getGitCrestBridge()?.windowControls} />
      </header>
      {/* Sibling files only earn a tab strip when there is more than one to move between. */}
      {tabs.length > 1 && <nav className="diffWindowTabs" aria-label={t("dw.tabsAria")}>
        {tabs.map((tab) => <div className={`diffWindowTab${tab.key === activeTabKey ? " active" : ""}`} key={tab.key}>
          <button type="button" className="diffWindowTabSelect" aria-current={tab.key === activeTabKey ? "page" : undefined} title={`${scopeLabel(tab.scope, t)} · ${tab.path}`} onClick={() => setActiveTabKey(tab.key)}>
            <span className={`diffWindowScopeDot scope-${tab.scope}`} aria-hidden="true" />
            <span className="diffWindowTabName">{fileName(tab.path)}</span>
            <span className="srOnly">{scopeLabel(tab.scope, t)} · {tab.path}</span>
          </button>
          <button type="button" className="diffWindowTabClose" aria-label={t("dw.closeTab", { path: tab.path })} title={t("titlebar.closeTab")} onClick={() => closeTab(tab)}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7" /></svg></button>
        </div>)}
        {tabsTruncated && <span className="diffWindowTabLimit" role="status">{t("dw.tabLimit", { count: MAX_DIFF_TABS })}</span>}
      </nav>}
      <section className="diffWindowContent" aria-label={t("dw.contentAria")}>
        {/* The diff shows at once; its blame fills in when it arrives. */}
        {document && activeBlame && !activeBlame.document && <div className="diffBlameNotice" role={activeBlame.error ? "alert" : "status"}>{activeBlame.error || t("dw.loadingBlame")}</div>}
        {error ? <div className="diffSpecialState" role="alert"><p>{error}</p></div>
          : !document ? <div className="diffSpecialState" role="status">{t("dw.loadingDiff")}</div>
            : view === "split"
              ? <Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">{t("dw.loadingViewer")}</div>}><SplitDiff document={document} onStageSelection={() => undefined} disabled readOnly showFileMeta={false} blame={blameLookup} /></Suspense>
              : <UnifiedDiff document={document} blame={blameLookup} />}
      </section>
    </main>
  );
}

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function directoryName(path: string) {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : "";
}

function scopeLabel(scope: DiffTab["scope"], t: ReturnType<typeof useI18n>["t"]) {
  return scope === "commit" ? t("dw.tabCommit") : scope === "index" ? t("dw.tabStaged") : t("dw.tabWorktree");
}

function tabKey(path: string, scope: DiffTab["scope"], commitOid?: string) {
  return `${scope}:${commitOid || ""}:${path}`;
}

/** Appends the tabs that are not open yet. Past the tab limit the oldest other tabs make room for the added ones. */
function addTabs(current: DiffTab[], added: DiffTab[]): DiffTab[] {
  const openKeys = new Set(current.map((tab) => tab.key));
  const tabs = [...current];
  for (const tab of added) {
    if (openKeys.has(tab.key)) continue;
    openKeys.add(tab.key);
    tabs.push(tab);
  }
  const addedKeys = new Set(added.map((tab) => tab.key));
  let excess = tabs.length - MAX_DIFF_TABS;
  return excess <= 0 ? tabs : tabs.filter((tab) => {
    if (excess <= 0 || addedKeys.has(tab.key)) return true;
    excess -= 1;
    return false;
  });
}

function tabsFromStatus(snapshot: StatusSnapshotResponse): DiffTab[] {
  return snapshot.files.flatMap((file) => {
    if (file.categories.includes("conflicted") || file.categories.includes("ignored")) return [];
    const scopes: Array<DiffTab["scope"]> = [];
    if (file.categories.includes("staged")) scopes.push("index");
    if (file.categories.includes("unstaged") || file.categories.includes("untracked")) scopes.push("workingTree");
    return scopes.map((scope) => ({ key: tabKey(file.path, scope), path: file.path, scope }));
  });
}

/** With blame, every row leads with the annotation of its new-side line; deleted lines have none. */
export function UnifiedDiff({ document, blame }: { document: DiffDocumentResponse; blame?: BlameLookup }) {
  const { t } = useI18n();
  if (document.status !== "text") {
    return <div className="diffSpecialState" role="status"><span className={`diffStateBadge diffState-${document.status}`}>{document.status}</span><p>{document.status === "binary" ? t("dw.binaryNote") : t("dw.noTextDiff")}</p></div>;
  }
  return <div className={blame ? "unifiedDiff withBlame" : "unifiedDiff"} aria-label={t("dw.unifiedAria", { path: document.path })}>
    {document.hunks.map((hunk, hunkIndex) => <section className="unifiedDiffHunk" aria-label={t("sd.hunkAria", { n: hunkIndex + 1 })} key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
      <header>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</header>
      {hunk.rows.map((row, rowIndex) => row.kind === "context"
        ? <div className="unifiedDiffRow" role="group" aria-label={t("sd.contextLine", { line: row.oldLine ?? row.newLine ?? t("sd.unknown"), text: row.oldText ?? row.newText ?? "" })} key={rowIndex}>{blame && <BlameAnnotation line={blame(row.newLine, row.newText ?? row.oldText)} />}<span>{row.oldLine ?? ""}</span><span>{row.newLine ?? ""}</span><code> {row.oldText ?? row.newText ?? ""}</code></div>
        : <Fragment key={rowIndex}>
          {row.oldText !== null && row.oldText !== undefined && <div className="unifiedDiffRow unifiedDiffDeletion" role="group" aria-label={t("sd.deletedLine", { line: row.oldLine ?? t("sd.unknown"), text: row.oldText })}>{blame && <BlameAnnotation />}<span>{row.oldLine ?? ""}</span><span /><code>-{row.oldText}</code></div>}
          {row.newText !== null && row.newText !== undefined && <div className="unifiedDiffRow unifiedDiffAddition" role="group" aria-label={t("sd.addedLine", { line: row.newLine ?? t("sd.unknown"), text: row.newText })}>{blame && <BlameAnnotation line={blame(row.newLine, row.newText)} />}<span /><span>{row.newLine ?? ""}</span><code>+{row.newText}</code></div>}
        </Fragment>)}
    </section>)}
  </div>;
}
