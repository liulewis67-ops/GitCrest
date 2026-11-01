import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { useI18n } from "../../../shared/i18n";
import type { DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import { ResizeSeparator } from "../../../shared/ui/ResizeSeparator";
import { useRepositoryCommitDetail } from "../model/use-repository-commit-detail";
import { formatCommitDate } from "./format-commit-date";

function splitPath(path: string): { directory: string; name: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { directory: "", name: path } : { directory: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/**
 * What one commit changed: a header naming the commit, its file list, and the diff of the open file.
 * When the commit becomes selected, the file opened for the previous commit stays open if this
 * commit touches it too; otherwise the first file opens, so a single click shows a diff.
 */
export type CommitFileNavigation = { index: number; total: number; onPrevious: () => void; onNext: () => void };

export type CommitFilesSize = { width: number; min: number; max: number; label: string; onResize: (width: number) => void };

export function CommitChanges({ api, repoId, oid, openPath, openPathOid, filesHidden, filesSize, onOpenFile, onOpenDiffWindow, onReadError, actions, renderDiff }: {
  api: GitCrestApiClient;
  repoId: string;
  oid: string;
  /** File open in History, possibly from another commit. */
  openPath?: string;
  /** Commit that `openPath` belongs to. */
  openPathOid?: string;
  /** Focus mode keeps only the diff. */
  filesHidden?: boolean;
  /** Width of the file list, which a rule between it and the diff resizes. */
  filesSize?: CommitFilesSize;
  onOpenFile: (path: string, oid: string) => void;
  onOpenDiffWindow: (path: string, oid: string) => void;
  onReadError?: (error: DisplayError | undefined) => void;
  actions?: ReactNode;
  /** Draws the open file's diff; receives previous/next navigation through this commit's files. */
  renderDiff: (navigation?: CommitFileNavigation) => ReactNode;
}) {
  const { t } = useI18n();
  const state = useRepositoryCommitDetail(api, repoId, oid);
  const detail = state.oid === oid && !state.loading ? state.detail : undefined;
  const selectedPath = openPathOid === oid ? openPath : undefined;
  const errorReporter = useRef(onReadError);
  errorReporter.current = onReadError;
  useEffect(() => {
    if (state.oid === oid && !state.loading) errorReporter.current?.(state.error);
  }, [state.error, state.loading, state.oid, oid]);

  useEffect(() => {
    if (!detail || detail.oid !== oid || openPathOid === oid) return;
    const nextPath = detail.files.some((file) => file.path === openPath) ? openPath : detail.files[0]?.path;
    if (nextPath) onOpenFile(nextPath, oid);
  }, [detail, oid, openPath, openPathOid, onOpenFile]);

  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!detail) return;
    const target = event.key === "ArrowDown" ? index + 1
      : event.key === "ArrowUp" ? index - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? detail.files.length - 1 : -1;
    if (target < 0 || target >= detail.files.length) return;
    event.preventDefault();
    onOpenFile(detail.files[target].path, oid);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-commit-file-index="${target}"]`)?.focus());
  }

  const subject = detail?.message.split("\n")[0] ?? "";
  const selectedIndex = detail && selectedPath ? detail.files.findIndex((file) => file.path === selectedPath) : -1;
  const navigation = detail && selectedIndex >= 0 ? {
    index: selectedIndex,
    total: detail.files.length,
    onPrevious: () => { if (selectedIndex > 0) onOpenFile(detail.files[selectedIndex - 1].path, oid); },
    onNext: () => { if (selectedIndex < detail.files.length - 1) onOpenFile(detail.files[selectedIndex + 1].path, oid); },
  } : undefined;
  if (state.error && state.oid === oid) return (
    <section className="commitChanges" aria-label={t("hv.commitAria")}>
      <div className="viewEmpty" role="alert">
        <p><ErrorMessage error={state.error} /></p>
        <button className="secondaryButton" type="button" onClick={state.retry}>{t("hv.retryCommit")}</button>
      </div>
    </section>
  );
  return (
    <section className="commitChanges" aria-label={t("hv.commitAria")}>
      <header className="commitChangesHeader">
        <div className="commitChangesTitle">
          <h2 title={detail?.message}>{detail ? subject || t("push.noSubject") : t("hv.loadingCommit")}</h2>
          {detail && <p className="commitChangesMeta">
            <span className="monoText" title={detail.oid}>{detail.oid.slice(0, 8)}</span>
            <span>{detail.authorName}</span>
            <span>{formatCommitDate(detail.committedAtMs)}</span>
            <span className="commitChangesStats"><span className="added">+{detail.stats.insertions}</span> <span className="deleted">−{detail.stats.deletions}</span></span>
          </p>}
        </div>
        {actions && <div className="commitChangesActions">{actions}</div>}
      </header>
      <div
        className={`commitChangesBody${filesHidden ? " filesHidden" : ""}${filesSize && !filesHidden ? " resizable" : ""}`}
        style={filesSize ? { "--commit-files-width": `${filesSize.width}px` } as CSSProperties : undefined}
      >
        {!filesHidden && <nav className="commitFileList" aria-label={t("hv.files")}>
          <div className="sidebarSectionTitle"><span>{t("hv.files")}</span>{detail && <span className="countBadge">{detail.files.length}</span>}</div>
          {!detail ? <p className="sidebarNotice" role="status">{t("hv.loadingCommit")}</p>
              : detail.files.length === 0 ? <p className="sidebarNotice">{t("hv.noFiles")}</p>
                : <ul>{detail.files.map((file, index) => {
                  const { directory, name } = splitPath(file.path);
                  const selected = file.path === selectedPath;
                  return <li key={file.path} className="commitFileRow">
                    <button
                      className={`commitFileButton${selected ? " selected" : ""}`}
                      type="button"
                      data-commit-file-index={index}
                      aria-label={t("cd.openDiffFor", { path: file.path })}
                      aria-current={selected ? "true" : undefined}
                      tabIndex={selected || (!selectedPath && index === 0) ? 0 : -1}
                      title={file.path}
                      onClick={() => onOpenFile(file.path, oid)}
                      onKeyDown={(event) => moveSelection(event, index)}
                    >
                      <span className="commitFileName">{name}</span>
                      {directory && <span className="commitFileDirectory">{directory}</span>}
                      <small>{file.additions === null || file.deletions === null ? t("cd.binary") : <><span className="added">+{file.additions}</span> <span className="deleted">−{file.deletions}</span></>}</small>
                    </button>
                    <button className="commitFileWindow" type="button" aria-label={t("cd.openWindowFor", { path: file.path })} title={t("cd.openWindowTitle")} onClick={() => onOpenDiffWindow(file.path, oid)}>↗</button>
                  </li>;
                })}</ul>}
        </nav>}
        {!filesHidden && filesSize && <ResizeSeparator orientation="vertical" edge="left" value={filesSize.width} min={filesSize.min} max={filesSize.max} label={filesSize.label} onResize={filesSize.onResize} />}
        <div className="commitChangesDiff">{selectedPath ? renderDiff(navigation) : detail && detail.files.length === 0 ? <div className="viewEmpty"><p>{t("hv.noFiles")}</p></div> : <div className="diffSpecialState" role="status"><span className="loadingSpinner" aria-hidden="true" />{t("hv.loadingCommit")}</div>}</div>
      </div>
    </section>
  );
}
