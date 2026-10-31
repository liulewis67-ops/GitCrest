import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { GitCrestApiClient, type WorkflowConflictFileResponse, type WorkflowRecoveryPreflightResponse } from "../../../api/client";
import { getGitCrestBridge } from "../../../api/bridge";
import { useCoreRestartCount } from "../../../shared/hooks/use-core-restart-count";
import { WindowControls } from "../../../shared/ui/WindowControls";
import { baseForBlock, choiceText, findConflictBlocks, replaceConflictBlock, type ConflictBlock } from "../model/conflict-blocks";
import { splitLines } from "../model/line-diff";
import { countConflicts, merge3, renderMerge3, type NonConflictingMode } from "../model/merge3";
import { applySmartMerge, smartMergeBlock, type SmartMergeOutcome } from "../model/smart-merge";
import { useDraftHistory } from "../model/use-draft-history";
import { ConflictBlockRow, type IgnoredSides } from "./ConflictBlockRow";
import { ConflictSuggestionPanel } from "./ConflictSuggestionPanel";

type RequestState<T> = { key: string; loading: boolean; data?: T; error?: DisplayError };
type ActionState = { busy?: "save" | "resolve"; message?: string; error?: DisplayError };

const TASK_POLL_INTERVAL_MS = 250;
const TASK_POLL_ATTEMPTS = 60;

