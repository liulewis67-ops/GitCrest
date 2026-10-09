import { useEffect, useRef, useState } from "react";
import { GitCrestApiClient, type WorkflowConflictFileResponse, type WorkflowRecoveryPreflightResponse } from "../../../api/client";
import { getGitCrestBridge } from "../../../api/bridge";
import { ConflictSuggestionPanel } from "./ConflictSuggestionPanel";
import "../../../App.css";

type RequestState<T> = { key: string; loading: boolean; data?: T; error?: string };
type ActionState = { busy?: "save" | "resolve"; message?: string; error?: string };
type ConflictBlock = { index: number; start: number; end: number; ours: string; theirs: string };

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
    void api.withSignal(controller.signal).getRepositoryWorkflowConflictFile(repoId, taskId, selectedPath).then((response) => {
      if (!controller.signal.aborted && selectedPathRef.current === selectedPath) {
        setFile({ key: fileKey, loading: false, data: response });
        setDraft(response.resultContent ?? "");
      }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted && selectedPathRef.current === selectedPath) setFile({ key: fileKey, loading: false, error: reason instanceof Error ? reason.message : "Could not load the conflict stages." });
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
    setSession({ key: sessionKey, loading: false, data: preview });
    setSelectedPath((current) => preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || "");
    return preview;
  };

  const saveDraft = async () => {
    const currentFile = file.data;
    if (!api || !currentFile || !currentFile.isText || action.busy) return;
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
          return;
        }
      }
      throw new Error("The save task has not completed yet. Refresh this file before resolving it.");
    } catch (reason) {
      if (controller.signal.aborted) return;
      setAction({ error: reason instanceof Error ? reason.message : "Could not save the conflict result." });
      try { await refreshSession(controller.signal); } catch { /* Keep the reviewed content visible when refresh is unavailable. */ }
    } finally {
      if (actionControllerRef.current === controller) actionControllerRef.current = null;
    }
  };

  const markResolved = async () => {
    const currentFile = file.data;
    if (!api || !currentFile || !currentFile.isText || hasUnsavedChanges || action.busy) return;
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
  return <main className="conflictWindow" aria-label="Conflict resolution window">
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
            <div className="conflictStages">
              <ConflictStage label="BASE" content={currentFile.data.baseContent} />
              <ConflictStage label="OURS" content={currentFile.data.oursContent} onSelect={() => updateDraft(currentFile.data?.oursContent ?? "", currentFile.data?.resultContent ?? "", setDraft, setHasUnsavedChanges)} />
              <ConflictStage label="THEIRS" content={currentFile.data.theirsContent} onSelect={() => updateDraft(currentFile.data?.theirsContent ?? "", currentFile.data?.resultContent ?? "", setDraft, setHasUnsavedChanges)} />
            </div>
            {conflictBlocks.length > 0 && <section className="conflictBlockList" aria-label="Conflict blocks">
              <h2>Resolve each conflict block</h2>
              {conflictBlocks.map((block) => <article key={`${block.start}:${block.end}`}>
                <header><strong>Conflict {block.index}</strong><span>Choose a side or edit the working result below.</span></header>
                <div className="conflictBlockChoices">
                  <div><h3>OURS</h3><pre>{block.ours || "(empty side)"}</pre><button type="button" disabled={Boolean(action.busy)} onClick={() => updateDraft(replaceConflictBlock(draft, block, "ours"), currentFile.data?.resultContent ?? "", setDraft, setHasUnsavedChanges)}>Use ours for conflict {block.index}</button></div>
                  <div><h3>THEIRS</h3><pre>{block.theirs || "(empty side)"}</pre><button type="button" disabled={Boolean(action.busy)} onClick={() => updateDraft(replaceConflictBlock(draft, block, "theirs"), currentFile.data?.resultContent ?? "", setDraft, setHasUnsavedChanges)}>Use theirs for conflict {block.index}</button></div>
                </div>
              </article>)}
            </section>}
            <details className="conflictResultPreview">
              <summary>RESULT PREVIEW</summary>
              <pre>{draft || "(empty working result)"}</pre>
            </details>
            <section className="conflictResultEditor" aria-label="Working result editor">
              <div><label htmlFor="conflict-result">EDIT WORKING RESULT</label><small>Edits remain local until saved · {currentFile.data.resultRevision.slice(0, 12)}</small></div>
              <textarea id="conflict-result" aria-label="Working result" spellCheck={false} value={draft} disabled={Boolean(action.busy)} onChange={(event) => updateDraft(event.currentTarget.value, currentFile.data?.resultContent ?? "", setDraft, setHasUnsavedChanges)} />
              <footer>
                <div className="conflictResultActions" role="group" aria-label="Conflict result actions">
                  <button type="button" onClick={() => void saveDraft()} disabled={Boolean(action.busy) || !hasUnsavedChanges}>{action.busy === "save" ? "Saving…" : "Save result"}</button>
                  <button type="button" onClick={() => void markResolved()} disabled={Boolean(action.busy) || hasUnsavedChanges}>{action.busy === "resolve" ? "Marking…" : "Mark resolved"}</button>
                </div>
                {hasUnsavedChanges && <span>Unsaved edits</span>}
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

function ConflictStage({ label, content, onSelect }: { label: string; content: string | null; onSelect?: () => void }) {
  return <section className="conflictStage"><div><h2>{label}</h2>{onSelect && <button type="button" onClick={onSelect}>Use entire {label.toLowerCase()}</button>}</div><pre>{content ?? "(file absent in this stage)"}</pre></section>;
}

function findConflictBlocks(content: string): ConflictBlock[] {
  const lines: { text: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const match of content.matchAll(/\r?\n/g)) {
    const end = (match.index ?? 0) + match[0].length;
    lines.push({ text: content.slice(offset, end), start: offset, end });
    offset = end;
  }
  if (offset < content.length) lines.push({ text: content.slice(offset), start: offset, end: content.length });

  const blocks: ConflictBlock[] = [];
  for (let startIndex = 0; startIndex < lines.length; startIndex += 1) {
    if (!isConflictStart(lines[startIndex].text)) continue;
    let separatorIndex = -1;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (isConflictStart(lines[index].text)) break;
      if (lines[index].text.replace(/\r?\n$/, "") === "=======") {
        separatorIndex = index;
        break;
      }
    }
    if (separatorIndex < 0) continue;
    let endIndex = -1;
    for (let index = separatorIndex + 1; index < lines.length; index += 1) {
      if (isConflictStart(lines[index].text)) break;
      if (isConflictEnd(lines[index].text)) {
        endIndex = index;
        break;
      }
    }
    if (endIndex < 0) continue;
    const baseIndex = lines.findIndex((line, index) => index > startIndex && index < separatorIndex && isConflictBase(line.text));
    const oursEnd = baseIndex >= 0 ? baseIndex : separatorIndex;
    blocks.push({
      index: blocks.length + 1,
      start: lines[startIndex].start,
      end: lines[endIndex].end,
      ours: content.slice(lines[startIndex].end, lines[oursEnd].start),
      theirs: content.slice(lines[separatorIndex].end, lines[endIndex].start),
    });
    startIndex = endIndex;
  }
  return blocks;
}

function isConflictStart(line: string) {
  return /^<{7}(?: .*)?$/.test(line.replace(/\r?\n$/, ""));
}

function isConflictEnd(line: string) {
  return /^>{7}(?: .*)?$/.test(line.replace(/\r?\n$/, ""));
}

function isConflictBase(line: string) {
  return /^\|{7}(?: .*)?$/.test(line.replace(/\r?\n$/, ""));
}

function replaceConflictBlock(content: string, block: ConflictBlock, side: "ours" | "theirs") {
  return content.slice(0, block.start) + block[side] + content.slice(block.end);
}
