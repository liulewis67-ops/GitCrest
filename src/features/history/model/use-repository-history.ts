import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitHistoryFilters, CommitPageResponse, GitCrestApiClient, RefSnapshotResponse } from "../../../api/client";
import type { components } from "../../../api/schema";

const PAGE_SIZE = 50;
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

export function useRepositoryHistory(
  api: GitCrestApiClient,
  repoId: string,
  filters: CommitHistoryFilters,
  refreshKey: number,
) {
  const [commits, setCommits] = useState<CommitSummary[]>([]);
  const [refs, setRefs] = useState<RefSnapshotResponse["refs"]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [refsError, setRefsError] = useState("");
  const requestGeneration = useRef(0);
  const offsetsInFlight = useRef(new Set<number>());

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
  }, [readPage, refreshKey]);

  useEffect(() => {
    let active = true;
    setRefsError("");
    void api.getRepositoryRefs(repoId).then((snapshot) => {
      if (active) setRefs(Array.isArray(snapshot.refs) ? snapshot.refs : []);
    }).catch((reason: unknown) => {
      if (active) setRefsError(reason instanceof Error ? reason.message : "Could not read repository refs.");
    });
    return () => { active = false; };
  }, [api, repoId, refreshKey]);

  const loadMore = useCallback(() => {
    if (nextOffset !== null && !loadingMore) void readPage(nextOffset, requestGeneration.current);
  }, [loadingMore, nextOffset, readPage]);

  const retry = useCallback(() => {
    void readPage(commits.length, requestGeneration.current);
  }, [commits.length, readPage]);

  return { commits, refs, loading, loadingMore, error, refsError, loadMore, retry };
}
