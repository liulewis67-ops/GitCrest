import { useEffect, useRef, useState } from "react";
import { GitCrestApiClient, type WorkflowConflictFileResponse, type WorkflowRecoveryPreflightResponse } from "../../api/client";
import "../../App.css";

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
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;
  const sessionKey = `${repoId}:${taskId}`;
  const fileKey = `${sessionKey}:${selectedPath}`;

  useEffect(() => {
    let active = true;
    if (!repoId || !/^repo_[a-f0-9]{64}$/.test(repoId) || !taskId) {
      setSession({ key: sessionKey, loading: false, error: "This conflict window request is invalid. Reopen it from Task Center." });
      return () => { active = false; };
    }
    setSession({ key: sessionKey, loading: true });
    void window.gitcrest.getSidecarConnection().then(async (connection) => {
      if (connection.windowAccess !== "conflictResolution") throw new Error("Conflict review requires its restricted write capability.");
      const client = new GitCrestApiClient(connection.baseUrl, connection.token);
      const preview = await client.preflightRepositoryWorkflowRecovery(repoId, taskId);
      if (!active) return;
      setApi(client);
      setSession({ key: sessionKey, loading: false, data: preview });
      setSelectedPath((current) => preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || "");
    }).catch((reason: unknown) => {
      if (active) setSession({ key: sessionKey, loading: false, error: reason instanceof Error ? reason.message : "Could not load the conflict task." });
    });
    return () => { active = false; };
  }, [repoId, taskId, sessionKey]);

  useEffect(() => {
    let active = true;
    if (!api || !selectedPath) {
      setFile({ key: fileKey, loading: false });
      return () => { active = false; };
    }
    setFile({ key: fileKey, loading: true });
    setAction({});
    setHasUnsavedChanges(false);
    void api.getRepositoryWorkflowConflictFile(repoId, taskId, selectedPath).then((response) => {
      if (active && selectedPathRef.current === selectedPath) {
        setFile({ key: fileKey, loading: false, data: response });
        setDraft(response.resultContent ?? "");
      }
    }).catch((reason: unknown) => {
      if (active && selectedPathRef.current === selectedPath) setFile({ key: fileKey, loading: false, error: reason instanceof Error ? reason.message : "Could not load the conflict stages." });
    });
    return () => { active = false; };
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

  const refreshSession = async () => {
    if (!api) return undefined;
    const preview = await api.preflightRepositoryWorkflowRecovery(repoId, taskId);
    setSession({ key: sessionKey, loading: false, data: preview });
    setSelectedPath((current) => preview.conflictedPaths.includes(current) ? current : preview.conflictedPaths[0] || "");
    return preview;
  };

  const saveDraft = async () => {
    const currentFile = file.data;
    if (!api || !currentFile || !currentFile.isText || action.busy) return;
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
        await delay(TASK_POLL_INTERVAL_MS);
        const refreshed = await api.getRepositoryWorkflowConflictFile(repoId, taskId, currentFile.path);
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
      setAction({ error: reason instanceof Error ? reason.message : "Could not save the conflict result." });
      try { await refreshSession(); } catch { /* Keep the reviewed content visible when refresh is unavailable. */ }
    }
  };

  const markResolved = async () => {
    const currentFile = file.data;
    if (!api || !currentFile || !currentFile.isText || hasUnsavedChanges || action.busy) return;
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
        await delay(TASK_POLL_INTERVAL_MS);
        const preview = await api.preflightRepositoryWorkflowRecovery(repoId, taskId);
        if (!preview.conflictedPaths.includes(currentFile.path)) {
          setSession({ key: sessionKey, loading: false, data: preview });
          setSelectedPath((current) => current === currentFile.path ? preview.conflictedPaths[0] || "" : current);
          setAction({ message: "Resolved and staged this file. Return to Task Center to continue the Git operation." });
          return;
        }
      }
      throw new Error("The resolve task has not completed yet. Refresh the conflict list before continuing.");
    } catch (reason) {
      setAction({ error: reason instanceof Error ? reason.message : "Could not mark this conflict resolved." });
      try { await refreshSession(); } catch { /* Keep the reviewed content visible when refresh is unavailable. */ }
    }
  };

  const currentSession = session.key === sessionKey ? session : { key: sessionKey, loading: true };
  const currentFile = file.key === fileKey ? file : { key: fileKey, loading: Boolean(selectedPath) };
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
            <section className="conflictResultEditor" aria-label="Working result editor">
              <div><label htmlFor="conflict-result">WORKING RESULT</label><small>Edits remain local until saved · {currentFile.data.resultRevision.slice(0, 12)}</small></div>
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
      </section>
    </div>}
  </main>;
}

function updateDraft(content: string, savedContent: string, setDraft: (content: string) => void, setHasUnsavedChanges: (dirty: boolean) => void) {
  setDraft(content);
  setHasUnsavedChanges(content !== savedContent);
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function ConflictStage({ label, content, onSelect }: { label: string; content: string | null; onSelect?: () => void }) {
  return <section className="conflictStage"><div><h2>{label}</h2>{onSelect && <button type="button" onClick={onSelect}>Use {label.toLowerCase()}</button>}</div><pre>{content ?? "(file absent in this stage)"}</pre></section>;
}
