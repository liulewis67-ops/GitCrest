import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent, UIEvent } from "react";
import type { CommitDetailResponse, CommitHistoryFilters, CommitPageResponse, GitCrestApiClient, RefSnapshotResponse } from "../../api/client";
import type { components } from "../../api/schema";

const PAGE_SIZE = 50;
const ROW_HEIGHT = 52;
const OVERSCAN = 8;
const COMMIT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
type CommitSummary = components["schemas"]["CommitSummary"];

function isCommitSummary(value: unknown): value is CommitSummary {
  if (!value || typeof value !== "object") return false;
  const commit = value as Partial<CommitSummary>;
  return typeof commit.oid === "string"
    && Array.isArray(commit.parents) && commit.parents.every((parent) => typeof parent === "string")
    && typeof commit.authorName === "string"
    && typeof commit.authorEmail === "string"
    && typeof commit.committedAtMs === "number"
    && typeof commit.subject === "string";
}

function isCommitDetail(value: unknown): value is CommitDetailResponse {
  if (!value || typeof value !== "object") return false;
  const detail = value as Partial<CommitDetailResponse>;
  return typeof detail.oid === "string"
    && Array.isArray(detail.parents)
    && typeof detail.authorName === "string"
    && typeof detail.authorEmail === "string"
    && typeof detail.committedAtMs === "number"
    && typeof detail.message === "string"
    && Boolean(detail.stats && typeof detail.stats.filesChanged === "number" && typeof detail.stats.insertions === "number" && typeof detail.stats.deletions === "number")
    && Array.isArray(detail.files);
}

type CommitGraphProps = {
  api: GitCrestApiClient;
  repoId: string;
  selectedOid?: string;
  initialScrollTop: number;
  refreshKey?: number;
  focusSearchRequest?: { repoId: string; sequence: number };
  searchShortcut?: string;
  onFocusSearchHandled?: (sequence: number) => void;
  onScrollPosition: (scrollTop: number) => void;
  onSelect: (oid: string) => void;
};

function formatCommitDate(timestamp: number): string {
  return COMMIT_DATE_FORMAT.format(new Date(timestamp));
}

function describeRefs(refs: RefSnapshotResponse["refs"], oid: string): string[] {
  return refs.filter((ref) => ref.oid === oid).map((ref) => ref.name);
}

