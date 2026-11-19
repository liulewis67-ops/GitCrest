import { Icon as UiIcon } from "../../../shared/ui/Icon";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useState } from "react";
import type {
  DiffDocumentResponse,
  GitCrestApiClient,
  ShelfApplyPreviewResponse,
  ShelfCreateRequest,
  ShelfResponse,
  TaskSnapshotResponse,
  StatusSnapshotResponse,
} from "../../../api/client";
import { InlineHint } from "../../../shared/ui/InlineHint";
import { EmptyState } from "../../../shared/ui/EmptyState";

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
  selectedFilePath,
  onOpenFile,
  onCloseFile,
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
  selectedFilePath?: string;
  onOpenFile?: (path: string, shelfId: string) => void;
  onCloseFile?: () => void;
}) {
  const { t } = useI18n();
  const [shelves, setShelves] = useState<ShelfResponse[]>([]);
  const [selectedShelfId, setSelectedShelfId] = useState<string>();
  const [review, setApplyPreview] = useState<ShelfApplyPreviewResponse>();
  const [loadError, setLoadError] = useState<DisplayError>("");
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
  const detail = shelves.find((shelf) => shelf.shelfId === selectedShelfId);
  const applyPreview = review?.shelf.shelfId === selectedShelfId ? review : undefined;
  const closeComposer = () => {
    if (busy) return;
    setComposerOpen(false);
    onComposerClosed?.();
  };

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
    } catch (error) {
      setLoadError(describeApiError(error, t("sh.loadFailed")));
    }
  }

  useEffect(() => {
    setShelves([]);
    setSelectedShelfId(undefined);
    setApplyPreview(undefined);
    if (statusReady) void refreshShelves();
  }, [api, repoId, statusReady]);

  useEffect(() => {
    if (selectedShelfId && !detail) closeShelf();
  }, [selectedShelfId, detail]);

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
        setLoadError(describeApiError(error, t("sh.readFailed", { path })));
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
      setLoadError(describeApiError(error, t("sh.readFailed", { path })));
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
      setLoadError(describeApiError(error, t("sh.createFailed")));
    } finally {
      setBusy(false);
    }
  }

  function closeShelf() {
    setSelectedShelfId(undefined);
    setApplyPreview(undefined);
    onCloseFile?.();
  }

  async function previewApply() {
    if (!selectedShelfId) return;
    setBusy(true);
    setLoadError("");
    try {
      setApplyPreview(await api.preflightRepositoryShelfApply(repoId, selectedShelfId));
    } catch (error) {
      setLoadError(describeApiError(error, t("sh.previewFailed")));
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
      onTaskSubmitted(task);
    } catch (error) {
      setLoadError(describeApiError(error, t("sh.applyFailed")));
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
        closeShelf();
      }
      setDeleteConfirm(undefined);
      await refreshShelves();
    } catch (error) {
      setLoadError(describeApiError(error, t("sh.deleteFailed")));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="shelfCenter">
      <InlineHint id="shelves" title={t("hint.shelvesTitle")}>{t("hint.shelves")}</InlineHint>
      <div className="navGroupTitle"><span>{t("sh.title")}</span><span className="countBadge">{shelves.length}</span></div>
      <button className="shelfCreateButton" type="button" disabled={disabled} onClick={() => { setComposerOpen(true); setLoadError(""); }}>
        <span aria-hidden="true"><UiIcon name="plus" /></span> {t("sh.shelveSelected")}
      </button>
      {loadError && <div className="shelfInlineError" role="alert"><ErrorMessage error={loadError} /></div>}
      {shelves.length === 0 && !loadError && <EmptyState actionLabel={t("sh.emptyAction")} onAction={() => { setComposerOpen(true); setLoadError(""); }} actionDisabled={disabled} actionTitle={disabled ? t("sh.emptyDisabled") : undefined}>{t("sh.none")} {t("sh.emptyHint")}</EmptyState>}
      {shelves.map((shelf) => (
        <div className={`shelfListItem${selectedShelfId === shelf.shelfId ? " active" : ""}`} key={shelf.shelfId}>
          <button className="shelfSelectButton" type="button" aria-expanded={selectedShelfId === shelf.shelfId} onClick={() => {
            closeShelf();
            if (selectedShelfId !== shelf.shelfId) setSelectedShelfId(shelf.shelfId);
            setLoadError("");
          }}>
            <span className="shelfItemName" title={shelf.name}>{shelf.name}</span>
            <span className="shelfItemMeta">{t("sh.files", { count: shelf.paths.length, scope: shelf.scope || t("sh.scopeUnknown") })}</span>
          </button>
          <button className="shelfDeleteButton" type="button" aria-label={t("sh.reviewDeletion", { name: shelf.name })} disabled={disabled || busy} onClick={() => setDeleteConfirm(shelf)}><UiIcon name="close" /></button>
          {detail === shelf && <section className="shelfDetail" aria-label={t("sh.previewAria", { name: shelf.name })}>
            {shelf.description && <p>{shelf.description}</p>}
            <div className="shelfPathList">{shelf.paths.map((path) => <button
              key={path}
              className={`commitDetailFile${path === selectedFilePath ? " selected" : ""}`}
              type="button"
              aria-label={t("sh.openFileDiff", { path })}
              title={path}
              aria-pressed={path === selectedFilePath}
              onClick={() => onOpenFile?.(path, shelf.shelfId)}
            ><span title={path}>{path}</span></button>)}</div>
            {applyPreview && <div className={`shelfApplyStatus${applyPreview.canApplyCleanly ? " ready" : applyPreview.canApplyWithConflicts ? " review" : ""}`} role="status">
              {applyPreview.canApplyCleanly ? t("sh.cleanly") : applyPreview.canApplyWithConflicts ? t("sh.needsConflict") : t("sh.cannotApply")}
              <span>{t("sh.head", { oid: applyPreview.expectedHeadOid?.slice(0, 10) || t("sh.unborn") })}</span>
            </div>}
            <div className="shelfActions">
              <Button variant="secondary" type="button" disabled={busy || disabled} onClick={() => void previewApply()}>{busy ? t("sh.checking") : t("sh.previewApply")}</Button>
              {applyPreview && <Button variant="primary" type="button" disabled={busy || disabled || (!applyPreview.canApplyCleanly && !applyPreview.canApplyWithConflicts)} onClick={() => void applyShelf()}>{busy ? t("sh.applying") : t("sh.applyReviewed")}</Button>}
            </div>
          </section>}
        </div>
      ))}

      {composerOpen && <Dialog className="dialogCard shelfComposer" role="dialog" aria-labelledby="shelf-composer-title" onClose={closeComposer} busy={busy} closeLabel={t("sh.closeComposer")} backdropClassName="shelfBackdrop">
          <DialogHeader className="dialogHeading"><div><h2 id="shelf-composer-title">{t("sh.composerTitle")}</h2>{afterCreateAction && <p role="status">{t("sh.afterCreate", { target: afterCreateAction.switchTarget })}</p>}</div></DialogHeader>
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
                  <div className="shelfHunkActions"><Button type="button" variant="quiet" onClick={() => setSelected((current) => ({ ...current, [file.path]: { ...current[file.path], hunks: diff.hunks.map((_, index) => index) } }))}>{t("sh.selectAll")}</Button><Button type="button" variant="quiet" onClick={() => setSelected((current) => ({ ...current, [file.path]: { ...current[file.path], hunks: [] } }))}>{t("sh.clear")}</Button><Button type="button" variant="quiet" onClick={() => setSelected((current) => ({ ...current, [file.path]: { revision: diff.revision } }))}>{t("sh.wholeFileBtn")}</Button></div>
                  {diff.hunks.map((hunk, index) => <label className="shelfHunkChoice" key={`${file.path}-${index}`}><input type="checkbox" checked={selectedHunks === undefined || selectedHunks.includes(index)} onChange={(event) => setHunk(file.path, index, event.target.checked, diff)} /><span>{t("sh.hunk", { n: index + 1 })}</span><code>-{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines}</code></label>)}
                </details>}
              </div>;
            })}
          </div>
          {loadError && <div className="shelfInlineError" role="alert"><ErrorMessage error={loadError} /></div>}
          <DialogFooter className="dialogActions"><Button variant="secondary" type="button" disabled={busy} onClick={closeComposer}>{t("sh.cancel")}</Button><Button variant="primary" type="button" disabled={busy || disabled || Object.keys(selected).length === 0 || !name.trim()} onClick={() => void createShelf()}>{busy ? t("sh.saving") : t("sh.create")}</Button></DialogFooter>
        </Dialog>}

      {deleteConfirm && <Dialog className="dialogCard shelfDeleteDialog" role="alertdialog" aria-labelledby="shelf-delete-title" aria-describedby="shelf-delete-description" onClose={() => setDeleteConfirm(undefined)} busy={busy} backdropClassName="shelfBackdrop">
          <DialogHeader className="dialogHeading"><div><h2 id="shelf-delete-title">{t("sh.deleteTitle", { name: deleteConfirm.name })}</h2></div></DialogHeader>
          <p id="shelf-delete-description">{t("sh.deleteBody", { count: deleteConfirm.paths.length })}</p>
          <div className="shelfPathList">{deleteConfirm.paths.map((path) => <code key={path}>{path}</code>)}</div>
          <DialogFooter className="dialogActions"><Button variant="secondary" type="button" disabled={busy} data-dialog-initial-focus onClick={() => setDeleteConfirm(undefined)}>{t("sh.keep")}</Button><Button variant="danger" type="button" disabled={busy} onClick={() => void deleteShelf()}>{busy ? t("sh.deleting") : t("sh.delete")}</Button></DialogFooter>
        </Dialog>}
    </div>
  );
}
