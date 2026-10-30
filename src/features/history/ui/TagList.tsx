import { useEffect, useRef, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TagEntryResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

const PAGE_SIZE = 100;
const FILTER_DELAY_MS = 250;

/**
 * The repository tags, newest version first, a page at a time so a repository with thousands of tags
 * costs nothing until the section is used. Selecting a tag selects the commit it points at.
 */
export function TagList({ api, repoId, refreshKey, selectedOid, onSelectCommit }: {
  api: GitCrestApiClient;
  repoId: string;
  refreshKey: number;
  selectedOid?: string;
  onSelectCommit: (oid: string) => void;
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
    {empty && <p className="sidebarNotice">{filter ? t("tags.noMatch", { query: filter }) : t("tags.none")}</p>}
    {tags.length > 0 && <ul className="branchList" aria-label={t("tags.title")}>
      {tags.map((tag) => <li key={tag.name}>
        <button className={`tagListItem${tag.annotated ? " annotated" : ""}${selectedOid === tag.targetOid ? " selected" : ""}`} type="button" aria-label={t("tags.showCommit", { oid: tag.targetOid.slice(0, 8), name: tag.name })} aria-pressed={selectedOid === tag.targetOid} title={tag.message ?? tag.name} onClick={() => onSelectCommit(tag.targetOid)}>
          <span className="tagKind" aria-hidden="true">{tag.annotated ? "◆" : "◇"}</span>
          <span className="tagName">{tag.name}</span>
          <small className="tagKind">{tag.annotated ? t("tags.annotated") : t("tags.lightweight")}</small>
        </button>
      </li>)}
    </ul>}
    {nextOffset !== null && <button className="quietButton compact" type="button" disabled={loading} onClick={() => void loadMore()}>{t("tags.loadMore")}</button>}
  </section>;
}
