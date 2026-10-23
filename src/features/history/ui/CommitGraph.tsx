import { useI18n } from "../../../shared/i18n";
import { GRAPH_ROW_HEIGHT, useAppearance } from "../../settings";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, UIEvent } from "react";
import type { GitCrestApiClient } from "../../../api/client";
import type { components } from "../../../api/schema";
import { useHistoryFilters } from "../model/use-history-filters";
import { useRepositoryHistory } from "../model/use-repository-history";
import { formatCommitDate } from "./format-commit-date";

const OVERSCAN = 8;
const LANE_COLORS = 6;

/** The class that gives a lane its color when Settings → Appearance colors graph lanes. */
function laneClass(lane: number) {
  return `graphLane${(lane % LANE_COLORS) + 1}`;
}
type CommitSummary = components["schemas"]["CommitSummary"];

type CommitGraphProps = {
  api: GitCrestApiClient;
  repoId: string;
  selectedOid?: string;
  initialScrollTop: number;
  refreshKey?: number;
  focusSearchRequest?: { repoId: string; sequence: number };
  searchShortcut?: string;
  onFocusSearchHandled?: (sequence: number) => void;
  /** Narrows the graph to one file's commits, as "Show History" on a changed file asks. */
  pathFilterRequest?: { repoId: string; path: string; sequence: number };
  onPathFilterHandled?: (sequence: number) => void;
  onScrollPosition: (scrollTop: number) => void;
  onSelect: (oid: string) => void;
};

const NO_REFS: string[] = [];

const CommitGraphEntry = memo(function CommitGraphEntry({
  commit,
  index,
  lane,
  refNames,
  selected,
  tabIndex,
  onSelect,
  onMoveFocus,
}: {
  commit: CommitSummary;
  index: number;
  lane: number;
  refNames: string[];
  selected: boolean;
  tabIndex: 0 | -1;
  onSelect: (oid: string) => void;
  onMoveFocus: (event: KeyboardEvent<HTMLButtonElement>, index: number) => void;
}) {
  const { t } = useI18n();
  return <button className={`commitGraphEntry${selected ? " selected" : ""}`} type="button" data-commit-index={index} data-commit-oid={commit.oid} style={{ paddingLeft: lane * 20 + 42 }} aria-current={selected ? "true" : undefined} aria-label={`${commit.subject}, ${commit.authorName}, ${formatCommitDate(commit.committedAtMs)}, ${commit.oid.slice(0, 12)}${refNames.length ? `, ${refNames.join(", ")}` : ""}`} tabIndex={tabIndex} onClick={() => onSelect(commit.oid)} onKeyDown={(event) => onMoveFocus(event, index)}>
    <span className={`commitGraphNode ${laneClass(lane)}${commit.parents.length > 1 ? " merge" : ""}`} style={{ left: lane * 20 + 16 }} aria-hidden="true" />
    <span className="commitGraphText"><span className="commitGraphSubject">{commit.subject || t("push.noSubject")}</span><span className="commitGraphMeta">{commit.authorName} · {formatCommitDate(commit.committedAtMs)}</span></span>
    <span className="commitGraphOid">{commit.oid.slice(0, 8)}</span>
    {refNames.length > 0 && <span className="commitGraphRefs" title={refNames.join(", ")}>{refNames.map((name) => <span className="commitRefBadge" key={name}>{name}</span>)}{refNames.length > 1 && <span className="commitRefMore" aria-hidden="true">+{refNames.length - 1}</span>}</span>}
  </button>;
});

