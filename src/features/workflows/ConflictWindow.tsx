import { useEffect, useRef, useState } from "react";
import { GitCrestApiClient, type WorkflowConflictFileResponse, type WorkflowRecoveryPreflightResponse } from "../../api/client";
import "../../App.css";

type RequestState<T> = { key: string; loading: boolean; data?: T; error?: string };

export function ConflictWindow() {
  const params = new URLSearchParams(window.location.search);
  const repoId = params.get("repoId") || "";
  const taskId = params.get("taskId") || "";
  const [api, setApi] = useState<GitCrestApiClient>();
  const [session, setSession] = useState<RequestState<WorkflowRecoveryPreflightResponse>>({ key: "", loading: false });
  const [selectedPath, setSelectedPath] = useState("");
  const [file, setFile] = useState<RequestState<WorkflowConflictFileResponse>>({ key: "", loading: false });
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
      if (connection.windowAccess !== "readOnly") throw new Error("Conflict review requires restricted window access.");
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
    void api.getRepositoryWorkflowConflictFile(repoId, taskId, selectedPath).then((response) => {
      if (active && selectedPathRef.current === selectedPath) setFile({ key: fileKey, loading: false, data: response });
    }).catch((reason: unknown) => {
      if (active && selectedPathRef.current === selectedPath) setFile({ key: fileKey, loading: false, error: reason instanceof Error ? reason.message : "Could not load the conflict stages." });
    });
    return () => { active = false; };
  }, [api, repoId, taskId, selectedPath, fileKey]);

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
        {currentSession.data.conflictedPaths.map((path) => <button className={path === selectedPath ? "selected" : ""} type="button" key={path} aria-current={path === selectedPath ? "page" : undefined} onClick={() => setSelectedPath(path)} title={path}><span aria-hidden="true">U</span>{path}</button>)}
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
              <ConflictStage label="OURS" content={currentFile.data.oursContent} />
              <ConflictStage label="THEIRS" content={currentFile.data.theirsContent} />
            </div>
            <section className="conflictResultPreview" aria-label="Working result preview"><div><strong>WORKING RESULT</strong><small>Saved in the repository · {currentFile.data.resultRevision.slice(0, 12)}</small></div><pre>{currentFile.data.resultContent ?? "(file deleted in working result)"}</pre></section>
          </>}
        </>}
      </section>
    </div>}
  </main>;
}

function ConflictStage({ label, content }: { label: string; content: string | null }) {
  return <section className="conflictStage"><h2>{label}</h2><pre>{content ?? "(file absent in this stage)"}</pre></section>;
}
