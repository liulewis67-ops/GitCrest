import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { GitCrestApiClient, type WorkflowConflictFileResponse, type WorkflowRecoveryPreflightResponse } from "../../../api/client";
import { getGitCrestBridge } from "../../../api/bridge";
import { baseForBlock, choiceText, findConflictBlocks, replaceConflictBlock, type ConflictBlock } from "../model/conflict-blocks";
import { splitLines } from "../model/line-diff";
import { countConflicts, merge3, renderMerge3, type NonConflictingMode } from "../model/merge3";
import { useDraftHistory } from "../model/use-draft-history";
import { ConflictBlockRow, type IgnoredSides } from "./ConflictBlockRow";
import { ConflictSuggestionPanel } from "./ConflictSuggestionPanel";

type RequestState<T> = { key: string; loading: boolean; data?: T; error?: string };
type ActionState = { busy?: "save" | "resolve"; message?: string; error?: string };

const TASK_POLL_INTERVAL_MS = 250;
const TASK_POLL_ATTEMPTS = 60;

export function ConflictWindow() {
  const params = new URLSearchParams(window.location.search);
  const repoId = params.get("repoId") || "";
  const taskId = params.get("taskId") || "";
  const [api, setApi] = useState<GitCrestApiClient>();
  const [session, setSession] = useState<RequestState<WorkflowRecoveryPreflightResponse>>({ key: "", loading: false });
  const [selectedPath, setSelectedPath] = useState("");
  const [file, setFile] = useState<RequestState<WorkflowConflictFileResponse>>({ key: "", loading: false });
  const [draft, setDraft] = useState("");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [action, setAction] = useState<ActionState>({});
  const [suggestionOpen, setSuggestionOpen] = useState(false);
  const [totalBlocks, setTotalBlocks] = useState(0);
  const [activeBlock, setActiveBlock] = useState(0);
  const [ignored, setIgnored] = useState<Record<string, IgnoredSides>>({});
  const [pendingApply, setPendingApply] = useState<NonConflictingMode | null>(null);
  const blockRefs = useRef<(HTMLElement | null)[]>([]);
  const typingRecorded = useRef(false);
  const history = useDraftHistory();
  const { reset: resetHistory } = history;
  const selectedPathRef = useRef(selectedPath);
  const actionControllerRef = useRef<AbortController | null>(null);
  selectedPathRef.current = selectedPath;
  const sessionKey = `${repoId}:${taskId}`;
  const fileKey = `${sessionKey}:${selectedPath}`;

  useEffect(() => () => actionControllerRef.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    if (!repoId || !/^repo_[a-f0-9]{64}$/.test(repoId) || !taskId) {
      setSession({ key: sessionKey, loading: false, error: "This conflict window request is invalid. Reopen it from Task Center." });
      return () => controller.abort();
    }
    setApi(undefined);
    setSession({ key: sessionKey, loading: true });
    const bridge = getGitCrestBridge();
    if (!bridge) {
      setSession({
        key: sessionKey,
        loading: false,
        error: "GitCrest desktop bridge is unavailable. Open this feature in the GitCrest desktop app.",
      });
      return () => controller.abort();
    }
    void bridge.getSidecarConnection().then(async (connection) => {
      if (controller.signal.aborted) return;
      if (connection.windowAccess !== "conflictResolution") throw new Error("Conflict review requires its restricted write capability.");
      const client = new GitCrestApiClient(connection.baseUrl, connection.token);
      const preview = await client.withSignal(controller.signal).preflightRepositoryWorkflowRecovery(repoId, taskId);
      if (controller.signal.aborted) return;
      setApi(client);
      setSession({ key: sessionKey, loading: false, data: preview });
      setSelectedPath((current) => preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || "");
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setSession({ key: sessionKey, loading: false, error: reason instanceof Error ? reason.message : "Could not load the conflict task." });
    });
    return () => controller.abort();
  }, [repoId, taskId, sessionKey]);

  useEffect(() => {
    const controller = new AbortController();
    if (!api || !selectedPath) {
      setFile({ key: fileKey, loading: false });
      return () => controller.abort();
    }
    setFile({ key: fileKey, loading: true });
    setAction({});
    setSuggestionOpen(false);
    setHasUnsavedChanges(false);
    setIgnored({});
    setPendingApply(null);
    resetHistory();
    typingRecorded.current = false;
    void api.withSignal(controller.signal).getRepositoryWorkflowConflictFile(repoId, taskId, selectedPath).then((response) => {
      if (!controller.signal.aborted && selectedPathRef.current === selectedPath) {
        setFile({ key: fileKey, loading: false, data: response });
        setDraft(response.resultContent ?? "");
        setTotalBlocks(response.isText ? findConflictBlocks(response.resultContent ?? "").length : 0);
        setActiveBlock(0);
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && selectedPathRef.current === selectedPath) setFile({ key: fileKey, loading: false, error: reason instanceof Error ? reason.message : "Could not load the conflict stages." });
    });
    return () => controller.abort();
  }, [api, repoId, taskId, selectedPath, fileKey, resetHistory]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeClose);
    return () => window.removeEventListener("beforeunload", warnBeforeClose);
  }, [hasUnsavedChanges]);

  const refreshSession = async (signal: AbortSignal) => {
    if (!api || signal.aborted) return undefined;
    const preview = await api.withSignal(signal).preflightRepositoryWorkflowRecovery(repoId, taskId);
    if (signal.aborted) return undefined;
    setSession({ key: sessionKey, loading: false, data: preview });
    setSelectedPath((current) => preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || "");
    return preview;
  };

  const saveDraft = async (): Promise<WorkflowConflictFileResponse | undefined> => {
    const currentFile = file.data;
    if (!api || !currentFile || !currentFile.isText || action.busy) return undefined;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setAction({ busy: "save", message: "Saving this file to the working tree…" });
    try {
      await api.saveRepositoryWorkflowConflictFile(repoId, {
        taskId,
        path: currentFile.path,
        expectedOperation: currentFile.operation,
        expectedHeadOid: currentFile.headOid || "",
        expectedResultRevision: currentFile.resultRevision,
        content: draft,
      });
      for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt += 1) {
        await delay(TASK_POLL_INTERVAL_MS, controller.signal);
        if (controller.signal.aborted) return;
        const refreshed = await api.withSignal(controller.signal).getRepositoryWorkflowConflictFile(repoId, taskId, currentFile.path);
        if (controller.signal.aborted) return;
        if (refreshed.resultContent === draft) {
          if (selectedPathRef.current === currentFile.path) {
            setFile({ key: `${sessionKey}:${currentFile.path}`, loading: false, data: refreshed });
            setHasUnsavedChanges(false);
            setAction({ message: "Saved to the working tree. You can close and reopen this window to continue later." });
          }
          return refreshed;
        }
      }
      throw new Error("The save task has not completed yet. Refresh this file before resolving it.");
    } catch (reason) {
      if (controller.signal.aborted) return undefined;
      setAction({ error: reason instanceof Error ? reason.message : "Could not save the conflict result." });
      try { await refreshSession(controller.signal); } catch { /* Keep the reviewed content visible when refresh is unavailable. */ }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  };

  const markResolved = async (fileOverride?: WorkflowConflictFileResponse) => {
    const currentFile = fileOverride ?? file.data;
    if (!api || !currentFile || !currentFile.isText || (hasUnsavedChanges && !fileOverride) || action.busy) return;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setAction({ busy: "resolve", message: "Staging this file as resolved…" });
    try {
      await api.markRepositoryWorkflowConflictResolved(repoId, {
        taskId,
        path: currentFile.path,
        expectedOperation: currentFile.operation,
        expectedHeadOid: currentFile.headOid || "",
        expectedResultRevision: currentFile.resultRevision,
      });
      for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt += 1) {
        await delay(TASK_POLL_INTERVAL_MS, controller.signal);
        if (controller.signal.aborted) return;
        const preview = await api.withSignal(controller.signal).preflightRepositoryWorkflowRecovery(repoId, taskId);
        if (controller.signal.aborted) return;
        if (!preview.conflictedPaths.includes(currentFile.path)) {
          setSession({ key: sessionKey, loading: false, data: preview });
          setSelectedPath((current) => current === currentFile.path ? preview.conflictedPaths[0] || "" : current);
          setAction({ message: "Resolved and staged this file. Return to Task Center to continue the Git operation." });
          return;
        }
      }
      throw new Error("The resolve task has not completed yet. Refresh the conflict list before continuing.");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setAction({ error: reason instanceof Error ? reason.message : "Could not mark this conflict resolved." });
      try { await refreshSession(controller.signal); } catch { /* Keep the reviewed content visible when refresh is unavailable. */ }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  };

  const currentSession = session.key === sessionKey ? session : { key: sessionKey, loading: true };
  const currentFile = file.key === fileKey ? file : { key: fileKey, loading: Boolean(selectedPath) };
  const conflictBlocks = currentFile.data?.isText ? findConflictBlocks(draft) : [];
  const stages = currentFile.data?.isText ? currentFile.data : undefined;
  const regions = useMemo(
    () => stages ? merge3(splitLines(stages.baseContent), splitLines(stages.oursContent), splitLines(stages.theirsContent)) : null,
    [stages],
  );
  const canRebuild = Boolean(regions && stages && stages.oursContent !== null && stages.theirsContent !== null);
  const availableModes: Record<NonConflictingMode, boolean> = {
    all: Boolean(regions?.some((region) => region.kind === "ours" || region.kind === "theirs")),
    ours: Boolean(regions?.some((region) => region.kind === "ours")),
    theirs: Boolean(regions?.some((region) => region.kind === "theirs")),
  };
  const totalConflicts = Math.max(totalBlocks, conflictBlocks.length);
  const resolvedBlocks = totalConflicts - conflictBlocks.length;
  const savedResult = currentFile.data?.resultContent ?? "";
  const busy = Boolean(action.busy);

  const focusBlock = (position: number) => {
    if (conflictBlocks.length === 0) return;
    const next = (position + conflictBlocks.length) % conflictBlocks.length;
    setActiveBlock(next);
    blockRefs.current[next]?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  };
  /** Programmatic draft change: recorded for undo and ends the current typing session. */
  const changeDraft = (content: string) => {
    if (content === draft) return;
    history.record(draft);
    typingRecorded.current = false;
    updateDraft(content, savedResult, setDraft, setHasUnsavedChanges);
  };
  const resolveBlock = (block: ConflictBlock, replacement: string) => {
    changeDraft(replaceConflictBlock(draft, block, replacement));
    setIgnored(({ [block.id]: _resolved, ...rest }) => rest);
  };
  const ignoreSide = (block: ConflictBlock, side: "ours" | "theirs") => {
    const state = ignored[block.id] ?? {};
    const other = side === "ours" ? "theirs" : "ours";
    if (!state[side] && state[other]) {
      resolveBlock(block, baseForBlock(block, regions) ?? "");
      return;
    }
    setIgnored((current) => ({ ...current, [block.id]: { ...state, [side]: !state[side] } }));
  };
  const useEntire = (content: string | null) => {
    changeDraft(content ?? "");
    setIgnored({});
  };
  const applyNonConflicting = (mode: NonConflictingMode) => {
    setPendingApply(null);
    if (!regions) return;
    const lineEnding = stages?.oursContent?.includes("\r\n") ? "\r\n" : "\n";
    const next = renderMerge3(regions, mode, lineEnding);
    const remaining = countConflicts(regions);
    changeDraft(next);
    setIgnored({});
    setTotalBlocks(remaining);
    setActiveBlock(0);
    setAction({ message: `Applied non-conflicting changes (${mode === "all" ? "both sides" : mode}). ${remaining === 0 ? "No conflicts remain." : `${remaining} ${remaining === 1 ? "conflict" : "conflicts"} left to resolve.`} Undo is available.` });
  };
  const requestApply = (mode: NonConflictingMode) => {
    if (hasUnsavedChanges) setPendingApply(mode);
    else applyNonConflicting(mode);
  };
  const undo = () => {
    const previous = history.undo(draft);
    if (previous === undefined) return;
    typingRecorded.current = false;
    updateDraft(previous, savedResult, setDraft, setHasUnsavedChanges);
  };
  const redo = () => {
    const next = history.redo(draft);
    if (next === undefined) return;
    typingRecorded.current = false;
    updateDraft(next, savedResult, setDraft, setHasUnsavedChanges);
  };
  return <main className="conflictWindow" aria-label="Conflict resolution window" onKeyDown={(event) => {
    // event.code keeps Alt+digit working on layouts where Alt changes the produced character.
    const digit = /^(?:Digit|Numpad)([123])$/.exec(event.code)?.[1] ?? event.key;
    const quickChoice = ({ "1": "ours", "2": "theirs", "3": "both" } as Record<string, "ours" | "theirs" | "both">)[digit];
    if (event.altKey && !event.ctrlKey && !event.metaKey && quickChoice && !busy) {
      const block = conflictBlocks[Math.min(activeBlock, conflictBlocks.length - 1)];
      const skipped = ignored[block?.id ?? ""] ?? {};
      if (block && !(quickChoice !== "theirs" && skipped.ours) && !(quickChoice !== "ours" && skipped.theirs)) {
        event.preventDefault();
        resolveBlock(block, choiceText(block, quickChoice));
      }
      return;
    }
    if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      focusBlock(activeBlock + (event.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      if (hasUnsavedChanges && !busy) void saveDraft();
      return;
    }
    // The textarea keeps its native undo for typing; everywhere else Ctrl+Z walks the gutter-action history.
    if ((event.ctrlKey || event.metaKey) && !(event.target instanceof HTMLTextAreaElement) && stages && !busy) {
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
      else if ((key === "z" && event.shiftKey) || key === "y") { event.preventDefault(); redo(); }
    }
  }}>
    <header className="conflictWindowHeader">
      <div><p className="sectionEyebrow">CONFLICT REVIEW · {currentSession.data?.operation || "WORKFLOW"}</p><h1>Resolve conflicts</h1></div>
      <div className="conflictWindowProgress" role="status">{currentSession.data ? `${currentSession.data.conflictedPaths.length} unresolved` : "Waiting for task state"}</div>
    </header>
    {currentSession.error && <p className="taskCenterError" role="alert">{currentSession.error}</p>}
    {currentSession.loading && <p className="diffSpecialState" role="status">Loading conflict task…</p>}
    {!currentSession.loading && currentSession.data && <div className="conflictWindowLayout">
      <nav className="conflictFileList" aria-label="Conflicted files">
        {currentSession.data.conflictedPaths.map((path) => <button className={path === selectedPath ? "selected" : ""} type="button" key={path} aria-current={path === selectedPath ? "page" : undefined} onClick={() => setSelectedPath(path)} disabled={Boolean(action.busy) || hasUnsavedChanges && path !== selectedPath} title={hasUnsavedChanges && path !== selectedPath ? "Save this result before switching files." : path}><span aria-hidden="true">U</span>{path}</button>)}
        {hasUnsavedChanges && <p role="status">Save this result before switching to another file.</p>}
        {currentSession.data.omittedConflictedPathCount > 0 && <p role="status">{currentSession.data.omittedConflictedPathCount} more files are outside the review limit.</p>}
        {currentSession.data.conflictedPaths.length === 0 && <p className="diffSpecialState">No unresolved files remain. Return to Task Center to continue the Git operation.</p>}
      </nav>
      <section className="conflictFileReview" aria-label="Three-way conflict review">
        {currentFile.error && <p className="taskCenterError" role="alert">{currentFile.error}</p>}
        {currentFile.loading && <p className="diffSpecialState" role="status">Loading conflict stages…</p>}
        {currentFile.data && <>
          <div className="conflictFileHeading"><strong title={currentFile.data.path}>{currentFile.data.path}</strong><span className="monoText" title={currentFile.data.headOid || "Unborn HEAD"}>HEAD {currentFile.data.headOid?.slice(0, 12) || "—"}</span></div>
          {!currentFile.data.isText ? <p className="diffSpecialState" role="status">This conflict contains binary or non-text content and cannot be edited as text.</p> : <>
            <div className="conflictToolbar" role="toolbar" aria-label="Conflict navigation">
              <div className="conflictToolbarGroup">
                <button type="button" aria-label="Previous conflict" title="Previous conflict (Alt+Up)" disabled={conflictBlocks.length < 2} onClick={() => focusBlock(activeBlock - 1)}>↑</button>
                <button type="button" aria-label="Next conflict" title="Next conflict (Alt+Down)" disabled={conflictBlocks.length < 2} onClick={() => focusBlock(activeBlock + 1)}>↓</button>
              </div>
              <div className="conflictToolbarGroup">
                <button type="button" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={busy || !history.canUndo} onClick={undo}>Undo</button>
                <button type="button" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={busy || !history.canRedo} onClick={redo}>Redo</button>
              </div>
              <span className="conflictCounter" role="status">{conflictBlocks.length === 0 ? (totalConflicts > 0 ? `All ${totalConflicts} conflicts resolved` : "No conflict markers") : `${resolvedBlocks} of ${totalConflicts} resolved · ${conflictBlocks.length} remaining`}</span>
              <div className="conflictToolbarGroup" role="group" aria-label="Apply non-conflicting changes">
                <span className="conflictToolbarLabel">Apply non-conflicting</span>
                <button type="button" aria-label="Apply all non-conflicting changes" title={canRebuild ? "Rebuild the result with every non-conflicting change from both sides" : "Not available for added, deleted or very different files"} disabled={busy || !canRebuild || !availableModes.all} onClick={() => requestApply("all")}>All</button>
                <button type="button" aria-label="Apply non-conflicting changes from ours" disabled={busy || !canRebuild || !availableModes.ours} onClick={() => requestApply("ours")}>Ours</button>
                <button type="button" aria-label="Apply non-conflicting changes from theirs" disabled={busy || !canRebuild || !availableModes.theirs} onClick={() => requestApply("theirs")}>Theirs</button>
              </div>
              <div className="conflictToolbarGroup">
                <button type="button" disabled={busy} onClick={() => useEntire(currentFile.data?.oursContent ?? null)}>Use entire ours</button>
                <button type="button" disabled={busy} onClick={() => useEntire(currentFile.data?.theirsContent ?? null)}>Use entire theirs</button>
              </div>
            </div>
            {pendingApply && <div className="conflictConfirm" role="group" aria-label="Confirm apply non-conflicting changes">
              <span>This rebuilds the working result from the three versions and replaces your unsaved edits. You can undo it.</span>
              <div className="conflictToolbarGroup">
                <button type="button" onClick={() => applyNonConflicting(pendingApply)}>Replace working result</button>
                <button type="button" onClick={() => setPendingApply(null)}>Keep my edits</button>
              </div>
            </div>}
            {conflictBlocks.length > 0 && <section className="conflictMerge" aria-label="Conflict blocks">
              <div className="conflictMergeColumns" aria-hidden="true"><span>OURS · current branch</span><span /><span>RESULT · base</span><span /><span>THEIRS · incoming</span></div>
              {conflictBlocks.map((block, position) => <ConflictBlockRow
                key={block.id}
                block={block}
                base={baseForBlock(block, regions)}
                ignored={ignored[block.id] ?? {}}
                busy={busy}
                active={position === activeBlock}
                rowRef={(node) => { blockRefs.current[position] = node; }}
                onActivate={() => setActiveBlock(position)}
                onApply={(choice) => resolveBlock(block, choiceText(block, choice))}
                onIgnore={(side) => ignoreSide(block, side)}
              />)}
            </section>}
            <details className="conflictStageDetails">
              <summary>FULL FILE VERSIONS · OURS / BASE / THEIRS</summary>
              <div className="conflictStages">
                <ConflictStage label="OURS" content={currentFile.data.oursContent} />
                <ConflictStage label="BASE" content={currentFile.data.baseContent} />
                <ConflictStage label="THEIRS" content={currentFile.data.theirsContent} />
              </div>
            </details>
            <details className="conflictResultPreview">
              <summary>RESULT PREVIEW</summary>
              <pre>{draft || "(empty working result)"}</pre>
            </details>
            <section className="conflictResultEditor" aria-label="Working result editor">
              <div><label htmlFor="conflict-result">EDIT WORKING RESULT</label><small>Edits remain local until saved · {currentFile.data.resultRevision.slice(0, 12)}</small></div>
              <textarea id="conflict-result" aria-label="Working result" spellCheck={false} value={draft} disabled={Boolean(action.busy)} onBlur={() => { typingRecorded.current = false; }} onChange={(event) => {
                if (!typingRecorded.current) { history.record(draft); typingRecorded.current = true; }
                updateDraft(event.currentTarget.value, savedResult, setDraft, setHasUnsavedChanges);
              }} />
              <footer>
                <div className="conflictResultActions" role="group" aria-label="Conflict result actions">
                  <button type="button" onClick={() => void saveDraft()} disabled={Boolean(action.busy) || !hasUnsavedChanges}>{action.busy === "save" ? "Saving…" : "Save result"}</button>
                  <button type="button" onClick={() => void markResolved()} disabled={Boolean(action.busy) || hasUnsavedChanges}>{action.busy === "resolve" ? "Marking…" : "Mark resolved"}</button>
                  {hasUnsavedChanges && conflictBlocks.length === 0 && <button type="button" onClick={() => void saveDraft().then((saved) => saved && markResolved(saved))} disabled={Boolean(action.busy)}>Save &amp; mark resolved</button>}
                </div>
                {hasUnsavedChanges ? <span>Unsaved edits · Ctrl+S saves</span> : conflictBlocks.length > 0 && <span role="status">{conflictBlocks.length} conflict {conflictBlocks.length === 1 ? "marker" : "markers"} still in the result</span>}
              </footer>
            </section>
          </>}
        </>}
        {action.message && <p className="conflictActionStatus" role="status">{action.message}</p>}
        {action.error && <p className="taskCenterError" role="alert">{action.error}</p>}
        {currentFile.data?.isText && <button type="button" className="secondaryButton" disabled={Boolean(action.busy) || hasUnsavedChanges} title={hasUnsavedChanges ? "Save the working result before reviewing an AI suggestion" : "Preview conflict sources and explicitly confirm before sending"} onClick={() => setSuggestionOpen((open) => !open)}>AI suggestion</button>}
        {suggestionOpen && api && currentFile.data?.isText && <ConflictSuggestionPanel key={`${currentFile.data.path}:${currentFile.data.resultRevision}`} api={api} file={currentFile.data} hasUnsavedChanges={hasUnsavedChanges} onClose={() => setSuggestionOpen(false)} />}
      </section>
    </div>}
  </main>;
}

function updateDraft(content: string, savedContent: string, setDraft: (content: string) => void, setHasUnsavedChanges: (dirty: boolean) => void) {
  setDraft(content);
  setHasUnsavedChanges(content !== savedContent);
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function ConflictStage({ label, content }: { label: string; content: string | null }) {
  return <section className="conflictStage"><div><h2>{label}</h2></div><pre onScroll={syncStageScroll}>{content ?? "(file absent in this stage)"}</pre></section>;
}

function syncStageScroll(event: UIEvent<HTMLPreElement>) {
  const source = event.currentTarget;
  for (const pane of source.closest(".conflictStages")?.querySelectorAll("pre") ?? []) {
    if (pane === source) continue;
    pane.scrollTop = source.scrollTop;
    pane.scrollLeft = source.scrollLeft;
  }
}