export function CommitGraph({ api, repoId, selectedOid, initialScrollTop, refreshKey = 0, focusSearchRequest, searchShortcut, onFocusSearchHandled, pathFilterRequest, onPathFilterHandled, onScrollPosition, onSelect }: CommitGraphProps) {
  const { t } = useI18n();
  const rowHeight = GRAPH_ROW_HEIGHT[useAppearance().style.density];
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageSearchRef = useRef<HTMLInputElement>(null);
  const { draftFilters, filters, hasFilters, setDraftFilter, applyFilters, showPath, resetFilters } = useHistoryFilters();
  // Message search covers most lookups; the other filters stay folded until asked for or in use.
  const advancedFilterCount = ((["sha", "author", "branch", "path", "since", "until"] as const)).filter((key) => Boolean(filters[key])).length;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const showAdvancedFilters = filtersOpen;
  const [viewport, setViewport] = useState({ top: 0, height: 520 });
  const renderedWindowRef = useRef({ first: 0, height: 520 });
  const restoredRepo = useRef<string>();
  const { commits, refs, loading, loadingMore, searchPending, error, refsError, loadMore, retry } = useRepositoryHistory(api, repoId, filters, refreshKey);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || loading || restoredRepo.current === repoId) return;
    node.scrollTop = initialScrollTop;
    restoredRepo.current = repoId;
    const height = node.clientHeight || 520;
    const first = Math.max(0, Math.floor(node.scrollTop / rowHeight) - OVERSCAN);
    renderedWindowRef.current = { first, height };
    setViewport({ top: node.scrollTop, height });
  }, [initialScrollTop, loading, repoId, rowHeight]);

  useEffect(() => {
    if (focusSearchRequest?.repoId !== repoId) return;
    messageSearchRef.current?.focus();
    onFocusSearchHandled?.(focusSearchRequest.sequence);
  }, [focusSearchRequest, onFocusSearchHandled, repoId]);

  // The path filter sits with the other folded filters, so they open to show why the list is shorter.
  useEffect(() => {
    if (pathFilterRequest?.repoId !== repoId) return;
    showPath(pathFilterRequest.path);
    setFiltersOpen(true);
    onPathFilterHandled?.(pathFilterRequest.sequence);
  }, [pathFilterRequest, onPathFilterHandled, repoId]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    const persistScrollPosition = () => onScrollPosition(node.scrollTop);
    node.addEventListener("scrollend", persistScrollPosition);
    return () => node.removeEventListener("scrollend", persistScrollPosition);
  }, [onScrollPosition]);

  const laneLayout = useMemo(() => {
    const laneByOid = new Map<string, number>();
    const indexByOid = new Map(commits.map((commit, index) => [commit.oid, index]));
    const edgesByFrom: { to: number; fromLane: number; toLane: number; merge: boolean }[][] = Array.from({ length: commits.length }, () => []);
    let nextLane = 0;
    commits.forEach((commit, index) => {
      let lane = laneByOid.get(commit.oid);
      if (lane === undefined) lane = nextLane++;
      laneByOid.set(commit.oid, lane);
      commit.parents.forEach((parent, parentIndex) => {
        let parentLane = laneByOid.get(parent);
        if (parentLane === undefined) {
          parentLane = parentIndex === 0 ? lane : nextLane++;
          laneByOid.set(parent, parentLane);
        }
        const targetIndex = indexByOid.get(parent);
        edgesByFrom[index].push({ to: targetIndex ?? index + 1, fromLane: lane, toLane: parentLane, merge: parentIndex > 0 });
      });
    });
    return { laneByOid, edgesByFrom, maxLane: Math.max(0, nextLane - 1) };
  }, [commits]);
  const refNamesByOid = useMemo(() => {
    const namesByOid = new Map<string, string[]>();
    for (const ref of refs) {
      const names = namesByOid.get(ref.oid) || [];
      names.push(ref.name);
      namesByOid.set(ref.oid, names);
    }
    return namesByOid;
  }, [refs]);

  const firstVisible = Math.max(0, Math.floor(viewport.top / rowHeight) - OVERSCAN);
  const visibleCount = Math.ceil(viewport.height / rowHeight) + OVERSCAN * 2;
  const lastVisible = Math.min(commits.length, firstVisible + visibleCount);
  const visibleCommits = commits.slice(firstVisible, lastVisible);
  const graphHeight = commits.length * rowHeight;
  const graphWidth = Math.max(112, laneLayout.maxLane * 20 + 44);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const top = node.scrollTop;
    const height = node.clientHeight || 520;
    const first = Math.max(0, Math.floor(top / rowHeight) - OVERSCAN);
    if (first !== renderedWindowRef.current.first || height !== renderedWindowRef.current.height) {
      renderedWindowRef.current = { first, height };
      setViewport({ top, height });
    }
    if (!loadingMore && node.scrollHeight - node.scrollTop - node.clientHeight < rowHeight * 10) {
      loadMore();
    }
  }

  const moveFocus = useCallback((event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const targetIndex = event.key === "ArrowDown" ? index + 1
      : event.key === "ArrowUp" ? index - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? commits.length - 1 : -1;
    if (targetIndex < 0 || targetIndex >= commits.length) return;
    event.preventDefault();
    onSelect(commits[targetIndex].oid);
    const node = viewportRef.current;
    if (node && (targetIndex * rowHeight < node.scrollTop || (targetIndex + 1) * rowHeight > node.scrollTop + node.clientHeight)) {
      node.scrollTop = Math.max(0, targetIndex * rowHeight - node.clientHeight / 2);
      const height = node.clientHeight || 520;
      const first = Math.max(0, Math.floor(node.scrollTop / rowHeight) - OVERSCAN);
      renderedWindowRef.current = { first, height };
      setViewport({ top: node.scrollTop, height });
    }
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-commit-index="${targetIndex}"]`)?.focus());
  }, [commits, onSelect, rowHeight]);

  const visibleStart = firstVisible * rowHeight;
  const visibleEnd = lastVisible * rowHeight;
  const visibleEdges = visibleCommits.flatMap((_, relativeIndex) => {
    const from = firstVisible + relativeIndex;
    return laneLayout.edgesByFrom[from].filter((edge) => edge.to * rowHeight >= visibleStart && edge.to * rowHeight <= visibleEnd)
      .map((edge) => ({ from, ...edge }));
  });
  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    applyFilters();
    const node = viewportRef.current;
    if (node) node.scrollTop = 0;
    setViewport((current) => ({ ...current, top: 0 }));
    onScrollPosition(0);
  }

  function clearFilters() {
    resetFilters();
    const node = viewportRef.current;
    if (node) node.scrollTop = 0;
    setViewport((current) => ({ ...current, top: 0 }));
    onScrollPosition(0);
  }

  return <div className="historyWorkspace">
    <form className={`historyFilters${showAdvancedFilters ? " expanded" : ""}`} aria-label={t("hist.filtersAria")} onSubmit={submitFilters}>
      <div className="historySearchRow">
        <label className="historyMessageSearch"><span className="srOnly">{t("hist.message")}</span><input ref={messageSearchRef} aria-label={t("hist.messageAria")} aria-keyshortcuts={searchShortcut} value={draftFilters.message || ""} onChange={(event) => setDraftFilter("message", event.target.value)} placeholder={t("hist.messagePlaceholder")} /></label>
        <button className={`quietButton compact historyFilterToggle${advancedFilterCount ? " active" : ""}`} type="button" aria-expanded={showAdvancedFilters} aria-controls={`history-filters-${repoId}`} aria-label={showAdvancedFilters ? t("hv.hideFilters") : t("hv.showFilters")} title={showAdvancedFilters ? t("hv.hideFilters") : t("hv.showFilters")} onClick={() => setFiltersOpen((open) => !open)}>{advancedFilterCount ? t("hv.filtersActive", { count: advancedFilterCount }) : t("hv.filters")}</button>
      </div>
      {showAdvancedFilters && <div className="historyAdvancedFilters" id={`history-filters-${repoId}`}>
      <label>{t("hist.sha")}<input aria-label={t("hist.shaAria")} value={draftFilters.sha || ""} onChange={(event) => setDraftFilter("sha", event.target.value)} placeholder={t("hist.shaPlaceholder")} /></label>
      <label>{t("hist.author")}<input aria-label={t("hist.authorAria")} value={draftFilters.author || ""} onChange={(event) => setDraftFilter("author", event.target.value)} placeholder={t("hist.authorPlaceholder")} /></label>
      <label>{t("hist.branch")}<select aria-label={t("hist.branchAria")} value={draftFilters.branch || ""} onChange={(event) => setDraftFilter("branch", event.target.value)}><option value="">{t("hist.allBranches")}</option>{refs.map((ref) => <option value={ref.name} key={ref.fullName}>{ref.name}</option>)}</select></label>
      <label>{t("hist.path")}<input aria-label={t("hist.pathAria")} value={draftFilters.path || ""} onChange={(event) => setDraftFilter("path", event.target.value)} placeholder={t("hist.pathPlaceholder")} /></label>
      <label>{t("hist.since")}<input aria-label={t("hist.sinceAria")} type="date" value={draftFilters.since || ""} onChange={(event) => setDraftFilter("since", event.target.value)} /></label>
      <label>{t("hist.until")}<input aria-label={t("hist.untilAria")} type="date" value={draftFilters.until || ""} onChange={(event) => setDraftFilter("until", event.target.value)} /></label>
      <div className="historyFilterActions"><button className="secondaryButton" type="submit">{t("hist.search")}</button>{hasFilters && <button className="textButton" type="button" onClick={clearFilters}>{t("hist.clear")}</button>}</div>
      </div>}
      {!showAdvancedFilters && hasFilters && <button className="textButton historyClearInline" type="button" onClick={clearFilters}>{t("hist.clear")}</button>}
    </form>
    <div className="graphViewport" ref={viewportRef} onScroll={(event) => void onScroll(event)} role="region" aria-label={t("main.graphView")}>
    {loading ? <div className="graphState" role="status"><span className="loadingSpinner" aria-hidden="true" />{searchPending ? t("hist.preparing") : t("hist.loading")}</div>
      : error ? <div className="graphState" role="alert"><p>{error}</p><button className="secondaryButton" type="button" onClick={retry}>{t("hist.retry")}</button></div>
        : commits.length === 0 ? <div className="graphEmpty"><div className="graphIllustration" aria-hidden="true"><div className="graphLine" /><span className="graphNode nodeOne" /><span className="graphNode nodeTwo" /><span className="graphNode nodeThree" /><span className="graphNode nodeFour" /></div><p className="sectionEyebrow">{t("hist.clearView")}</p><h2>{hasFilters ? t("hist.noMatching") : t("hist.noCommits")}</h2><p>{hasFilters ? t("hist.adjust") : t("hist.emptyRepo")}</p>{hasFilters && <button className="secondaryButton" type="button" onClick={clearFilters}>{t("hist.clear")}</button>}</div>
          : <div className="commitGraphCanvas" style={{ height: graphHeight, minWidth: graphWidth }}>
            <svg className="commitGraphEdges" aria-hidden="true" width={graphWidth} height={visibleEnd - visibleStart} viewBox={`0 ${visibleStart} ${graphWidth} ${visibleEnd - visibleStart}`} style={{ top: visibleStart }}>
              {visibleEdges.map((edge) => {
                const x1 = edge.fromLane * 20 + 22;
                const x2 = edge.toLane * 20 + 22;
                const y1 = edge.from * rowHeight + rowHeight / 2;
                const y2 = edge.to * rowHeight + rowHeight / 2;
                const direction = edge.to >= edge.from ? 1 : -1;
                // A merged-in branch keeps its own color; otherwise the line takes the color of the lane it leaves.
                return <path key={`${edge.from}-${edge.to}-${edge.fromLane}-${edge.toLane}`} className={laneClass(edge.merge ? edge.toLane : edge.fromLane)} d={`M ${x1} ${y1} C ${x1} ${y1 + direction * rowHeight / 2}, ${x2} ${y2 - direction * rowHeight / 2}, ${x2} ${y2}`} />;
              })}
            </svg>
            <div className="commitGraphList" role="list" aria-label={t("hist.listAria")}>
              <div className="commitGraphSpacer" aria-hidden="true" style={{ height: visibleStart }} />
              {visibleCommits.map((commit, visibleIndex) => {
                const index = firstVisible + visibleIndex;
                const lane = laneLayout.laneByOid.get(commit.oid) || 0;
                const refNames = refNamesByOid.get(commit.oid) || NO_REFS;
                const selected = selectedOid === commit.oid;
                return <div className="commitGraphRow" role="listitem" key={commit.oid} style={{ height: rowHeight }}>
                  <CommitGraphEntry
                    commit={commit}
                    index={index}
                    lane={lane}
                    refNames={refNames}
                    selected={selected}
                    tabIndex={selected || (!selectedOid && index === 0) ? 0 : -1}
                    onSelect={onSelect}
                    onMoveFocus={moveFocus}
                  />
                </div>;
              })}
              <div className="commitGraphSpacer" aria-hidden="true" style={{ height: Math.max(0, graphHeight - visibleEnd) }} />
            </div>
      </div>}
    {loadingMore && <div className="historyLoadingMore" role="status">{t("hist.loadingOlder")}</div>}
    {refsError && !loading && commits.length > 0 && <div className="historyLoadingMore" role="status">{t("hist.labelsUnavailable", { error: refsError })}</div>}
    </div>
  </div>;
}
