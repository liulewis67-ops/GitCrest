import { useEffect, useMemo, useState } from "react";
import type {
  DiffDocumentResponse,
  GitCrestApiClient,
  ShelfApplyPreviewResponse,
  ShelfCreateRequest,
  ShelfDetailResponse,
  ShelfResponse,
  StatusSnapshotResponse,
} from "../../api/client";

type SelectedChange = { revision: string; hunks?: number[] };

export function ShelfCenter({
  api,
  repoId,
  headOid,
  files,
  disabled,
  refreshKey,
  openComposerRequest,
  onTaskSubmitted,
}: {
  api: GitCrestApiClient;
  repoId: string;
  headOid: string | null;
  files: StatusSnapshotResponse["files"];
  disabled: boolean;
  refreshKey: number;
  openComposerRequest: number;
  onTaskSubmitted: () => void;
}) {
  const [shelves, setShelves] = useState<ShelfResponse[]>([]);
  const [selectedShelfId, setSelectedShelfId] = useState<string>();
  const [detail, setDetail] = useState<ShelfDetailResponse>();
  const [applyPreview, setApplyPreview] = useState<ShelfApplyPreviewResponse>();
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskPending, setTaskPending] = useState(false);
  const [pendingTaskId, setPendingTaskId] = useState<string>();
  const [composerOpen, setComposerOpen] = useState(false);
  const [scope, setScope] = useState<"workingTree" | "index">("workingTree");
  const [selected, setSelected] = useState<Record<string, SelectedChange>>({});
  const [diffs, setDiffs] = useState<Record<string, DiffDocumentResponse>>({});
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState<ShelfResponse>();

  const availableFiles = useMemo(() => files.filter((file) => {
    if (file.categories.includes("conflicted") || file.categories.includes("ignored")) return false;
    return scope === "index"
      ? file.categories.includes("staged")
      : file.categories.includes("unstaged") || file.categories.includes("untracked");
  }), [files, scope]);

  async function refreshShelves() {
    try {
      const next = await api.listRepositoryShelves(repoId);
      setShelves(next);
      setLoadError("");
      if (selectedShelfId && !next.some((shelf) => shelf.shelfId === selectedShelfId)) {
        setSelectedShelfId(undefined);
        setDetail(undefined);
        setApplyPreview(undefined);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load saved shelves.");
    }
  }

  useEffect(() => {
    setShelves([]);
    setSelectedShelfId(undefined);
    setDetail(undefined);
    setApplyPreview(undefined);
    void refreshShelves();
  }, [api, repoId]);

  useEffect(() => {
    if (!taskPending || !pendingTaskId) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.listTasks().then(async (tasks) => {
        if (!active) return;
        const task = tasks.find((entry) => entry.taskId === pendingTaskId);
        if (!task || task.status === "queued" || task.status === "running") return;
        setTaskPending(false);
        setPendingTaskId(undefined);
        await refreshShelves();
        onTaskSubmitted();
      }).catch(() => undefined);
    }, 1200);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [api, onTaskSubmitted, pendingTaskId, repoId, taskPending]);

  useEffect(() => {
    if (refreshKey > 0) void refreshShelves();
  }, [refreshKey]);

  useEffect(() => {
    if (openComposerRequest > 0) {
      setComposerOpen(true);
      setLoadError("");
    }
  }, [openComposerRequest]);

  async function readDiff(path: string): Promise<DiffDocumentResponse | undefined> {
    const cached = diffs[path];
    if (cached) return cached;
    try {
      const response = await api.getFileDiff(repoId, path, scope);
      setDiffs((current) => ({ ...current, [path]: response }));
      return response;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : `Could not read ${path}.`);
      return undefined;
    }
  }

  async function toggleFile(path: string, checked: boolean) {
    setApplyPreview(undefined);
    if (!checked) {
      setSelected((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      return;
    }
    const diff = await readDiff(path);
    if (!diff || diff.status !== "text" || diff.hunks.length === 0) return;
    setSelected((current) => ({ ...current, [path]: { revision: diff.revision } }));
  }

  function setHunk(path: string, index: number, checked: boolean, diff: DiffDocumentResponse) {
    setSelected((current) => {
      const existing = current[path];
      if (!existing) return current;
      const selectedHunks = existing.hunks === undefined
        ? diff.hunks.map((_, hunkIndex) => hunkIndex)
        : existing.hunks;
      const nextHunks = checked
        ? [...new Set([...selectedHunks, index])].sort((a, b) => a - b)
        : selectedHunks.filter((hunkIndex) => hunkIndex !== index);
      return { ...current, [path]: { ...existing, hunks: nextHunks } };
    });
  }

  async function createShelf() {
    const items: ShelfCreateRequest["items"] = Object.entries(selected)
      .filter(([, change]) => change.hunks === undefined || change.hunks.length > 0)
      .map(([path, change]) => ({
        path,
        scope,
        revision: change.revision,
        selections: change.hunks?.map((hunkIndex) => ({ hunkIndex })) || [],
      }));
    if (!name.trim() || items.length === 0) {
      setLoadError("Enter a name and select at least one file or hunk.");
      return;
    }
    setBusy(true);
    setLoadError("");
    try {
      const task = await api.createRepositoryShelf(repoId, {
        name: name.trim(),
        description,
        expectedHeadOid: headOid,
        items,
      });
      setTaskPending(task.status === "queued" || task.status === "running");
      setPendingTaskId(task.taskId);
      setComposerOpen(false);
      setSelected({});
      setName("");
      setDescription("");
      onTaskSubmitted();
      await refreshShelves();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not create the shelf.");
    } finally {
      setBusy(false);
    }
  }

  async function selectShelf(shelf: ShelfResponse) {
    setSelectedShelfId(shelf.shelfId);
    setDetail(undefined);
    setApplyPreview(undefined);
    setLoadError("");
    try {
      setDetail(await api.getRepositoryShelf(repoId, shelf.shelfId));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not read the shelf patch.");
    }
  }

  async function previewApply() {
    if (!selectedShelfId) return;
    setBusy(true);
    setLoadError("");
    try {
      setApplyPreview(await api.preflightRepositoryShelfApply(repoId, selectedShelfId));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not preview this shelf.");
    } finally {
      setBusy(false);
    }
  }

  async function applyShelf() {
    if (!selectedShelfId || !applyPreview) return;
    setBusy(true);
    setLoadError("");
    try {
      const task = await api.applyRepositoryShelf(repoId, selectedShelfId, {
        expectedHeadOid: applyPreview.expectedHeadOid,
        previewRevision: applyPreview.previewRevision,
      });
      setTaskPending(task.status === "queued" || task.status === "running");
      setPendingTaskId(task.taskId);
      onTaskSubmitted();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not apply this shelf.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteShelf() {
    if (!deleteConfirm) return;
    setBusy(true);
    setLoadError("");
    try {
      await api.deleteRepositoryShelf(repoId, deleteConfirm.shelfId);
      if (selectedShelfId === deleteConfirm.shelfId) {
        setSelectedShelfId(undefined);
        setDetail(undefined);
        setApplyPreview(undefined);
      }
      setDeleteConfirm(undefined);
      await refreshShelves();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not delete this shelf.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shelfCenter">
      <div className="navGroupTitle"><span>Shelves</span><span className="countBadge">{shelves.length}</span></div>
      <button className="shelfCreateButton" type="button" disabled={disabled} onClick={() => { setComposerOpen(true); setLoadError(""); }}>
        <span aria-hidden="true">＋</span> Shelve selected changes
      </button>
      {loadError && <div className="shelfInlineError" role="alert">{loadError}</div>}
      {shelves.length === 0 && !loadError && <div className="navEmpty">No saved shelves</div>}
      {shelves.map((shelf) => (
        <div className={`shelfListItem${selectedShelfId === shelf.shelfId ? " active" : ""}`} key={shelf.shelfId}>
          <button className="shelfSelectButton" type="button" onClick={() => void selectShelf(shelf)}>
            <span className="shelfItemName" title={shelf.name}>{shelf.name}</span>
            <span className="shelfItemMeta">{shelf.paths.length} files · {shelf.scope || "scope unknown"}</span>
          </button>
          <button className="shelfDeleteButton" type="button" aria-label={`Review deletion of ${shelf.name}`} disabled={disabled || busy} onClick={() => setDeleteConfirm(shelf)}>×</button>
        </div>
      ))}

      {detail && selectedShelfId && <section className="shelfDetail" aria-label={`Shelf preview: ${detail.shelf.name}`}>
        <div className="shelfDetailHeading"><strong>{detail.shelf.name}</strong><button type="button" className="textButton" onClick={() => { setDetail(undefined); setApplyPreview(undefined); }}>Close</button></div>
        <p>{detail.shelf.description || "No description"}</p>
        <div className="shelfPathList">{detail.shelf.paths.map((path) => <code key={path}>{path}</code>)}</div>
        <pre className="shelfPatchPreview">{detail.patch}</pre>
        {applyPreview && <div className={`shelfApplyStatus${applyPreview.canApplyCleanly ? " ready" : " blocked"}`} role="status">
          {applyPreview.canApplyCleanly ? "Patch applies cleanly to the current working tree." : "Patch does not apply cleanly. The shelf is preserved."}
          <span>HEAD {applyPreview.expectedHeadOid?.slice(0, 10) || "(unborn)"}</span>
        </div>}
        <div className="shelfActions">
          <button className="secondaryButton" type="button" disabled={busy || disabled} onClick={() => void previewApply()}>{busy ? "Checking…" : "Preview apply"}</button>
          {applyPreview && <button className="primaryButton" type="button" disabled={busy || disabled || !applyPreview.canApplyCleanly} onClick={() => void applyShelf()}>{busy ? "Applying…" : "Apply reviewed shelf"}</button>}
        </div>
      </section>}

      {composerOpen && <div className="paletteBackdrop shelfBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setComposerOpen(false); }}>
        <section className="dialogCard shelfComposer" role="dialog" aria-modal="true" aria-labelledby="shelf-composer-title">
          <div className="dialogHeading"><div><span className="sectionEyebrow">WORKTREE · {repoId}</span><h2 id="shelf-composer-title">Shelve selected changes</h2></div><button className="dialogClose" type="button" aria-label="Close shelf composer" disabled={busy} onClick={() => setComposerOpen(false)}>×</button></div>
          <label className="shelfField">Name<input autoFocus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. API retry draft" /></label>
          <label className="shelfField">Description<textarea maxLength={500} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional note" /></label>
          <label className="shelfField">Change scope<select value={scope} onChange={(event) => { setScope(event.target.value as "workingTree" | "index"); setSelected({}); setDiffs({}); }}><option value="workingTree">Working tree</option><option value="index">Staged index</option></select></label>
          <div className="shelfFilePicker" aria-label="Select files or hunks to shelve">
            {availableFiles.length === 0 && <div className="navEmpty">No changed files in this scope</div>}
            {availableFiles.map((file) => {
              const chosen = selected[file.path];
              const diff = diffs[file.path];
              const selectedHunks = chosen?.hunks;
              return <div className="shelfFileChoice" key={file.path}>
                <label><input type="checkbox" checked={Boolean(chosen)} onChange={(event) => void toggleFile(file.path, event.target.checked)} /><span className="shelfFilePath">{file.path}</span><span className="shelfFileState">{file.kind}</span></label>
                {chosen && diff && <details className="shelfHunkPicker">
                  <summary>Whole file selected · {diff.hunks.length} hunks</summary>
                  <div className="shelfHunkActions"><button type="button" className="textButton" onClick={() => setSelected((current) => ({ ...current, [file.path]: { ...current[file.path], hunks: diff.hunks.map((_, index) => index) } }))}>Select all</button><button type="button" className="textButton" onClick={() => setSelected((current) => ({ ...current, [file.path]: { ...current[file.path], hunks: [] } }))}>Clear</button><button type="button" className="textButton" onClick={() => setSelected((current) => ({ ...current, [file.path]: { revision: diff.revision } }))}>Whole file</button></div>
                  {diff.hunks.map((hunk, index) => <label className="shelfHunkChoice" key={`${file.path}-${index}`}><input type="checkbox" checked={selectedHunks === undefined || selectedHunks.includes(index)} onChange={(event) => setHunk(file.path, index, event.target.checked, diff)} /><span>Hunk {index + 1}</span><code>-{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}</code></label>)}
                </details>}
              </div>;
            })}
          </div>
          {loadError && <div className="shelfInlineError" role="alert">{loadError}</div>}
          <div className="dialogActions"><button className="secondaryButton" type="button" disabled={busy} onClick={() => setComposerOpen(false)}>Cancel</button><button className="primaryButton" type="button" disabled={busy || disabled || Object.keys(selected).length === 0 || !name.trim()} onClick={() => void createShelf()}>{busy ? "Saving…" : "Create shelf"}</button></div>
        </section>
      </div>}

      {deleteConfirm && <div className="paletteBackdrop shelfBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteConfirm(undefined); }}>
        <section className="dialogCard shelfDeleteDialog" role="alertdialog" aria-modal="true" aria-labelledby="shelf-delete-title" aria-describedby="shelf-delete-description">
          <div className="dialogHeading"><div><span className="sectionEyebrow">PERMANENTLY REMOVE SAVED PATCH</span><h2 id="shelf-delete-title">Delete “{deleteConfirm.name}”?</h2></div></div>
          <p id="shelf-delete-description">This removes the saved shelf without changing repository files. It contains {deleteConfirm.paths.length} paths:</p>
          <div className="shelfPathList">{deleteConfirm.paths.map((path) => <code key={path}>{path}</code>)}</div>
          <div className="dialogActions"><button className="secondaryButton" type="button" disabled={busy} onClick={() => setDeleteConfirm(undefined)}>Keep shelf</button><button className="dangerButton" type="button" disabled={busy} onClick={() => void deleteShelf()}>{busy ? "Deleting…" : "Delete shelf"}</button></div>
        </section>
      </div>}
    </div>
  );
}
