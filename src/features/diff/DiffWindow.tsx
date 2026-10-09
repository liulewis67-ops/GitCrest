import { Fragment, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { GitCrestApiClient, type BlameDocumentResponse, type DiffDocumentResponse, type StatusSnapshotResponse } from "../../api/client";
import { getGitCrestBridge } from "../../api/bridge";
import { ariaShortcut, displayShortcut, matchesShortcut, readShortcutPreferences, SHORTCUT_PREFERENCES_KEY, type ShortcutPreferences } from "../../shared/lib/shortcut-preferences";
import "../../App.css";

type View = "split" | "unified" | "blame";
type DiffTab = {
  key: string;
  path: string;
  scope: "workingTree" | "index" | "commit";
  commitOid?: string;
};
const MAX_DIFF_TABS = 100;
const SplitDiff = lazy(() => import("./SplitDiff").then(({ SplitDiff }) => ({ default: SplitDiff })));

export function DiffWindow() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const repoId = params.get("repoId") || "";
  const initialPath = params.get("path") || "";
  const initialScope = params.get("scope");
  const initialCommitOid = params.get("commitOid") || undefined;
  const [api, setApi] = useState<GitCrestApiClient>();
  const [tabs, setTabs] = useState<DiffTab[]>([]);
  const [activeTabKey, setActiveTabKey] = useState("");
  const [document, setDocument] = useState<DiffDocumentResponse>();
  const [blame, setBlame] = useState<BlameDocumentResponse>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [tabsTruncated, setTabsTruncated] = useState(false);
  const [view, setView] = useState<View>("split");
  const [shortcuts, setShortcuts] = useState<ShortcutPreferences>(() => {
    try {
      return readShortcutPreferences(window.localStorage.getItem(SHORTCUT_PREFERENCES_KEY));
    } catch {
      return readShortcutPreferences(null);
    }
  });
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const activeTabKeyRef = useRef(activeTabKey);
  activeTabKeyRef.current = activeTabKey;
  const activeTab = tabs.find((tab) => tab.key === activeTabKey);
  const blameDisabled = document?.status !== "text" || ["added", "untracked", "deleted", "ignored", "conflicted"].includes(document.changeKind);

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
      setError("This Diff window request is invalid. Reopen the file from GitCrest.");
      return () => { active = false; };
    }
    const bridge = getGitCrestBridge();
    if (!bridge) {
      setError("GitCrest desktop bridge is unavailable. Open this feature in the GitCrest desktop app.");
      return () => { active = false; };
    }
    void bridge.getSidecarConnection().then(async (connection) => {
      if (connection.windowAccess !== "readOnly") throw new Error("Diff windows must use read-only access.");
      const client = new GitCrestApiClient(connection.baseUrl, connection.token).withSignal(controller.signal);
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
        setTabs(uniqueTabs.slice(0, MAX_DIFF_TABS));
        setActiveTabKey(initial.key);
        setApi(client);
      }
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Could not load repository files.");
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [initialCommitOid, initialPath, initialScope, repoId]);

  useEffect(() => {
    if (!api || !activeTab) return;
    let active = true;
    const controller = new AbortController();
    const requestClient = api.withSignal(controller.signal);
    setDocument(undefined);
    setBlame(undefined);
    setError("");
    setView("split");
    setLoading(true);
    const request = activeTab.scope === "commit" && activeTab.commitOid
      ? requestClient.getRepositoryCommitDiff(repoId, activeTab.commitOid, activeTab.path)
      : activeTab.scope === "workingTree" || activeTab.scope === "index"
        ? requestClient.getFileDiff(repoId, activeTab.path, activeTab.scope)
        : Promise.reject(new Error("This historical Diff has no commit ID."));
    void request.then((result) => {
      if (active) setDocument(result);
    }).catch((reason: unknown) => {
      if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load this file diff.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [activeTab?.key, api, repoId]);

  async function openBlame() {
    if (!api || !activeTab) return;
    const requestedTabKey = activeTab.key;
    setView("blame");
    setBlame(undefined);
    setError("");
    setLoading(true);
    try {
      const result = await api.getRepositoryBlame(repoId, activeTab.path, activeTab.scope === "commit" ? activeTab.commitOid : undefined);
      if (activeTabKeyRef.current === requestedTabKey) setBlame(result);
    } catch (reason) {
      if (activeTabKeyRef.current === requestedTabKey) setError(reason instanceof Error ? reason.message : "Could not load file blame.");
    } finally {
      if (activeTabKeyRef.current === requestedTabKey) setLoading(false);
    }
  }

  function closeTab(tab: DiffTab) {
    if (tabs.length <= 1) return;
    const index = tabs.findIndex((item) => item.key === tab.key);
    const next = tabs.filter((item) => item.key !== tab.key);
    setTabs(next);
    if (activeTabKey === tab.key) setActiveTabKey(next[Math.max(0, index - 1)]?.key || next[0]?.key || "");
  }

  return (
    <main className="diffWindow" aria-label="Read-only Diff window">
      <header className="diffWindowHeader">
        <div><span className="sectionEyebrow">READ ONLY DIFF</span><strong title={activeTab?.path || initialPath}>{activeTab?.path || initialPath || "File diff"}</strong></div>
        <div className="diffWindowViewToggle" role="group" aria-label="Diff layout">
          <button type="button" aria-pressed={view === "split"} aria-keyshortcuts={ariaShortcut(shortcuts.toggleDiffView, isMac)} title={`Toggle Split/Unified (${displayShortcut(shortcuts.toggleDiffView, isMac)})`} onClick={() => setView("split")}>Split</button>
          <button type="button" aria-pressed={view === "unified"} aria-keyshortcuts={ariaShortcut(shortcuts.toggleDiffView, isMac)} title={`Toggle Split/Unified (${displayShortcut(shortcuts.toggleDiffView, isMac)})`} onClick={() => setView("unified")}>Unified</button>
          <button type="button" aria-pressed={view === "blame"} disabled={blameDisabled} title={blameDisabled ? "Blame requires a text file with committed history." : "Show Git line blame"} onClick={() => void openBlame()}>Blame</button>
        </div>
      </header>
      <nav className="diffWindowTabs" aria-label="Open diff files">
        {tabs.map((tab) => <div className={`diffWindowTab${tab.key === activeTabKey ? " active" : ""}`} key={tab.key}>
          <button type="button" className="diffWindowTabSelect" aria-current={tab.key === activeTabKey ? "page" : undefined} onClick={() => setActiveTabKey(tab.key)}>
            <span>{tab.scope === "commit" ? "COMMIT" : tab.scope === "index" ? "STAGED" : "WORKTREE"}</span>{tab.path}
          </button>
          {tabs.length > 1 && <button type="button" className="diffWindowTabClose" aria-label={`Close ${tab.path} tab`} onClick={() => closeTab(tab)}>×</button>}
        </div>)}
        {tabsTruncated && <span className="diffWindowTabLimit" role="status">Showing the first {MAX_DIFF_TABS} changed files.</span>}
      </nav>
      <section className="diffWindowContent" aria-label="File diff content">
        {error ? <div className="diffSpecialState" role="alert"><p>{error}</p></div>
          : loading && !document ? <div className="diffSpecialState" role="status">Loading file diff…</div>
            : view === "blame" ? loading ? <div className="diffSpecialState" role="status">Loading line blame…</div> : blame ? <BlameView document={blame} /> : <div className="diffSpecialState" role="status">No blame data is available.</div>
              : !document ? <div className="diffSpecialState" role="status">Loading file diff…</div>
                : view === "split"
                  ? <Suspense fallback={<div className="diffSpecialState" role="status" aria-live="polite">Loading diff viewer…</div>}><SplitDiff document={document} onStageSelection={() => undefined} disabled readOnly /></Suspense>
                  : <UnifiedDiff document={document} />}
      </section>
    </main>
  );
}

function tabKey(path: string, scope: DiffTab["scope"], commitOid?: string) {
  return `${scope}:${commitOid || ""}:${path}`;
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

function BlameView({ document }: { document: BlameDocumentResponse }) {
  return <div className="blameView" aria-label={`Line blame for ${document.path}`}>
    <div className="splitDiffFileMeta"><span className="diffScopeBadge">BLAME {document.revision ? document.revision.slice(0, 12) : "HEAD"}</span><strong>{document.path}</strong></div>
    {document.lines.map((line) => <div className="blameLine" key={line.lineNumber}>
      <span className="blameLineNumber">{line.lineNumber}</span>
      <span className="blameCommit" title={line.commitOid}>{line.commitOid.slice(0, 8)}</span>
      <span className="blameAuthor" title={line.authorEmail}>{line.authorName}</span>
      <span className="blameSummary" title={line.summary}>{line.summary}</span>
      <code>{line.text}</code>
    </div>)}
  </div>;
}

function UnifiedDiff({ document }: { document: DiffDocumentResponse }) {
  if (document.status !== "text") {
    return <div className="diffSpecialState" role="status"><span className={`diffStateBadge diffState-${document.status}`}>{document.status}</span><p>{document.status === "binary" ? "This file is binary; Git does not provide a line based diff." : "No text diff is available for this file."}</p></div>;
  }
  return <div className="unifiedDiff" aria-label={`Unified diff for ${document.path}`}>
    <div className="splitDiffFileMeta"><span className="diffScopeBadge">{document.scope === "commit" ? "COMMIT ↔ FIRST PARENT" : document.scope === "index" ? "INDEX ↔ HEAD" : "WORKING TREE ↔ INDEX"}</span><strong>{document.path}</strong></div>
    {document.hunks.map((hunk, hunkIndex) => <section className="unifiedDiffHunk" aria-label={`Change hunk ${hunkIndex + 1}`} key={`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`}>
      <header>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</header>
      {hunk.rows.map((row, rowIndex) => row.kind === "context"
        ? <div className="unifiedDiffRow" role="group" aria-label={`Context line ${row.oldLine ?? row.newLine ?? "unknown"}: ${row.oldText ?? row.newText ?? ""}`} key={rowIndex}><span>{row.oldLine ?? ""}</span><span>{row.newLine ?? ""}</span><code> {row.oldText ?? row.newText ?? ""}</code></div>
        : <Fragment key={rowIndex}>
          {row.oldText !== null && row.oldText !== undefined && <div className="unifiedDiffRow unifiedDiffDeletion" role="group" aria-label={`Deleted line ${row.oldLine ?? "unknown"}: ${row.oldText}`}><span>{row.oldLine ?? ""}</span><span /> <code>-{row.oldText}</code></div>}
          {row.newText !== null && row.newText !== undefined && <div className="unifiedDiffRow unifiedDiffAddition" role="group" aria-label={`Added line ${row.newLine ?? "unknown"}: ${row.newText}`}><span /> <span>{row.newLine ?? ""}</span><code>+{row.newText}</code></div>}
        </Fragment>)}
    </section>)}
  </div>;
}
