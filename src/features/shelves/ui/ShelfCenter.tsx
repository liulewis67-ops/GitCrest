import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useState } from "react";
import type {
  DiffDocumentResponse,
  GitCrestApiClient,
  ShelfApplyPreviewResponse,
  ShelfCreateRequest,
  ShelfDetailResponse,
  ShelfResponse,
  TaskSnapshotResponse,
  StatusSnapshotResponse,
} from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import { StashList } from "./StashList";

type SelectedChange = { revision: string; hunks?: number[] };
type ShelfAfterCreateAction = { switchTarget: string; existingShelfIds: string[] };

export function ShelfCenter({
  api,
  repoId,
  headOid,
  files,
  statusReady,
  disabled,
  refreshKey,
  openComposerRequest,
  composerPreselect,
  afterCreateAction,
  onTaskSubmitted,
  onComposerClosed,
  onComposerRequestHandled,
  onOpenCommitFile,
}: {
  api: GitCrestApiClient;
  repoId: string;
  headOid: string | null;
  files: StatusSnapshotResponse["files"];
  statusReady: boolean;
  disabled: boolean;
  refreshKey: number;
  openComposerRequest: number;
  /** Files the opening request already chose, such as one shelved from the file tree's right-click menu. */
  composerPreselect?: { paths: string[]; scope: "workingTree" | "index" };
  afterCreateAction?: ShelfAfterCreateAction;
  onTaskSubmitted: (task?: TaskSnapshotResponse, afterCreate?: ShelfAfterCreateAction) => void;
  onComposerClosed?: () => void;
  /** Called once a request has opened the composer, so a later remount does not open it again. */
  onComposerRequestHandled?: () => void;
  /** Opens one file of a commit, such as a Git stash entry, in the read-only diff. */
  onOpenCommitFile?: (path: string, oid: string) => void;
}) {
  const { t } = useI18n();
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
  const closeComposer = () => {
    if (busy) return;
    setComposerOpen(false);
    onComposerClosed?.();
  };
  const { dialogRef: composerRef, onKeyDown: onComposerKeyDown } = useDialogFocus<HTMLElement>(closeComposer, busy, undefined, composerOpen);
  const { dialogRef: deleteRef, onKeyDown: onDeleteKeyDown } = useDialogFocus<HTMLElement>(() => setDeleteConfirm(undefined), busy, undefined, Boolean(deleteConfirm));

  const availableFiles = useMemo(() => files.filter((file) => {
    if (file.categories.includes("conflicted") || file.categories.includes("ignored")) return false;
    return scope === "index"
      ? file.categories.includes("staged")
      : file.categories.includes("unstaged") || file.categories.includes("untracked");
  }), [files, scope]);

  async function refreshShelves() {
    try {
      const next = await api.listRepositoryShelves(repoId);
      if (!Array.isArray(next)) throw new Error(t("sh.invalid"));
      setShelves(next);
      setLoadError("");
      if (selectedShelfId && !next.some((shelf) => shelf.shelfId === selectedShelfId)) {
        setSelectedShelfId(undefined);
        setDetail(undefined);
        setApplyPreview(undefined);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("sh.loadFailed"));
    }
  }

  useEffect(() => {
    setShelves([]);
    setSelectedShelfId(undefined);
    setDetail(undefined);
    setApplyPreview(undefined);
    if (statusReady) void refreshShelves();
  }, [api, repoId, statusReady]);

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
    if (refreshKey > 0 && statusReady) void refreshShelves();
  }, [refreshKey, statusReady]);

  useEffect(() => {
    if (openComposerRequest > 0) {
      setComposerOpen(true);
      setLoadError("");
      if (composerPreselect) void preselectFiles(composerPreselect.paths, composerPreselect.scope);
      onComposerRequestHandled?.();
    }
  }, [openComposerRequest]);

  async function preselectFiles(paths: string[], nextScope: "workingTree" | "index") {
    setScope(nextScope);
    setSelected({});
    setDiffs({});
    // A single file names the shelf after itself, so shelving it takes one more click.
    if (paths.length === 1) setName(paths[0].slice(paths[0].lastIndexOf("/") + 1));
    const loaded = await Promise.all(paths.map(async (path) => {
      try {
        return [path, await api.getFileDiff(repoId, path, nextScope)] as const;
      } catch (error) {
        setLoadError(error instanceof Error ? error.message : t("sh.readFailed", { path }));
        return undefined;
      }
    }));
    const usable = loaded.filter((entry): entry is readonly [string, DiffDocumentResponse] => Boolean(entry && entry[1].status === "text" && entry[1].hunks.length > 0));
    setDiffs(Object.fromEntries(usable));
    setSelected(Object.fromEntries(usable.map(([path, diff]) => [path, { revision: diff.revision }])));
  }

  async function readDiff(path: string): Promise<DiffDocumentResponse | undefined> {
    const cached = diffs[path];
    if (cached) return cached;
    try {
      const response = await api.getFileDiff(repoId, path, scope);
      setDiffs((current) => ({ ...current, [path]: response }));
      return response;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("sh.readFailed", { path }));
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
      setLoadError(t("sh.needNameFile"));
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
      onTaskSubmitted(task, afterCreateAction);
      await refreshShelves();
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("sh.createFailed"));
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
      setLoadError(error instanceof Error ? error.message : t("sh.patchFailed"));
    }
  }

  async function previewApply() {
    if (!selectedShelfId) return;
    setBusy(true);
    setLoadError("");
    try {
      setApplyPreview(await api.preflightRepositoryShelfApply(repoId, selectedShelfId));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t("sh.previewFailed"));
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
      setLoadError(error instanceof Error ? error.message : t("sh.applyFailed"));
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
      setLoadError(error instanceof Error ? error.message : t("sh.deleteFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shelfCenter">
      <div className="navGroupTitle"><span>{t("sh.title")}</span><span className="countBadge">{shelves.length}</span></div>
      <button className="shelfCreateButton" type="button" disabled={disabled} onClick={() => { setComposerOpen(true); setLoadError(""); }}>
        <span aria-hidden="true">＋</span> {t("sh.shelveSelected")}
      </button>
      {loadError && <div className="shelfInlineError" role="alert">{loadError}</div>}
      {shelves.length === 0 && !loadError && <div className="navEmpty">{t("sh.none")}</div>}
      {shelves.map((shelf) => (
        <div className={`shelfListItem${selectedShelfId === shelf.shelfId ? " active" : ""}`} key={shelf.shelfId}>
          <button className="shelfSelectButton" type="button" onClick={() => void selectShelf(shelf)}>
            <span className="shelfItemName" title={shelf.name}>{shelf.name}</span>
            <span className="shelfItemMeta">{t("sh.files", { count: shelf.paths.length, scope: shelf.scope || t("sh.scopeUnknown") })}</span>
          </button>
          <button className="shelfDeleteButton" type="button" aria-label={t("sh.reviewDeletion", { name: shelf.name })} disabled={disabled || busy} onClick={() => setDeleteConfirm(shelf)}>×</button>
        </div>
      ))}

      {onOpenCommitFile && <StashList api={api} repoId={repoId} refreshKey={refreshKey} onOpenFile={onOpenCommitFile} />}

      {detail && selectedShelfId && <section className="shelfDetail" aria-label={t("sh.previewAria", { name: detail.shelf.name })}>
        <div className="shelfDetailHeading"><strong>{detail.shelf.name}</strong><button type="button" className="textButton" onClick={() => { setDetail(undefined); setApplyPreview(undefined); }}>{t("sh.close")}</button></div>
        <p>{detail.shelf.description || t("sh.noDescription")}</p>
        <div className="shelfPathList">{detail.shelf.paths.map((path) => <code key={path}>{path}</code>)}</div>
        <pre className="shelfPatchPreview">{detail.patch}</pre>
        {applyPreview && <div className={`shelfApplyStatus${applyPreview.canApplyCleanly ? " ready" : " blocked"}`} role="status">
          {applyPreview.canApplyCleanly ? t("sh.cleanly") : applyPreview.canApplyWithConflicts ? t("sh.needsConflict") : t("sh.cannotApply")}
          <span>{t("sh.head", { oid: applyPreview.expectedHeadOid?.slice(0, 10) || t("sh.unborn") })}</span>
        </div>}
        <div className="shelfActions">
          <button className="secondaryButton" type="button" disabled={busy || disabled} onClick={() => void previewApply()}>{busy ? t("sh.checking") : t("sh.previewApply")}</button>
          {applyPreview && <button className="primaryButton" type="button" disabled={busy || disabled || (!applyPreview.canApplyCleanly && !applyPreview.canApplyWithConflicts)} onClick={() => void applyShelf()}>{busy ? t("sh.applying") : t("sh.applyReviewed")}</button>}
        </div>
      </section>}

      {composerOpen && <div className="paletteBackdrop shelfBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeComposer(); }}>
        <section ref={composerRef} className="dialogCard shelfComposer" role="dialog" aria-modal="true" aria-labelledby="shelf-composer-title" onKeyDown={onComposerKeyDown}>
          <div className="dialogHeading"><div><span className="sectionEyebrow">{t("sh.composerEyebrow", { repo: repoId })}</span><h2 id="shelf-composer-title">{t("sh.composerTitle")}</h2>{afterCreateAction && <p role="status">{t("sh.afterCreate", { target: afterCreateAction.switchTarget })}</p>}</div><button className="dialogClose" type="button" aria-label={t("sh.closeComposer")} disabled={busy} onClick={closeComposer}>×</button></div>
          <label className="shelfField">{t("sh.name")}<input autoFocus data-dialog-initial-focus maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder={t("sh.namePlaceholder")} /></label>
          <label className="shelfField">{t("sh.description")}<textarea maxLength={500} rows={2} value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("sh.descPlaceholder")} /></label>
          <label className="shelfField">{t("sh.scope")}<select value={scope} onChange={(event) => { setScope(event.target.value as "workingTree" | "index"); setSelected({}); setDiffs({}); }}><option value="workingTree">{t("sh.scopeWorking")}</option><option value="index">{t("sh.scopeIndex")}</option></select></label>
          <div className="shelfFilePicker" aria-label={t("sh.pickerAria")}>
            {availableFiles.length === 0 && <div className="navEmpty">{t("sh.noFiles")}</div>}
            {availableFiles.map((file) => {
              const chosen = selected[file.path];
              const diff = diffs[file.path];
              const selectedHunks = chosen?.hunks;
              return <div className="shelfFileChoice" key={file.path}>
                <label><input type="checkbox" checked={Boolean(chosen)} onChange={(event) => void toggleFile(file.path, event.target.checked)} /><span className="shelfFilePath">{file.path}</span><span className="shelfFileState">{file.kind}</span></label>
                {chosen && diff && <details className="shelfHunkPicker">
                  <summary>{t("sh.wholeFile", { count: diff.hunks.length })}</summary>
                  <div className="shelfHunkActions"><button type="button" className="textButton" onClick={() => setSelected((current) => ({ ...current, [file.path]: { ...current[file.path], hunks: diff.hunks.map((_, index) => index) } }))}>{t("sh.selectAll")}</button><button type="button" className="textButton" onClick={() => setSelected((current) => ({ ...current, [file.path]: { ...current[file.path], hunks: [] } }))}>{t("sh.clear")}</button><button type="button" className="textButton" onClick={() => setSelected((current) => ({ ...current, [file.path]: { revision: diff.revision } }))}>{t("sh.wholeFileBtn")}</button></div>
                  {diff.hunks.map((hunk, index) => <label className="shelfHunkChoice" key={`${file.path}-${index}`}><input type="checkbox" checked={selectedHunks === undefined || selectedHunks.includes(index)} onChange={(event) => setHunk(file.path, index, event.target.checked, diff)} /><span>{t("sh.hunk", { n: index + 1 })}</span><code>-{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}</code></label>)}
                </details>}
              </div>;
            })}
          </div>
          {loadError && <div className="shelfInlineError" role="alert">{loadError}</div>}
          <div className="dialogActions"><button className="secondaryButton" type="button" disabled={busy} onClick={closeComposer}>{t("sh.cancel")}</button><button className="primaryButton" type="button" disabled={busy || disabled || Object.keys(selected).length === 0 || !name.trim()} onClick={() => void createShelf()}>{busy ? t("sh.saving") : t("sh.create")}</button></div>
        </section>
      </div>}

      {deleteConfirm && <div className="paletteBackdrop shelfBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteConfirm(undefined); }}>
        <section ref={deleteRef} className="dialogCard shelfDeleteDialog" role="alertdialog" aria-modal="true" aria-labelledby="shelf-delete-title" aria-describedby="shelf-delete-description" onKeyDown={onDeleteKeyDown}>
          <div className="dialogHeading"><div><span className="sectionEyebrow">{t("sh.deleteEyebrow")}</span><h2 id="shelf-delete-title">{t("sh.deleteTitle", { name: deleteConfirm.name })}</h2></div></div>
          <p id="shelf-delete-description">{t("sh.deleteBody", { count: deleteConfirm.paths.length })}</p>
          <div className="shelfPathList">{deleteConfirm.paths.map((path) => <code key={path}>{path}</code>)}</div>
          <div className="dialogActions"><button className="secondaryButton" type="button" disabled={busy} data-dialog-initial-focus onClick={() => setDeleteConfirm(undefined)}>{t("sh.keep")}</button><button className="dangerButton" type="button" disabled={busy} onClick={() => void deleteShelf()}>{busy ? t("sh.deleting") : t("sh.delete")}</button></div>
        </section>
      </div>}
    </div>
  );
}