export function ConflictWindow() {
  const { t } = useI18n();
  const params = new URLSearchParams(window.location.search);
  const repoId = params.get("repoId") || "";
  const taskId = params.get("taskId") || "";
  const label = params.get("label") || "";
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
  const coreRestarts = useCoreRestartCount();
  // Unsaved edits survive reconnecting to a restarted core: the reloaded file takes them back.
  const carriedDraftRef = useRef<{ path: string; draft: string }>();
  selectedPathRef.current = selectedPath;
  const sessionKey = `${repoId}:${taskId}`;
  const fileKey = `${sessionKey}:${selectedPath}`;

  useEffect(() => () => actionControllerRef.current?.abort(), []);

  useEffect(() => {
    if (coreRestarts > 0 && hasUnsavedChanges && selectedPathRef.current) carriedDraftRef.current = { path: selectedPathRef.current, draft };
  }, [coreRestarts]);

  useEffect(() => {
    const controller = new AbortController();
    if (!repoId || !/^repo_[a-f0-9]{64}$/.test(repoId) || !taskId) {
      setSession({ key: sessionKey, loading: false, error: t("cf.invalid") });
      return () => controller.abort();
    }
    setApi(undefined);
    setSession({ key: sessionKey, loading: true });
    const bridge = getGitCrestBridge();
    if (!bridge) {
      setSession({
        key: sessionKey,
        loading: false,
        error: t("cf.noBridge"),
      });
      return () => controller.abort();
    }
    void bridge.getSidecarConnection().then(async (connection) => {
      if (controller.signal.aborted) return;
      if (connection.windowAccess !== "conflictResolution") throw new Error(t("cf.restricted"));
      const client = new GitCrestApiClient(connection.baseUrl, connection.token);
      const preview = await client.withSignal(controller.signal).preflightRepositoryWorkflowRecovery(repoId, taskId);
      if (controller.signal.aborted) return;
      setApi(client);
      setSession({ key: sessionKey, loading: false, data: preview });
      setSelectedPath((current) => preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || "");
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setSession({ key: sessionKey, loading: false, error: describeApiError(reason, t("cf.loadTask")) });
    });
    return () => controller.abort();
  }, [repoId, taskId, sessionKey, coreRestarts]);

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
        const carried = carriedDraftRef.current?.path === selectedPath && response.isText ? carriedDraftRef.current.draft : undefined;
        carriedDraftRef.current = undefined;
        const content = carried ?? response.resultContent ?? "";
        setDraft(content);
        if (carried !== undefined) setHasUnsavedChanges(true);
        setTotalBlocks(response.isText ? findConflictBlocks(content).length : 0);
        setActiveBlock(0);
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && selectedPathRef.current === selectedPath) setFile({ key: fileKey, loading: false, error: describeApiError(reason, t("cf.loadStages")) });
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
    setAction({ busy: "save", message: t("cf.saving") });
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
            setAction({ message: t("cf.saved") });
          }
          return refreshed;
        }
      }
      throw new Error(t("cf.saveIncomplete"));
    } catch (reason) {
      if (controller.signal.aborted) return undefined;
      setAction({ error: describeApiError(reason, t("cf.saveFailed")) });
      try { await refreshSession(controller.signal); } catch { /* Keep the reviewed content visible when refresh is unavailable. */ }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  };

  const markResolved = async (fileOverride?: WorkflowConflictFileResponse, side?: "ours" | "theirs") => {
    const currentFile = fileOverride ?? file.data;
    if (!api || !currentFile || (!currentFile.isText && !side) || (hasUnsavedChanges && !fileOverride) || action.busy) return;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setAction({ busy: "resolve", message: side ? t("cf.applyingSide") : t("cf.staging") });
    try {
      const mutation = {
        taskId,
        path: currentFile.path,
        expectedOperation: currentFile.operation,
        expectedHeadOid: currentFile.headOid || "",
        expectedResultRevision: currentFile.resultRevision,
      };
      if (side) await api.chooseRepositoryWorkflowConflictSide(repoId, { ...mutation, side });
      else await api.markRepositoryWorkflowConflictResolved(repoId, mutation);
      for (let attempt = 0; attempt < TASK_POLL_ATTEMPTS; attempt += 1) {
        await delay(TASK_POLL_INTERVAL_MS, controller.signal);
        if (controller.signal.aborted) return;
        const preview = await api.withSignal(controller.signal).preflightRepositoryWorkflowRecovery(repoId, taskId);
        if (controller.signal.aborted) return;
        if (!preview.conflictedPaths.includes(currentFile.path)) {
          setSession({ key: sessionKey, loading: false, data: preview });
          setSelectedPath((current) => current === currentFile.path ? preview.conflictedPaths[0] || "" : current);
          setAction({ message: t("cf.resolvedMsg") });
          return;
        }
      }
      throw new Error(t("cf.resolveIncomplete"));
    } catch (reason) {
      if (controller.signal.aborted) return;
      setAction({ error: describeApiError(reason, t("cf.resolveFailed")) });
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
  // Outcomes depend only on a block's content and the stages, so typing in the editor reuses them.
  const smartCache = useMemo(() => new Map<string, SmartMergeOutcome>(), [regions]);
  const smartOutcomes = conflictBlocks.map((block) => {
    const key = `${block.id}\u0000${block.base ?? "\u0001"}`;
    let outcome = smartCache.get(key);
    if (!outcome) { outcome = smartMergeBlock(block, regions); smartCache.set(key, outcome); }
    return outcome;
  });
  const mergeableBlocks = smartOutcomes.filter((outcome) => outcome.kind === "merged").length;
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
  /** The AI merge becomes an unsaved, undoable draft; saving and marking resolved stay manual. */
  const applyAiMerge = (content: string) => {
    changeDraft(content);
    setIgnored({});
    setActiveBlock(0);
    setSuggestionOpen(false);
    setAction({ message: t("cs.applied") });
  };
  const smartMergeAll = () => {
    const { content, merged } = applySmartMerge(draft, conflictBlocks, smartOutcomes);
    if (merged === 0) return;
    const remaining = conflictBlocks.length - merged;
    const mergedIds = new Set(conflictBlocks.filter((_block, index) => smartOutcomes[index].kind === "merged").map((block) => block.id));
    changeDraft(content);
    setIgnored((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !mergedIds.has(id))));
    setActiveBlock(0);
    // The first block left is the first one that needs a decision; bring it into view once it has rendered.
    window.requestAnimationFrame(() => blockRefs.current[0]?.scrollIntoView?.({ block: "center", behavior: "smooth" }));
    const left = remaining === 0 ? t("cf.smartLeftNone") : t(remaining === 1 ? "cf.smartDecideOne" : "cf.smartDecideMany", { count: remaining });
    setAction({ message: t(merged === 1 ? "cf.smartMergedOne" : "cf.smartMergedMany", { count: merged, left }) });
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
    setAction({ message: t("cf.appliedNonConflicting", { mode: mode === "all" ? t("cf.bothSides") : mode, left: remaining === 0 ? t("cf.noneRemain") : t(remaining === 1 ? "cf.leftOne" : "cf.leftMany", { count: remaining }) }) });
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
  return <main className="conflictWindow" aria-label={t("cf.aria")} onKeyDown={(event) => {
    // event.code keeps Alt+digit working on layouts where Alt changes the produced character.
    const digit = /^(?:Digit|Numpad)([123])$/.exec(event.code)?.[1] ?? event.key;
    const quickChoice = ({ "1": "ours", "2": "theirs", "3": "both", "4": "smart" } as Record<string, "ours" | "theirs" | "both" | "smart">)[digit];
    if (event.altKey && !event.ctrlKey && !event.metaKey && quickChoice && !busy) {
      const position = Math.min(activeBlock, conflictBlocks.length - 1);
      const block = conflictBlocks[position];
      const skipped = ignored[block?.id ?? ""] ?? {};
      if (quickChoice === "smart") {
        const outcome = smartOutcomes[position];
        if (block && outcome?.kind === "merged" && !skipped.ours && !skipped.theirs) {
          event.preventDefault();
          resolveBlock(block, outcome.text);
        }
        return;
      }
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
      <div><p className="sectionEyebrow">{t("cf.eyebrow", { op: currentSession.data?.operation || t("cf.workflow") })}</p><h1>{t("cf.title")}</h1>{label && <p className="conflictWindowLabel">{label}</p>}</div>
      <div className="conflictWindowProgress" role="status">{currentSession.data ? t("cf.unresolved", { count: currentSession.data.conflictedPaths.length }) : t("cf.waiting")}</div>
      <WindowControls controls={getGitCrestBridge()?.windowControls} />
    </header>
    {currentSession.error && <p className="taskCenterError" role="alert"><ErrorMessage error={currentSession.error} /></p>}
    {currentSession.loading && <p className="diffSpecialState" role="status">{t("cf.loadingTask")}</p>}
    {!currentSession.loading && currentSession.data && <div className="conflictWindowLayout">
      <nav className="conflictFileList" aria-label={t("cf.filesAria")}>
        {currentSession.data.conflictedPaths.map((path) => <button className={path === selectedPath ? "selected" : ""} type="button" key={path} aria-current={path === selectedPath ? "page" : undefined} onClick={() => setSelectedPath(path)} disabled={Boolean(action.busy) || hasUnsavedChanges && path !== selectedPath} title={hasUnsavedChanges && path !== selectedPath ? t("cf.saveBeforeSwitchTitle") : path}><span aria-hidden="true">U</span>{path}</button>)}
        {hasUnsavedChanges && <p role="status">{t("cf.saveBeforeSwitch")}</p>}
        {currentSession.data.omittedConflictedPathCount > 0 && <p role="status">{t("cf.outsideLimit", { count: currentSession.data.omittedConflictedPathCount })}</p>}
        {currentSession.data.conflictedPaths.length === 0 && <p className="diffSpecialState">{t("cf.noneLeft")}</p>}
      </nav>
      <section className="conflictFileReview" aria-label={t("cf.reviewAria")}>
        {currentFile.error && <p className="taskCenterError" role="alert"><ErrorMessage error={currentFile.error} /></p>}
        {currentFile.loading && <p className="diffSpecialState" role="status">{t("cf.loadingStages")}</p>}
        {currentFile.data && <>
          <div className="conflictFileHeading"><strong title={currentFile.data.path}>{currentFile.data.path}</strong><span className="monoText" title={currentFile.data.headOid || t("cf.unbornHead")}>{t("cf.headLabel", { oid: currentFile.data.headOid?.slice(0, 12) || "—" })}</span></div>
          {(!currentFile.data.isText || !currentFile.data.oursPresent || !currentFile.data.theirsPresent) && <section className="conflictChooseSide" aria-label={t("cf.takeWhole")}>
            <p role="status">{!currentFile.data.isText ? t("cf.binary") : !currentFile.data.oursPresent ? t("cf.oursDeleted") : t("cf.theirsDeleted")}</p>
            <div className="conflictToolbarGroup" role="group" aria-label={t("cf.takeWhole")}>
              <button type="button" disabled={busy || hasUnsavedChanges} onClick={() => void markResolved(undefined, "ours")}>{currentFile.data.oursPresent ? t("cf.useOurs") : t("cf.acceptDelOurs")}</button>
              <button type="button" disabled={busy || hasUnsavedChanges} onClick={() => void markResolved(undefined, "theirs")}>{currentFile.data.theirsPresent ? t("cf.useTheirs") : t("cf.acceptDelTheirs")}</button>
            </div>
          </section>}
          {!currentFile.data.isText || !currentFile.data.oursPresent || !currentFile.data.theirsPresent ? null : <>
            <div className="conflictToolbar" role="toolbar" aria-label={t("cf.navAria")}>
              <div className="conflictToolbarGroup">
                <button type="button" aria-label={t("cf.prevAria")} title={t("cf.prevTitle")} disabled={conflictBlocks.length < 2} onClick={() => focusBlock(activeBlock - 1)}>↑</button>
                <button type="button" aria-label={t("cf.nextAria")} title={t("cf.nextTitle")} disabled={conflictBlocks.length < 2} onClick={() => focusBlock(activeBlock + 1)}>↓</button>
              </div>
              <div className="conflictToolbarGroup">
                <button type="button" aria-label={t("cf.undo")} title={t("cf.undoTitle")} disabled={busy || !history.canUndo} onClick={undo}>{t("cf.undo")}</button>
                <button type="button" aria-label={t("cf.redo")} title={t("cf.redoTitle")} disabled={busy || !history.canRedo} onClick={redo}>{t("cf.redo")}</button>
              </div>
              <span className="conflictCounter" role="status">{conflictBlocks.length === 0 ? (totalConflicts > 0 ? t("cf.allResolved", { count: totalConflicts }) : t("cf.noMarkers")) : t("cf.progress", { done: resolvedBlocks, total: totalConflicts, left: conflictBlocks.length })}</span>
              <div className="conflictToolbarGroup" role="group" aria-label={t("cf.applyGroup")}>
                <span className="conflictToolbarLabel">{t("cf.applyLabel")}</span>
                <button type="button" aria-label={t("cf.applyAllAria")} title={canRebuild ? t("cf.applyAllTitle") : t("cf.applyUnavailable")} disabled={busy || !canRebuild || !availableModes.all} onClick={() => requestApply("all")}>{t("cf.all")}</button>
                <button type="button" aria-label={t("cf.applyOursAria")} disabled={busy || !canRebuild || !availableModes.ours} onClick={() => requestApply("ours")}>{t("cf.ours")}</button>
                <button type="button" aria-label={t("cf.applyTheirsAria")} disabled={busy || !canRebuild || !availableModes.theirs} onClick={() => requestApply("theirs")}>{t("cf.theirs")}</button>
              </div>
              <div className="conflictToolbarGroup">
                <button type="button" disabled={busy} onClick={() => useEntire(currentFile.data?.oursContent ?? null)}>{t("cf.entireOurs")}</button>
                <button type="button" disabled={busy} onClick={() => useEntire(currentFile.data?.theirsContent ?? null)}>{t("cf.entireTheirs")}</button>
              </div>
            </div>
            {conflictBlocks.length > 0 && <div className={`conflictSmartBar${mergeableBlocks > 0 ? " ready" : ""}`} role="group" aria-label={t("cf.smartAria")}>
              <p role="status">{smartSummary(t, mergeableBlocks, conflictBlocks.length)}</p>
              <button type="button" className="conflictSmartButton" title={mergeableBlocks > 0 ? t("cf.smartMergeTitle") : t("cf.smartMergeNoneTitle")} disabled={busy || mergeableBlocks === 0} onClick={smartMergeAll}>{t("cf.smartMerge")}{mergeableBlocks > 0 && <span className="conflictSmartCount" aria-hidden="true">{mergeableBlocks}</span>}</button>
            </div>}
            {pendingApply && <div className="conflictConfirm" role="group" aria-label={t("cf.confirmApplyAria")}>
              <span>{t("cf.confirmApply")}</span>
              <div className="conflictToolbarGroup">
                <button type="button" onClick={() => applyNonConflicting(pendingApply)}>{t("cf.replaceResult")}</button>
                <button type="button" onClick={() => setPendingApply(null)}>{t("cf.keepEdits")}</button>
              </div>
            </div>}
            {conflictBlocks.length > 0 && <section className="conflictMerge" aria-label={t("cf.blocksAria")}>
              <div className="conflictMergeColumns" aria-hidden="true"><span>{t("cf.colOurs")}</span><span /><span>{t("cf.colResult")}</span><span /><span>{t("cf.colTheirs")}</span></div>
              {conflictBlocks.map((block, position) => <ConflictBlockRow
                key={block.id}
                block={block}
                base={baseForBlock(block, regions)}
                smart={smartOutcomes[position]}
                ignored={ignored[block.id] ?? {}}
                busy={busy}
                active={position === activeBlock}
                rowRef={(node) => { blockRefs.current[position] = node; }}
                onActivate={() => setActiveBlock(position)}
                onApply={(choice) => resolveBlock(block, choiceText(block, choice))}
                onIgnore={(side) => ignoreSide(block, side)}
                onSmartMerge={() => { const outcome = smartOutcomes[position]; if (outcome.kind === "merged") resolveBlock(block, outcome.text); }}
              />)}
            </section>}
            <details className="conflictStageDetails">
              <summary>{t("cf.fullVersions")}</summary>
              <div className="conflictStages">
                <ConflictStage label={t("cf.stageOurs")} content={currentFile.data.oursContent} />
                <ConflictStage label={t("cf.stageBase")} content={currentFile.data.baseContent} />
                <ConflictStage label={t("cf.stageTheirs")} content={currentFile.data.theirsContent} />
              </div>
            </details>
            <details className="conflictResultPreview">
              <summary>{t("cf.resultPreview")}</summary>
              <pre>{draft || t("cf.emptyResult")}</pre>
            </details>
            <section className="conflictResultEditor" aria-label={t("cf.editorAria")}>
              <div><label htmlFor="conflict-result">{t("cf.editResult")}</label><small>{t("cf.editsLocal", { rev: currentFile.data.resultRevision.slice(0, 12) })}</small></div>
              <textarea id="conflict-result" aria-label={t("cf.resultTextarea")} spellCheck={false} value={draft} disabled={Boolean(action.busy)} onBlur={() => { typingRecorded.current = false; }} onChange={(event) => {
                if (!typingRecorded.current) { history.record(draft); typingRecorded.current = true; }
                updateDraft(event.currentTarget.value, savedResult, setDraft, setHasUnsavedChanges);
              }} />
              <footer>
                <div className="conflictResultActions" role="group" aria-label={t("cf.actionsAria")}>
                  <button type="button" onClick={() => void saveDraft()} disabled={Boolean(action.busy) || !hasUnsavedChanges}>{action.busy === "save" ? t("cf.saving2") : t("cf.saveResult")}</button>
                  <button type="button" onClick={() => void markResolved()} disabled={Boolean(action.busy) || hasUnsavedChanges}>{action.busy === "resolve" ? t("cf.marking") : t("cf.markResolved")}</button>
                  {hasUnsavedChanges && conflictBlocks.length === 0 && <button type="button" onClick={() => void saveDraft().then((saved) => saved && markResolved(saved))} disabled={Boolean(action.busy)}>{t("cf.saveAndMark")}</button>}
                </div>
                {hasUnsavedChanges ? <span>{t("cf.unsaved")}</span> : conflictBlocks.length > 0 && <span role="status">{t(conflictBlocks.length === 1 ? "cf.markerOne" : "cf.markerMany", { count: conflictBlocks.length })}</span>}
              </footer>
            </section>
          </>}
        </>}
        {action.message && <p className="conflictActionStatus" role="status">{action.message}</p>}
        {action.error && <p className="taskCenterError" role="alert"><ErrorMessage error={action.error} /></p>}
        {currentFile.data?.isText && <button type="button" className="secondaryButton" disabled={Boolean(action.busy) || hasUnsavedChanges} title={hasUnsavedChanges ? t("cf.aiSaveFirst") : t("cf.aiPreview")} onClick={() => setSuggestionOpen((open) => !open)}>{t("cf.aiButton")}</button>}
        {suggestionOpen && api && currentFile.data?.isText && <ConflictSuggestionPanel key={`${currentFile.data.path}:${currentFile.data.resultRevision}`} api={api} file={currentFile.data} hasUnsavedChanges={hasUnsavedChanges} onUseSuggestion={applyAiMerge} onClose={() => setSuggestionOpen(false)} />}
      </section>
    </div>}
  </main>;
}

function smartSummary(t: ReturnType<typeof useI18n>["t"], mergeable: number, total: number) {
  const overlapping = total - mergeable;
  if (mergeable === 0) return total === 1 ? t("cf.smartNoneOne") : t("cf.smartNoneMany", { count: total });
  if (overlapping === 0) return total === 1 ? t("cf.smartOneReady") : t("cf.smartAllReady", { total });
  return `${t("cf.smartReady", { mergeable, total })} ${t(overlapping === 1 ? "cf.smartDecideOne" : "cf.smartDecideMany", { count: overlapping })}`;
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
  const { t } = useI18n();
  return <section className="conflictStage"><div><h2>{label}</h2></div><pre onScroll={syncStageScroll}>{content ?? t("cf.absentStage")}</pre></section>;
}

function syncStageScroll(event: UIEvent<HTMLPreElement>) {
  const source = event.currentTarget;
  for (const pane of source.closest(".conflictStages")?.querySelectorAll("pre") ?? []) {
    if (pane === source) continue;
    pane.scrollTop = source.scrollTop;
    pane.scrollLeft = source.scrollLeft;
  }
}
