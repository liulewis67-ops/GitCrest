import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { GitCrestApiClient, type WorkflowConflictFileResponse, type WorkflowRecoveryPreflightResponse } from "../../../api/client";
import { getGitCrestBridge } from "../../../api/bridge";
import { useCoreRestartCount } from "../../../shared/hooks/use-core-restart-count";
import { WindowControls } from "../../../shared/ui/WindowControls";
import { baseForBlock, findConflictBlocks, replaceConflictBlock, type ConflictBlock } from "../model/conflict-blocks";
import { splitLines } from "../model/line-diff";
import { countConflicts, merge3, renderMerge3, type NonConflictingMode } from "../model/merge3";
import { applySmartMerge, smartMergeBlock, type SmartMergeOutcome } from "../model/smart-merge";
import { analyzeConflictDraft, preserveFinalNewline, reviewChoiceText } from "../model/conflict-review";
import { Button } from "../../../shared/ui/Button";
import { MenuButton } from "../../../shared/ui/MenuButton";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ConflictWorkspace } from "./ConflictWorkspace";
import type { ConflictEditorHandle } from "./ConflictEditor";
import { ConflictSuggestionPanel } from "./ConflictSuggestionPanel";

type IgnoredSides = { ours?: boolean; theirs?: boolean };

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
  const [pendingApply, setPendingApply] = useState<{ label: string; title?: string; description?: string; confirmLabel?: string; apply: () => void }>();
  const resultRef = useRef<ConflictEditorHandle>(null);
  const completionRef = useRef<HTMLHeadingElement>(null);
  const [history, setHistory] = useState({ canUndo: false, canRedo: false });
  const [focusRequest, setFocusRequest] = useState(0);
  const [filesOpen, setFilesOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const dialogAppliedRef = useRef(false);
  const mutationBusy = useRef(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffError, setHandoffError] = useState(false);
  const [reload, setReload] = useState(0);
  const [editorReady, setEditorReady] = useState(false);
  const [recoveredDraft, setRecoveredDraft] = useState(false);
  const selectedPathRef = useRef(selectedPath);
  const actionControllerRef = useRef<AbortController | null>(null);
  const coreRestarts = useCoreRestartCount();
  // Unsaved edits survive reconnecting to a restarted core: the reloaded file takes them back.
  const carriedDraftRef = useRef<{ path: string; draft: string; file: WorkflowConflictFileResponse }>();
  selectedPathRef.current = selectedPath;
  const sessionKey = `${repoId}:${taskId}`;
  const fileKey = `${sessionKey}:${selectedPath}`;

  useEffect(() => () => actionControllerRef.current?.abort(), []);

  useEffect(() => {
    if (coreRestarts > 0 && hasUnsavedChanges && selectedPathRef.current && file.data) carriedDraftRef.current = { path: selectedPathRef.current, draft, file: file.data };
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
      setSelectedPath((current) => carriedDraftRef.current?.path ?? (preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || ""));
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setSession({ key: sessionKey, loading: false, error: describeApiError(reason, t("cf.loadTask")) });
    });
    return () => controller.abort();
  }, [repoId, taskId, sessionKey, coreRestarts, reload]);

  useEffect(() => {
    const controller = new AbortController();
    if (!api || !selectedPath) {
      setFile({ key: fileKey, loading: false });
      return () => controller.abort();
    }
    const recovered = carriedDraftRef.current;
    if (recovered?.path === selectedPath) {
      carriedDraftRef.current = undefined;
      setFile({ key: fileKey, loading: false, data: recovered.file });
      setDraft(recovered.draft);
      setHasUnsavedChanges(true);
      setRecoveredDraft(true);
      setEditorReady(false);
      setAction({ message: t("resolver.recovered") });
      return () => controller.abort();
    }
    setFile({ key: fileKey, loading: true });
    setEditorReady(false);
    setAction({});
    setSuggestionOpen(false);
    setHasUnsavedChanges(false);
    setRecoveredDraft(false);
    setIgnored({});
    setPendingApply(undefined);
    setDetailsOpen(false);
    setHistory({ canUndo: false, canRedo: false });
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
  }, [api, repoId, taskId, selectedPath, fileKey]);

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
    // A failed mutation may race with external resolution. Keep a dirty draft reviewable.
    if (hasUnsavedChanges && !preview.conflictedPaths.includes(selectedPathRef.current)) return preview;
    setSession({ key: sessionKey, loading: false, data: preview });
    setSelectedPath((current) => preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || "");
    return preview;
  };

  const saveDraft = async (): Promise<WorkflowConflictFileResponse | undefined> => {
    const currentFile = file.data;
    if (!api || !currentFile || !currentFile.isText || !editorReady || mutationBusy.current) return undefined;
    mutationBusy.current = true;
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
            setRecoveredDraft(false);
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
      if (actionControllerRef.current === controller) { actionControllerRef.current = null; mutationBusy.current = false; }
    }
  };

  const markResolved = async (fileOverride?: WorkflowConflictFileResponse, side?: "ours" | "theirs") => {
    const currentFile = fileOverride ?? file.data;
    if (!api || !currentFile || (!currentFile.isText && !side) || (hasUnsavedChanges && !fileOverride) || mutationBusy.current) return;
    if (!side && !editorReady) return;
    if (!side && analyzeConflictDraft(fileOverride?.resultContent ?? draft).hasMarkers) return;
    mutationBusy.current = true;
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
      if (actionControllerRef.current === controller) { actionControllerRef.current = null; mutationBusy.current = false; }
    }
  };

  const currentSession = session.key === sessionKey ? session : { key: sessionKey, loading: true };
  const currentFile = file.key === fileKey ? file : { key: fileKey, loading: Boolean(selectedPath) };
  const analysis = useMemo(() => analyzeConflictDraft(currentFile.data?.isText ? draft : ""), [draft, currentFile.data?.isText]);
  const conflictBlocks = analysis.blocks;
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
  useEffect(() => { setTotalBlocks((previous) => Math.max(previous, conflictBlocks.length)); }, [conflictBlocks.length]);
  const savedResult = currentFile.data?.resultContent ?? "";
  const busy = Boolean(action.busy);

  const focusBlock = (position: number) => {
    if (conflictBlocks.length === 0) return;
    const next = (position + conflictBlocks.length) % conflictBlocks.length;
    setActiveBlock(next);
    setFocusRequest((value) => value + 1);
  };
  /** Programmatic draft change: recorded for undo and ends the current typing session. */
  const changeDraft = (content: string) => {
    if (content === draft) return;
    // Execute synchronously against the current model. Prop echoes must never overwrite newer typing.
    const applied = resultRef.current?.replace?.(content) ?? content;
    updateDraft(applied, savedResult, setDraft, setHasUnsavedChanges);
  };
  const resolveBlock = (block: ConflictBlock, replacement: string, side?: "ours" | "theirs" | "base") => {
    const actual = resultRef.current?.value() ?? draft;
    const current = findConflictBlocks(actual).find((item) => item.start === block.start && item.end === block.end && item.ours === block.ours && item.theirs === block.theirs && item.base === block.base);
    if (!current || actual !== draft) return;
    const source = side === "ours" ? stages?.oursContent : side === "theirs" ? stages?.theirsContent : side === "base" ? stages?.baseContent : stages?.oursContent?.endsWith("\n") === false && stages?.theirsContent?.endsWith("\n") === false ? stages.theirsContent : undefined;
    const next = replaceConflictBlock(actual, current, preserveFinalNewline(actual, current, replacement, source));
    const remaining = findConflictBlocks(next);
    const nextIndex = remaining.findIndex((item) => item.start >= current.start);
    setActiveBlock(nextIndex >= 0 ? nextIndex : 0);
    dialogAppliedRef.current = true;
    changeDraft(next);
    setFocusRequest((value) => value + 1);
    setIgnored(({ [block.id]: _resolved, ...rest }) => rest);
  };
  const ignoreSide = (block: ConflictBlock, side: "ours" | "theirs") => {
    const state = ignored[block.id] ?? {};
    const other = side === "ours" ? "theirs" : "ours";
    if (!state[side] && state[other]) {
      resolveBlock(block, baseForBlock(block, regions) ?? "", "base");
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
    dialogAppliedRef.current = true;
    setFocusRequest((value) => value + 1);
    setAction({ message: t("cs.applied") });
  };
  const smartMergeAll = () => {
    const preserveEnding = stages?.oursContent?.endsWith("\n") === false && stages?.theirsContent?.endsWith("\n") === false ? stages.theirsContent : undefined;
    const outcomes = smartOutcomes.map((outcome, index) => outcome.kind === "merged" ? { ...outcome, text: preserveFinalNewline(draft, conflictBlocks[index], outcome.text, preserveEnding) } : outcome);
    const { content, merged } = applySmartMerge(draft, conflictBlocks, outcomes);
    if (merged === 0) return;
    const remaining = conflictBlocks.length - merged;
    const mergedIds = new Set(conflictBlocks.filter((_block, index) => smartOutcomes[index].kind === "merged").map((block) => block.id));
    changeDraft(content);
    setIgnored((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !mergedIds.has(id))));
    setActiveBlock(0);
    // The first block left is the first one that needs a decision; bring it into view once it has rendered.
    setFocusRequest((value) => value + 1);
    const left = remaining === 0 ? t("cf.smartLeftNone") : t(remaining === 1 ? "cf.smartDecideOne" : "cf.smartDecideMany", { count: remaining });
    setAction({ message: t(merged === 1 ? "cf.smartMergedOne" : "cf.smartMergedMany", { count: merged, left }) });
  };
  const applyNonConflicting = (mode: NonConflictingMode) => {
    setPendingApply(undefined);
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
  const requestReplacement = (label: string, apply: () => void) => {
    dialogAppliedRef.current = false;
    if (hasUnsavedChanges) setPendingApply({ label, apply });
    else apply();
  };
  const requestApply = (mode: NonConflictingMode) => requestReplacement(t("cf.applyGroup"), () => applyNonConflicting(mode));
  const undo = () => resultRef.current?.undo();
  const redo = () => resultRef.current?.redo();
  const selectedBlock = conflictBlocks[Math.min(activeBlock, conflictBlocks.length - 1)];
  const selectedSmart = smartOutcomes[Math.min(activeBlock, conflictBlocks.length - 1)];
  const selectedIgnored = ignored[selectedBlock?.id ?? ""] ?? {};
  const isTextReview = Boolean(stages?.oursPresent && stages?.theirsPresent);
  const complete = Boolean(!hasUnsavedChanges && currentSession.data && currentSession.data.conflictedPaths.length === 0 && currentSession.data.omittedConflictedPathCount === 0);
  useEffect(() => { if (complete) completionRef.current?.focus(); }, [complete]);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => { if (!hasUnsavedChanges && !mutationBusy.current) void refreshSession(controller.signal).catch(() => {}); };
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("focus", refresh); controller.abort(); };
  }, [api, hasUnsavedChanges]);
  const returnToTasks = async () => {
    setHandoffBusy(true); setHandoffError(false);
    try { const result = await getGitCrestBridge()?.returnToTaskCenter?.(); if (!result?.ok) setHandoffError(true); }
    catch { setHandoffError(true); }
    finally { setHandoffBusy(false); }
  };
  const handleKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.getModifierState("AltGraph") || event.target instanceof HTMLElement && event.target.closest('[role="dialog"], [role="menu"]')) return;
    if (event.key === "Escape" && filesOpen) { event.preventDefault(); setFilesOpen(false); document.querySelector<HTMLButtonElement>(".resolverFilesToggle")?.focus(); return; }
    const digit = /^(?:Digit|Numpad)([1234])$/.exec(event.code)?.[1] ?? event.key;
    const quickChoice = ({ "1": "ours", "2": "theirs", "3": "both", "4": "smart" } as const)[digit as "1" | "2" | "3" | "4"];
    if (event.altKey && !event.ctrlKey && !event.metaKey && quickChoice && !busy && editorReady && selectedBlock && !analysis.malformed) {
      if (quickChoice === "smart") {
        if (selectedSmart?.kind === "merged" && !selectedIgnored.ours && !selectedIgnored.theirs) { event.preventDefault(); resolveBlock(selectedBlock, selectedSmart.text); }
      } else if (!(quickChoice !== "theirs" && selectedIgnored.ours) && !(quickChoice !== "ours" && selectedIgnored.theirs)) {
        event.preventDefault(); resolveBlock(selectedBlock, reviewChoiceText(selectedBlock, quickChoice, stages?.oursContent, stages?.theirsContent), quickChoice === "both" ? selectedBlock.theirs ? "theirs" : "ours" : quickChoice);
      }
      return;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault(); focusBlock(activeBlock + (event.key === "ArrowDown" ? 1 : -1)); return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault(); if (hasUnsavedChanges && !busy) void saveDraft(); return;
    }
    if ((event.ctrlKey || event.metaKey) && !(event.target instanceof HTMLElement && event.target.closest(".resolverResult .monaco-editor")) && !busy) {
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
      else if (key === "z" && event.shiftKey || key === "y") { event.preventDefault(); redo(); }
    }
  };
  return <main className="conflictWindow resolverWindow" aria-label={t("cf.aria")} onKeyDownCapture={handleKeys}>
    <header className="conflictWindowHeader">
      <div><h1>{t("cf.title")}</h1><span className="resolverOperation">{currentSession.data?.operation}{label ? ` · ${label}` : ""}</span></div>
      <div className="conflictWindowProgress" role="status">{currentSession.data ? t("cf.unresolved", { count: currentSession.data.conflictedPaths.length + currentSession.data.omittedConflictedPathCount }) : t("cf.waiting")}</div>
      <WindowControls controls={getGitCrestBridge()?.windowControls} />
    </header>
    {currentSession.error && <div className="taskCenterError" role="alert"><ErrorMessage error={currentSession.error} /><Button onClick={() => setReload((value) => value + 1)}>{t("resolver.retry")}</Button></div>}
    {currentSession.loading && <p className="diffSpecialState" role="status">{t("cf.loadingTask")}</p>}
    {!currentSession.loading && currentSession.data && (complete ? <section className="resolverComplete">
      <h2 ref={completionRef} tabIndex={-1}>{t("resolver.complete")}</h2><p>{t("cf.noneLeft")}</p>
      <Button variant="primary" disabled={handoffBusy} onClick={() => void returnToTasks()}>{t(handoffBusy ? "resolver.returning" : "resolver.returnTasks")}</Button>
      <Button variant="quiet" disabled={handoffBusy} onClick={() => setReload((value) => value + 1)}>{t("resolver.refresh")}</Button>
      {handoffError && <p role="alert">{t("resolver.handoffFailed")}</p>}
    </section> : <div className="conflictWindowLayout resolverLayout">
      <nav className={`conflictFileList resolverFiles${filesOpen ? " open" : ""}`} aria-label={t("cf.filesAria")}>
        <Button size="compact" className="resolverFilesClose" onClick={() => { setFilesOpen(false); document.querySelector<HTMLButtonElement>(".resolverFilesToggle")?.focus(); }}>{t("common.close")}</Button>
        {currentSession.data.conflictedPaths.map((path) => <Button variant="quiet" className={path === selectedPath ? "selected" : ""} key={path} aria-current={path === selectedPath ? "page" : undefined} onClick={() => { setSelectedPath(path); setFilesOpen(false); }} disabled={busy || hasUnsavedChanges && path !== selectedPath} title={hasUnsavedChanges && path !== selectedPath ? t("cf.saveBeforeSwitchTitle") : path}><span aria-hidden="true">U</span>{path}</Button>)}
        {hasUnsavedChanges && <p>{t("cf.saveBeforeSwitch")}</p>}
        {currentSession.data.omittedConflictedPathCount > 0 && <p>{t("cf.outsideLimit", { count: currentSession.data.omittedConflictedPathCount })}</p>}
      </nav>
      <section className="resolverReview" aria-label={t("cf.reviewAria")}>
        <div className="resolverFileHeading"><Button size="compact" className="resolverFilesToggle" aria-expanded={filesOpen} onClick={() => setFilesOpen((open) => !open)}>{t("resolver.files", { count: currentSession.data.conflictedPaths.length })}</Button><strong title={selectedPath}>{selectedPath}</strong>{recoveredDraft && <span>{t("resolver.recoveredLabel")}</span>}</div>
        {currentFile.error && <div className="taskCenterError" role="alert"><ErrorMessage error={currentFile.error} /><Button disabled={hasUnsavedChanges} onClick={() => setReload((value) => value + 1)}>{t("resolver.retry")}</Button></div>}
        {currentFile.loading && <p className="diffSpecialState" role="status">{t("cf.loadingStages")}</p>}
        {currentFile.data && (!isTextReview ? <section className="conflictChooseSide" aria-label={t("cf.takeWhole")}>
          <p>{!currentFile.data.isText ? t("cf.binary") : !currentFile.data.oursPresent ? t("cf.oursDeleted") : t("cf.theirsDeleted")}</p>
          <div className="resolverControlGroup"><Button disabled={busy} onClick={() => void markResolved(undefined, "ours")}>{currentFile.data.oursPresent ? t("cf.useOurs") : t("cf.acceptDelOurs")}</Button><Button disabled={busy} onClick={() => void markResolved(undefined, "theirs")}>{currentFile.data.theirsPresent ? t("cf.useTheirs") : t("cf.acceptDelTheirs")}</Button></div>
        </section> : <>
          <div className="resolverToolbar" role="group" aria-label={t("cf.navAria")}>
            <div className="resolverControlGroup"><Button size="compact" aria-label={t("cf.prevAria")} title={t("cf.prevTitle")} disabled={busy || conflictBlocks.length < 2} onClick={() => focusBlock(activeBlock - 1)}><UiIcon name="arrowUp" /></Button><Button size="compact" aria-label={t("cf.nextAria")} title={t("cf.nextTitle")} disabled={busy || conflictBlocks.length < 2} onClick={() => focusBlock(activeBlock + 1)}><UiIcon name="arrowDown" /></Button></div>
            <span className="resolverProgress" role="status">{analysis.malformed ? t("resolver.malformed") : conflictBlocks.length ? t("resolver.position", { current: Math.min(activeBlock + 1, conflictBlocks.length), total: conflictBlocks.length }) : t("cf.allResolved", { count: totalConflicts })}</span>
            <div className="resolverControlGroup"><Button size="compact" title={t("cf.undoTitle")} disabled={busy || !history.canUndo} onClick={undo}>{t("cf.undo")}</Button><Button size="compact" title={t("cf.redoTitle")} disabled={busy || !history.canRedo} onClick={redo}>{t("cf.redo")}</Button></div>
            <Button size="compact" variant="quiet" disabled={busy || hasUnsavedChanges} title={hasUnsavedChanges ? t("cf.saveBeforeSwitchTitle") : t("resolver.refresh")} aria-label={t("resolver.refresh")} onClick={() => setReload((value) => value + 1)}><UiIcon name="refresh" /></Button>
            <MenuButton label={t("resolver.fileActions")} menuLabel={t("resolver.fileActions")} disabled={busy || !editorReady} explainUnavailable className="gcButton gcButton-secondary gcButton-compact" items={[
              { id: "all", label: t("cf.applyAllAria"), disabled: !canRebuild || !availableModes.all, title: t(canRebuild ? "resolver.noNonConflicting" : "cf.applyUnavailable"), onSelect: () => requestApply("all") },
              { id: "ours", label: t("cf.applyOursAria"), disabled: !canRebuild || !availableModes.ours, title: t(canRebuild ? "resolver.noNonConflicting" : "cf.applyUnavailable"), onSelect: () => requestApply("ours") },
              { id: "theirs", label: t("cf.applyTheirsAria"), disabled: !canRebuild || !availableModes.theirs, title: t(canRebuild ? "resolver.noNonConflicting" : "cf.applyUnavailable"), onSelect: () => requestApply("theirs") },
              { id: "entireOurs", label: t("cf.entireOurs"), separatorBefore: true, onSelect: () => requestReplacement(t("cf.entireOurs"), () => useEntire(stages?.oursContent ?? null)) },
              { id: "entireTheirs", label: t("cf.entireTheirs"), onSelect: () => requestReplacement(t("cf.entireTheirs"), () => useEntire(stages?.theirsContent ?? null)) },
              { id: "smart", label: t("resolver.smartAll", { count: mergeableBlocks }), separatorBefore: true, disabled: !mergeableBlocks || analysis.malformed, title: t("cf.smartMergeNoneTitle"), onSelect: smartMergeAll },
              { id: "ai", label: t("cf.aiButton"), disabled: hasUnsavedChanges, title: t("cf.aiSaveFirst"), onSelect: () => { dialogAppliedRef.current = false; setSuggestionOpen(true); } },
            ]}>{t("resolver.fileActions")}</MenuButton>
          </div>
          <ConflictWorkspace key={fileKey} identity={fileKey} path={selectedPath} ours={stages?.oursContent ?? ""} theirs={stages?.theirsContent ?? ""} base={stages?.baseContent ?? null} draft={draft} dirty={hasUnsavedChanges} busy={busy} blocks={conflictBlocks} onReady={() => setEditorReady(true)} active={activeBlock} focusRequest={focusRequest} resultRef={resultRef}
            onAccept={(block, side) => resolveBlock(block, reviewChoiceText(block, side, stages?.oursContent, stages?.theirsContent), side)}
            onChange={(content) => updateDraft(content, savedResult, setDraft, setHasUnsavedChanges)} onHistory={(canUndo, canRedo) => setHistory({ canUndo, canRedo })} onActive={setActiveBlock} />
          <div className="resolverDecisions" role="group" aria-label={t("resolver.currentConflict")}>
            {selectedBlock ? <>
              <span>{t("cb.conflictN", { n: selectedBlock.index })}</span>
              <Button size="compact" disabled={busy || !editorReady || analysis.malformed || selectedIgnored.ours} title={t("cb.acceptOurs")} onClick={() => resolveBlock(selectedBlock, reviewChoiceText(selectedBlock, "ours", stages?.oursContent, stages?.theirsContent), "ours")}>{t("resolver.useCurrent")}</Button>
              <Button size="compact" disabled={busy || !editorReady || analysis.malformed || selectedIgnored.theirs} title={t("cb.acceptTheirs")} onClick={() => resolveBlock(selectedBlock, reviewChoiceText(selectedBlock, "theirs", stages?.oursContent, stages?.theirsContent), "theirs")}>{t("resolver.useIncoming")}</Button>
              <Button size="compact" disabled={busy || !editorReady || analysis.malformed || selectedIgnored.ours || selectedIgnored.theirs} title={t("cb.acceptBothTitle")} onClick={() => resolveBlock(selectedBlock, reviewChoiceText(selectedBlock, "both", stages?.oursContent, stages?.theirsContent), selectedBlock.theirs ? "theirs" : "ours")}>{t("cb.acceptBoth")}</Button>
              <Button size="compact" variant="quiet" aria-expanded={detailsOpen} onClick={() => { dialogAppliedRef.current = false; setDetailsOpen((open) => !open); }}>{t("resolver.details")}</Button>
            </> : !analysis.malformed && <span>{t("resolver.reviewSave")}</span>}
          </div>
        </>)}
      </section>
    </div>)}
    {!complete && <footer className="resolverFooter">
      <div className="resolverFeedback">
        {action.error ? <div role="alert"><ErrorMessage error={action.error} /></div> : <span role="status">{action.message || (currentSession.loading ? t("cf.loadingTask") : currentFile.loading ? t("cf.loadingStages") : !currentFile.data ? t("cf.waiting") : hasUnsavedChanges ? t("cf.unsaved") : analysis.hasMarkers ? t("resolver.markersRemain") : t("resolver.reviewSave"))}</span>}
      </div>
      {isTextReview && currentFile.data && <div className="resolverControlGroup" role="group" aria-label={t("cf.actionsAria")}>
        {recoveredDraft && <Button disabled={busy} onClick={() => { dialogAppliedRef.current = false; setPendingApply({ label: selectedPath, title: t("resolver.discardRecovered"), description: t("resolver.discardRecoveredNote"), confirmLabel: t("resolver.discardRecovered"), apply: () => { setHasUnsavedChanges(false); setRecoveredDraft(false); setReload((value) => value + 1); } }); }}>{t("resolver.discardRecovered")}</Button>}
        <Button disabled={busy || !editorReady || !hasUnsavedChanges} onClick={() => void saveDraft()}>{t(action.busy === "save" ? "cf.saving2" : "cf.saveResult")}</Button>
        <Button variant="primary" disabled={busy || !editorReady || analysis.hasMarkers} title={analysis.hasMarkers ? t("resolver.markersRemain") : undefined} onClick={() => { if (hasUnsavedChanges) void saveDraft().then((saved) => saved && markResolved(saved)); else void markResolved(); }}>{t(action.busy === "resolve" ? "cf.marking" : hasUnsavedChanges ? "cf.saveAndMark" : "cf.markResolved")}</Button>
      </div>}
    </footer>}
    {pendingApply && <Dialog aria-labelledby="resolver-replace-title" onClose={() => setPendingApply(undefined)} returnFocus={() => resolverFocusTarget(dialogAppliedRef.current, ".resolverToolbar [aria-haspopup=menu]")}>
      <DialogHeader><h2 id="resolver-replace-title">{pendingApply.title ?? t("cf.replaceResult")}</h2></DialogHeader>
      <div className="resolverDialogBody"><strong>{selectedPath}</strong><p>{pendingApply.label}</p><p>{pendingApply.description ?? t("cf.confirmApply")}</p></div>
      <DialogFooter><Button data-dialog-initial-focus onClick={() => setPendingApply(undefined)}>{t("cf.keepEdits")}</Button><Button variant={pendingApply.confirmLabel ? "danger" : "primary"} onClick={() => { const apply = pendingApply.apply; dialogAppliedRef.current = true; setPendingApply(undefined); apply(); setFocusRequest((value) => value + 1); }}>{pendingApply.confirmLabel ?? t("cf.replaceResult")}</Button></DialogFooter>
    </Dialog>}
    {detailsOpen && selectedBlock && <Dialog aria-labelledby="resolver-detail-title" onClose={() => setDetailsOpen(false)} returnFocus={() => resolverFocusTarget(dialogAppliedRef.current, ".resolverDecisions [aria-expanded]")}>
      <DialogHeader><h2 id="resolver-detail-title">{t("cb.conflictN", { n: selectedBlock.index })}</h2></DialogHeader>
      <div className="resolverDialogBody">
        <p>{t(selectedSmart?.kind === "merged" ? "cb.nonOverlappingTitle" : "cb.overlappingTitle")}</p>
        {selectedSmart?.kind === "merged" && <><h3>{t("resolver.suggested")}</h3><pre>{selectedSmart.text}</pre><Button disabled={busy || selectedIgnored.ours || selectedIgnored.theirs || analysis.malformed} onClick={() => { resolveBlock(selectedBlock, selectedSmart.text); setDetailsOpen(false); }}>{t("cb.smartMerge")}</Button></>}
        <details><summary>{t("resolver.base")}</summary><pre>{baseForBlock(selectedBlock, regions) ?? t("resolver.baseUnavailable")}</pre></details>
        <p>{t(baseForBlock(selectedBlock, regions) === null ? "resolver.ignoreEmpty" : "cb.ignoreBoth")}</p>
        <div className="resolverControlGroup"><Button aria-pressed={Boolean(selectedIgnored.ours)} disabled={busy || analysis.malformed} onClick={() => { ignoreSide(selectedBlock, "ours"); if (selectedIgnored.theirs && !selectedIgnored.ours) setDetailsOpen(false); }}>{t("cb.ignoreOurs")}</Button><Button aria-pressed={Boolean(selectedIgnored.theirs)} disabled={busy || analysis.malformed} onClick={() => { ignoreSide(selectedBlock, "theirs"); if (selectedIgnored.ours && !selectedIgnored.theirs) setDetailsOpen(false); }}>{t("cb.ignoreTheirs")}</Button></div>
      </div>
    </Dialog>}
    {suggestionOpen && api && currentFile.data?.isText && <Dialog aria-label={t("cf.aiButton")} onClose={() => setSuggestionOpen(false)} returnFocus={() => resolverFocusTarget(dialogAppliedRef.current, ".resolverToolbar [aria-haspopup=menu]")}><ConflictSuggestionPanel key={`${currentFile.data.path}:${currentFile.data.resultRevision}`} api={api} file={currentFile.data} hasUnsavedChanges={hasUnsavedChanges} onUseSuggestion={applyAiMerge} onClose={() => setSuggestionOpen(false)} /></Dialog>}
  </main>;
}

function updateDraft(content: string, savedContent: string, setDraft: (content: string) => void, setHasUnsavedChanges: (dirty: boolean) => void) {
  setDraft(content);
  setHasUnsavedChanges(content !== savedContent);
}

function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function resolverFocusTarget(applied: boolean, trigger: string) {
  return (!applied ? document.querySelector<HTMLElement>(trigger) : null)
    ?? document.querySelector<HTMLElement>(".resolverResult textarea, .resolverComplete h2");
}