export function CommitGraph({ api, repoId, selectedOid, initialScrollTop, refreshKey = 0, focusSearchRequest, searchShortcut, onFocusSearchHandled, onScrollPosition, onSelect }: CommitGraphProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const messageSearchRef = useRef<HTMLInputElement>(null);
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [refs, setRefs] = useState<RefSnapshotResponse["refs"]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refsError, setRefsError] = useState("");
  const [draftFilters, setDraftFilters] = useState<CommitHistoryFilters>({});
  const [filters, setFilters] = useState<CommitHistoryFilters>({});
  const [viewport, setViewport] = useState({ top: 0, height: 520 });
  const renderedWindowRef = useRef({ first: 0, height: 520 });
  const requestGeneration = useRef(0);
  const offsetsInFlight = useRef(new Set<number>());
  const restoredRepo = useRef<string>();

  const readPage = useCallback(async (offset: number, generation: number) => {
    if (offsetsInFlight.current.has(offset)) return;
    offsetsInFlight.current.add(offset);
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    setError("");
    try {
      const response: unknown = await api.getRepositoryCommits(repoId, offset, PAGE_SIZE, filters);
      if (requestGeneration.current !== generation) return;
      if (!response || typeof response !== "object" || !Array.isArray((response as Partial<CommitPageResponse>).commits)) {
        throw new Error("History response did not contain a commit list.");
      }
      const page = response as CommitPageResponse;
      if (!page.commits.every(isCommitSummary)) throw new Error("History response contained an invalid commit.");
      setCommits((current) => offset === 0 ? page.commits : [...current, ...page.commits]);
      setNextOffset(typeof page.nextOffset === "number" && Number.isSafeInteger(page.nextOffset) ? page.nextOffset : null);
    } catch (reason) {
      if (requestGeneration.current !== generation) return;
      setError(reason instanceof Error ? reason.message : "Could not read commit history.");
    } finally {
      offsetsInFlight.current.delete(offset);
      if (requestGeneration.current === generation) {
        if (offset === 0) setLoading(false);
        else setLoadingMore(false);
      }
    }
  }, [api, filters, repoId]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    offsetsInFlight.current.clear();
    setCommits([]);
    setRefs([]);
    setNextOffset(0);
    setLoading(true);
    setLoadingMore(false);
    setError("");
    setRefsError("");
    void readPage(0, generation);
    return () => { requestGeneration.current += 1; };
  }, [api, repoId, readPage, refreshKey]);

  useEffect(() => {
    let active = true;
    void api.getRepositoryRefs(repoId).then((snapshot) => {
      if (active) setRefs(Array.isArray(snapshot.refs) ? snapshot.refs : []);
    }).catch((reason: unknown) => {
      if (active) setRefsError(reason instanceof Error ? reason.message : "Could not read repository refs.");
    });
    return () => { active = false; };
  }, [api, repoId, refreshKey]);

  useEffect(() => {
    const node = viewportRef.current;
    if (!node || loading || restoredRepo.current === repoId) return;
    node.scrollTop = initialScrollTop;
    restoredRepo.current = repoId;
    const height = node.clientHeight || 520;
    const first = Math.max(0, Math.floor(node.scrollTop / ROW_HEIGHT) - OVERSCAN);
    renderedWindowRef.current = { first, height };
    setViewport({ top: node.scrollTop, height });
  }, [initialScrollTop, loading, repoId]);

  useEffect(() => {
    if (focusSearchRequest?.repoId !== repoId) return;
    messageSearchRef.current?.focus();
    onFocusSearchHandled?.(focusSearchRequest.sequence);
  }, [focusSearchRequest, onFocusSearchHandled, repoId]);

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
    const edgesByFrom: { to: number; fromLane: number; toLane: number }[][] = Array.from({ length: commits.length }, () => []);
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
        edgesByFrom[index].push({ to: targetIndex ?? index + 1, fromLane: lane, toLane: parentLane });
      });
    });
    return { laneByOid, edgesByFrom, maxLane: Math.max(0, nextLane - 1) };
  }, [commits]);

  const firstVisible = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewport.height / ROW_HEIGHT) + OVERSCAN * 2;
  const lastVisible = Math.min(commits.length, firstVisible + visibleCount);
  const visibleCommits = commits.slice(firstVisible, lastVisible);
  const graphHeight = commits.length * ROW_HEIGHT;
  const graphWidth = Math.max(112, laneLayout.maxLane * 20 + 44);

  async function onScroll(event: UIEvent<HTMLDivElement>) {
    const node = event.currentTarget;
    const top = node.scrollTop;
    const height = node.clientHeight || 520;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    if (first !== renderedWindowRef.current.first || height !== renderedWindowRef.current.height) {
      renderedWindowRef.current = { first, height };
      setViewport({ top, height });
    }
    if (nextOffset !== null && !loadingMore && node.scrollHeight - node.scrollTop - node.clientHeight < ROW_HEIGHT * 10) {
      await readPage(nextOffset, requestGeneration.current);
    }
  }

  function moveFocus(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const targetIndex = event.key === "ArrowDown" ? index + 1
      : event.key === "ArrowUp" ? index - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? commits.length - 1 : -1;
    if (targetIndex < 0 || targetIndex >= commits.length) return;
    event.preventDefault();
    onSelect(commits[targetIndex].oid);
    const node = viewportRef.current;
    if (node && (targetIndex * ROW_HEIGHT < node.scrollTop || (targetIndex + 1) * ROW_HEIGHT > node.scrollTop + node.clientHeight)) {
      node.scrollTop = Math.max(0, targetIndex * ROW_HEIGHT - node.clientHeight / 2);
      const height = node.clientHeight || 520;
      const first = Math.max(0, Math.floor(node.scrollTop / ROW_HEIGHT) - OVERSCAN);
      renderedWindowRef.current = { first, height };
      setViewport({ top: node.scrollTop, height });
    }
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-commit-index="${targetIndex}"]`)?.focus());
  }

  const visibleStart = firstVisible * ROW_HEIGHT;
  const visibleEnd = lastVisible * ROW_HEIGHT;
  const visibleEdges = visibleCommits.flatMap((_, relativeIndex) => {
    const from = firstVisible + relativeIndex;
    return laneLayout.edgesByFrom[from].filter((edge) => edge.to * ROW_HEIGHT >= visibleStart && edge.to * ROW_HEIGHT <= visibleEnd)
      .map((edge) => ({ from, ...edge }));
  });
  const hasFilters = Object.values(filters).some((value) => typeof value === "string" && value.length > 0);

  function setFilter<K extends keyof CommitHistoryFilters>(key: K, value: string) {
    setDraftFilters((current) => ({ ...current, [key]: value || undefined }));
  }

  function submitFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = Object.fromEntries(
      Object.entries(draftFilters).filter(([, value]) => typeof value === "string" && value.trim().length > 0),
    ) as CommitHistoryFilters;
    setFilters(next);
    const node = viewportRef.current;
    if (node) node.scrollTop = 0;
    setViewport((current) => ({ ...current, top: 0 }));
    onScrollPosition(0);
  }

  function clearFilters() {
    setDraftFilters({});
    setFilters({});
    const node = viewportRef.current;
    if (node) node.scrollTop = 0;
    setViewport((current) => ({ ...current, top: 0 }));
    onScrollPosition(0);
  }

  return <div className="historyWorkspace">
    <form className="historyFilters" aria-label="Commit history filters" onSubmit={submitFilters}>
      <label>SHA<input aria-label="Filter by SHA" value={draftFilters.sha || ""} onChange={(event) => setFilter("sha", event.target.value)} placeholder="Prefix or full object ID" /></label>
      <label>Author<input aria-label="Filter by author" value={draftFilters.author || ""} onChange={(event) => setFilter("author", event.target.value)} placeholder="Name or email" /></label>
      <label>Message<input ref={messageSearchRef} aria-label="Filter by message" aria-keyshortcuts={searchShortcut} value={draftFilters.message || ""} onChange={(event) => setFilter("message", event.target.value)} placeholder="Contains text" /></label>
      <label>Branch<select aria-label="Filter by branch" value={draftFilters.branch || ""} onChange={(event) => setFilter("branch", event.target.value)}><option value="">All branches</option>{refs.map((ref) => <option value={ref.name} key={ref.fullName}>{ref.name}</option>)}</select></label>
      <label>Path<input aria-label="Filter by path" value={draftFilters.path || ""} onChange={(event) => setFilter("path", event.target.value)} placeholder="Exact repository path" /></label>
      <label>Since<input aria-label="Filter since date" type="date" value={draftFilters.since || ""} onChange={(event) => setFilter("since", event.target.value)} /></label>
      <label>Until<input aria-label="Filter until date" type="date" value={draftFilters.until || ""} onChange={(event) => setFilter("until", event.target.value)} /></label>
      <div className="historyFilterActions"><button className="secondaryButton" type="submit">Search</button>{hasFilters && <button className="textButton" type="button" onClick={clearFilters}>Clear filters</button>}</div>
    </form>
    <div className="graphViewport" ref={viewportRef} onScroll={(event) => void onScroll(event)} role="region" aria-label="Commit graph view">
    {loading ? <div className="graphState" role="status"><span className="loadingSpinner" aria-hidden="true" />Loading commit history…</div>
      : error ? <div className="graphState" role="alert"><p>{error}</p><button className="secondaryButton" type="button" onClick={() => void readPage(commits.length, requestGeneration.current)}>Retry history</button></div>
        : commits.length === 0 ? <div className="graphEmpty"><div className="graphIllustration" aria-hidden="true"><div className="graphLine" /><span className="graphNode nodeOne" /><span className="graphNode nodeTwo" /><span className="graphNode nodeThree" /><span className="graphNode nodeFour" /></div><p className="sectionEyebrow">A CLEAR VIEW OF YOUR HISTORY</p><h2>{hasFilters ? "No matching commits" : "No commits yet"}</h2><p>{hasFilters ? "Adjust or clear the current filters to see more history." : "This repository has no commit history on HEAD or its branches."}</p>{hasFilters && <button className="secondaryButton" type="button" onClick={clearFilters}>Clear filters</button>}</div>
          : <div className="commitGraphCanvas" style={{ height: graphHeight, minWidth: graphWidth }}>
            <svg className="commitGraphEdges" aria-hidden="true" width={graphWidth} height={visibleEnd - visibleStart} viewBox={`0 ${visibleStart} ${graphWidth} ${visibleEnd - visibleStart}`} style={{ top: visibleStart }}>
              {visibleEdges.map((edge) => {
                const x1 = edge.fromLane * 20 + 22;
                const x2 = edge.toLane * 20 + 22;
                const y1 = edge.from * ROW_HEIGHT + ROW_HEIGHT / 2;
                const y2 = edge.to * ROW_HEIGHT + ROW_HEIGHT / 2;
                const direction = edge.to >= edge.from ? 1 : -1;
                return <path key={`${edge.from}-${edge.to}-${edge.fromLane}-${edge.toLane}`} d={`M ${x1} ${y1} C ${x1} ${y1 + direction * ROW_HEIGHT / 2}, ${x2} ${y2 - direction * ROW_HEIGHT / 2}, ${x2} ${y2}`} />;
              })}
            </svg>
            <div className="commitGraphList" role="list" aria-label="Commit history">
              <div className="commitGraphSpacer" aria-hidden="true" style={{ height: visibleStart }} />
              {visibleCommits.map((commit, visibleIndex) => {
                const index = firstVisible + visibleIndex;
                const lane = laneLayout.laneByOid.get(commit.oid) || 0;
                const refNames = describeRefs(refs, commit.oid);
                const selected = selectedOid === commit.oid;
                return <div className="commitGraphRow" role="listitem" key={commit.oid} style={{ height: ROW_HEIGHT }}>
                  <button className={`commitGraphEntry${selected ? " selected" : ""}`} type="button" data-commit-index={index} data-commit-oid={commit.oid} style={{ paddingLeft: lane * 20 + 42 }} aria-current={selected ? "true" : undefined} aria-label={`${commit.subject}, ${commit.authorName}, ${formatCommitDate(commit.committedAtMs)}, ${commit.oid.slice(0, 12)}${refNames.length ? `, ${refNames.join(", ")}` : ""}`} tabIndex={selected || (!selectedOid && index === 0) ? 0 : -1} onClick={() => onSelect(commit.oid)} onKeyDown={(event) => moveFocus(event, index)}>
                    <span className={`commitGraphNode${commit.parents.length > 1 ? " merge" : ""}`} style={{ left: lane * 20 + 16 }} aria-hidden="true" />
                    <span className="commitGraphText"><span className="commitGraphSubject">{commit.subject || "(no subject)"}</span><span className="commitGraphMeta">{commit.authorName} · {formatCommitDate(commit.committedAtMs)}</span></span>
                    <span className="commitGraphOid">{commit.oid.slice(0, 8)}</span>
                    {refNames.map((name) => <span className="commitRefBadge" key={name}>{name}</span>)}
                  </button>
                </div>;
              })}
              <div className="commitGraphSpacer" aria-hidden="true" style={{ height: Math.max(0, graphHeight - visibleEnd) }} />
            </div>
      </div>}
    {loadingMore && <div className="historyLoadingMore" role="status">Loading older commits…</div>}
    {refsError && !loading && commits.length > 0 && <div className="historyLoadingMore" role="status">Branch labels unavailable: {refsError}</div>}
    </div>
  </div>;
}

export function CommitDetails({
  api,
  repoId,
  oid,
  onOpenFile,
  onOpenDiffWindow,
  onWorkflow,
  workflowDisabledReason,
  openTagRequest,
  tagShortcut,
  cherryPickShortcut,
  onTagRequestHandled,
}: {
  api: GitCrestApiClient;
  repoId: string;
  oid?: string;
  onOpenFile?: (path: string, oid: string) => void;
  onOpenDiffWindow?: (path: string, oid: string) => void;
  onWorkflow?: (action: "merge" | "cherryPick" | "revert", oid: string) => void;
  workflowDisabledReason?: string;
  openTagRequest?: { repoId: string; oid: string; sequence: number };
  tagShortcut?: string;
  cherryPickShortcut?: string;
  onTagRequestHandled?: (sequence: number) => void;
}) {
  const [state, setState] = useState<{ oid?: string; detail?: CommitDetailResponse; error?: string; loading: boolean }>({ loading: false });
  const [copyMessage, setCopyMessage] = useState("");
  const [tagEditorOpen, setTagEditorOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagMessage, setTagMessage] = useState("");
  const [tagBusy, setTagBusy] = useState(false);
  const [tagStatus, setTagStatus] = useState("");
  const [tagError, setTagError] = useState("");
  useEffect(() => {
    let active = true;
    if (!oid) {
      setState({ loading: false });
      return () => { active = false; };
    }
    setState({ oid, loading: true });
    void api.getRepositoryCommit(repoId, oid).then((response) => {
      if (!isCommitDetail(response)) throw new Error("Commit detail response was invalid.");
      if (active) setState({ oid, detail: response, loading: false });
    }).catch((reason: unknown) => {
      if (active) setState({ oid, error: reason instanceof Error ? reason.message : "Could not read commit details.", loading: false });
    });
    return () => { active = false; };
  }, [api, oid, repoId]);

  useEffect(() => {
    setTagEditorOpen(false);
    setTagName("");
    setTagMessage("");
    setTagStatus("");
    setTagError("");
    setCopyMessage("");
  }, [oid]);

  useEffect(() => {
    if (openTagRequest?.repoId !== repoId || openTagRequest.oid !== oid) return;
    setTagError("");
    setTagEditorOpen(true);
    onTagRequestHandled?.(openTagRequest.sequence);
  }, [oid, onTagRequestHandled, openTagRequest, repoId]);

  if (!oid) return <div className="detailsEmpty"><span className="detailsGlyph" aria-hidden="true">⌁</span><h2>No commit selected</h2><p>Select a commit in the graph to inspect its message, author, and changed files.</p></div>;
  if (state.oid !== oid || state.loading) return <div className="commitDetailsState" role="status">Loading commit details…</div>;
  if (state.error) return <div className="commitDetailsState" role="alert"><p>{state.error}</p></div>;
  const detail = state.detail;
  if (!detail) return null;
  const commitOid = detail.oid;
  async function copyCommitId() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
      await navigator.clipboard.writeText(commitOid);
      setCopyMessage("Full commit SHA copied.");
    } catch {
      setCopyMessage("Clipboard access is unavailable. Select the commit ID to copy it.");
    }
  }
  async function createAnnotatedTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setTagBusy(true);
    setTagError("");
    setTagStatus("");
    try {
      const tag = await api.createRepositoryCommitTag(repoId, commitOid, tagName.trim(), tagMessage);
      setTagEditorOpen(false);
      setTagName("");
      setTagMessage("");
      setTagStatus(`Annotated tag ${tag.name} created at ${commitOid.slice(0, 12)}.`);
    } catch (reason) {
      setTagError(reason instanceof Error ? reason.message : "Could not create this tag.");
    } finally {
      setTagBusy(false);
    }
  }
  return <div className="commitDetails">
    <div className="repositoryFact"><span>COMMIT</span><strong className="monoText" title={detail.oid}>{detail.oid.slice(0, 12)}</strong></div>
    <button className="textButton commitCopyButton" type="button" onClick={() => void copyCommitId()}>Copy SHA</button>
    {copyMessage && <p className="commitCopyStatus" role="status">{copyMessage}</p>}
    <button className="textButton commitCopyButton" type="button" aria-keyshortcuts={tagShortcut} onClick={() => { setTagError(""); setTagEditorOpen((current) => !current); }}>{tagEditorOpen ? "Cancel tag" : "Create tag"}</button>
    {onWorkflow && <div className="commitWorkflowActions" aria-label="Commit actions"><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} title={workflowDisabledReason} onClick={() => onWorkflow("merge", commitOid)}>Merge</button><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} aria-keyshortcuts={cherryPickShortcut} title={workflowDisabledReason} onClick={() => onWorkflow("cherryPick", commitOid)}>Cherry-pick</button><button className="quietButton compact" type="button" disabled={Boolean(workflowDisabledReason)} title={workflowDisabledReason} onClick={() => onWorkflow("revert", commitOid)}>Revert</button></div>}
    {tagEditorOpen && <form className="commitTagForm" onSubmit={(event) => void createAnnotatedTag(event)}>
      <label>Tag name<input aria-label="Tag name" value={tagName} maxLength={255} required onChange={(event) => setTagName(event.target.value)} placeholder="v1.0.0" /></label>
      <label>Annotation message<textarea aria-label="Tag annotation" value={tagMessage} maxLength={8192} onChange={(event) => setTagMessage(event.target.value)} placeholder="Describe this release" /></label>
      {tagError && <p className="commitTagError" role="alert">{tagError}</p>}
      <button className="secondaryButton" type="submit" disabled={tagBusy || !tagName.trim()}>{tagBusy ? "Creating tag…" : "Create annotated tag"}</button>
    </form>}
    {tagStatus && <p className="commitCopyStatus" role="status">{tagStatus}</p>}
    <div className="repositoryFact"><span>AUTHOR</span><strong>{detail.authorName}</strong></div>
    <div className="repositoryFact"><span>DATE</span><strong>{formatCommitDate(detail.committedAtMs)}</strong></div>
    <div className="commitDetailMessage">{detail.message}</div>
    <div className="commitDetailStats"><strong>{detail.stats.filesChanged}</strong> files <span>+</span>{detail.stats.insertions} <span>−</span>{detail.stats.deletions}</div>
    <div className="commitDetailFiles" aria-label="Changed files">{detail.files.map((file) => <div className="commitDetailFileRow" key={file.path}><button className="commitDetailFile" type="button" aria-label={`Open commit diff for ${file.path}`} onClick={() => onOpenFile?.(file.path, detail.oid)}><span title={file.path}>{file.path}</span><small>{file.additions === null || file.deletions === null ? "binary" : `+${file.additions} −${file.deletions}`}</small></button>{onOpenDiffWindow && <button className="commitDetailFileWindow" type="button" aria-label={`Open commit diff window for ${file.path}`} title="Open in a read-only Diff window" onClick={() => onOpenDiffWindow(file.path, detail.oid)}>↗</button>}</div>)}</div>
  </div>;
}
