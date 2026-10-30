import { useEffect, useRef, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TagEntryResponse, type TaskSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { MenuButton } from "../../../shared/ui/MenuButton";
import { EmptyState } from "../../../shared/ui/EmptyState";
import { TagActionsDialog, type TagAction } from "./TagActionsDialog";

const PAGE_SIZE = 100;
const FILTER_DELAY_MS = 250;

/**
 * The repository tags, newest version first, a page at a time so a repository with thousands of tags
 * costs nothing until the section is used. Selecting a tag selects the commit it points at.
 */
export function TagList({ api, repoId, refreshKey, selectedOid, remoteNames = [], disabled = false, onSelectCommit, onCreateTag, onTaskStarted }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  selectedOid?: string;
  /** Remotes a tag can be pushed to or deleted from. */
  remoteNames?: readonly string[];
  /** Git operations cannot start now, so tag changes are unavailable. */
  disabled?: boolean;
  onSelectCommit: (oid: string) => void;
  /** Starts a tag on the selected commit or HEAD; the empty list offers it as its next step. */
  onCreateTag?: () => void;
  /** A push or remote delete started as a background task. */
  onTaskStarted?: (task: TaskSnapshotResponse) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [tags, setTags] = useState<TagEntryResponse[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const requestRef = useRef(0);
  const [action, setAction] = useState<{ kind: TagAction; tag: TagEntryResponse }>();

  useEffect(() => {
    const timer = window.setTimeout(() => setFilter(query.trim()), FILTER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api.withSignal(controller.signal).getRepositoryTags(repoId, { limit: PAGE_SIZE, filter: filter || undefined })
      .then((page) => {
        if (request !== requestRef.current) return;
        if (!Array.isArray(page.tags)) throw new Error(t("tags.loadFailed"));
        setTags(page.tags);
        setNextOffset(page.nextOffset);
        setLoaded(true);
      })
      .catch((reason) => {
        if (controller.signal.aborted || request !== requestRef.current) return;
        setError(reason instanceof GitCrestApiError ? reason.body.error.message : t("tags.loadFailed"));
      })
      .finally(() => {
        if (request === requestRef.current) setLoading(false);
      });
    return () => controller.abort();
  }, [api, repoId, refreshKey, filter, attempt]);

  async function loadMore() {
    if (nextOffset === null || loading) return;
    const request = requestRef.current;
    setLoading(true);
    try {
      const page = await api.getRepositoryTags(repoId, { offset: nextOffset, limit: PAGE_SIZE, filter: filter || undefined });
      if (request !== requestRef.current) return;
      setTags((current) => [...current, ...page.tags]);
      setNextOffset(page.nextOffset);
    } catch (reason) {
      if (request === requestRef.current) setError(reason instanceof GitCrestApiError ? reason.body.error.message : t("tags.loadFailed"));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }

  const empty = loaded && !error && tags.length === 0;
  return <section className="tagList" aria-label={t("tags.title")}>
    <div className="tagListHeader"><span>{t("tags.title")}</span>{loaded && !filter && <span className="countBadge">{tags.length}{nextOffset !== null ? "+" : ""}</span>}</div>
    {(loaded && (tags.length > 0 || filter)) && <div className="sidePanelFilter">
      <input type="search" aria-label={t("tags.filter")} placeholder={t("tags.filterPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
    </div>}
    {loading && !loaded && <p className="sidebarNotice" role="status">{t("tags.loading")}</p>}
    {error && <div className="statusLoadError" role="alert"><span>{error}</span><button type="button" onClick={() => setAttempt((value) => value + 1)}>{t("tags.retry")}</button></div>}
    {empty && (filter
      ? <p className="sidebarNotice">{t("tags.noMatch", { query: filter })}</p>
      : <EmptyState actionLabel={t("tags.createFirst")} onAction={onCreateTag} actionDisabled={disabled} actionTitle={disabled ? t("tags.busyTitle") : undefined}>{t("tags.none")}</EmptyState>)}
    {tags.length > 0 && <ul className="branchList" aria-label={t("tags.title")}>
      {tags.map((tag) => <li className="tagListRow" key={tag.name}>
        <button className={`tagListItem${tag.annotated ? " annotated" : ""}${selectedOid === tag.targetOid ? " selected" : ""}`} type="button" aria-label={t("tags.showCommit", { oid: tag.targetOid.slice(0, 8), name: tag.name })} aria-pressed={selectedOid === tag.targetOid} title={tag.message ?? tag.name} onClick={() => onSelectCommit(tag.targetOid)}>
          <span className="tagKind" aria-hidden="true">{tag.annotated ? "◆" : "◇"}</span>
          <span className="tagName">{tag.name}</span>
          <small className="tagKind">{tag.annotated ? t("tags.annotated") : t("tags.lightweight")}</small>
        </button>
        <MenuButton
          className="quietButton compact iconButton"
          label={t("tags.actionsFor", { name: tag.name })}
          title={t("tags.actions")}
          menuLabel={t("tags.actionsFor", { name: tag.name })}
          disabled={disabled}
          items={[
            { id: "push", label: t("tags.push"), disabled: remoteNames.length === 0, title: remoteNames.length === 0 ? t("tags.noRemotes") : undefined, onSelect: () => setAction({ kind: "push", tag }) },
            { id: "delete", label: t("tags.delete"), separatorBefore: true, danger: true, onSelect: () => setAction({ kind: "delete", tag }) },
            { id: "remoteDelete", label: t("tags.deleteRemote"), danger: true, disabled: remoteNames.length === 0, title: remoteNames.length === 0 ? t("tags.noRemotes") : undefined, onSelect: () => setAction({ kind: "remoteDelete", tag }) },
          ]}
        ><span aria-hidden="true">⋯</span></MenuButton>
      </li>)}
    </ul>}
    {nextOffset !== null && <button className="quietButton compact" type="button" disabled={loading} onClick={() => void loadMore()}>{t("tags.loadMore")}</button>}
    {action && <TagActionsDialog
      api={api}
      repoId={repoId}
      action={action.kind}
      tag={action.tag}
      remoteNames={remoteNames}
      onClose={() => setAction(undefined)}
      onDeleted={() => { setAction(undefined); setAttempt((value) => value + 1); }}
      onTaskStarted={(task) => { setAction(undefined); onTaskStarted?.(task); }}
    />}
  </section>;
}
