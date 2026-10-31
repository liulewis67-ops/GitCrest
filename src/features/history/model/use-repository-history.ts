import { describeApiError, type DisplayError } from "../../../shared/i18n/api-errors";
import { t } from "../../../shared/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitHistoryFilters, CommitPageResponse, GitCrestApiClient, RefSnapshotResponse } from "../../../api/client";
import type { components } from "../../../api/schema";

const PAGE_SIZE = 50;
const SEARCH_INDEX_RETRY_MS = 500;
const SEARCH_INDEX_WAIT_LIMIT_MS = 30_000;
type CommitSummary = components["schemas"]["CommitSummary"];

function waitForSearchIndex(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, SEARCH_INDEX_RETRY_MS);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

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
  const [searchPending, setSearchPending] = useState(false);
  const [error, setError] = useState<DisplayError>("");
  const [refsError, setRefsError] = useState<DisplayError>("");
  const requestGeneration = useRef(0);
  const offsetsInFlight = useRef(new Set<string>());
  const activeController = useRef<AbortController>();

  const readPage = useCallback(async (offset: number, generation: number, signal: AbortSignal) => {
    const requestKey = `${generation}:${offset}`;
    if (offsetsInFlight.current.has(requestKey)) return;
    offsetsInFlight.current.add(requestKey);
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    setError("");
    try {
      const waitStartedAt = Date.now();
      let response: unknown;
      while (true) {
        response = await api.withSignal(signal).getRepositoryCommits(repoId, offset, PAGE_SIZE, filters);
        if (!response || typeof response !== "object" || (response as Partial<CommitPageResponse>).searchPending !== true) {
          setSearchPending(false);
          break;
        }
        setSearchPending(true);
        if (Date.now() - waitStartedAt >= SEARCH_INDEX_WAIT_LIMIT_MS) {
          throw new Error(t("err.historySlow"));
        }
        await waitForSearchIndex(signal);
        if (signal.aborted) return;
      }
      if (requestGeneration.current !== generation) return;
      if (!response || typeof response !== "object" || !Array.isArray((response as Partial<CommitPageResponse>).commits)) {
        throw new Error(t("err.historyNoList"));
      }
      const page = response as CommitPageResponse;
      if (!page.commits.every(isCommitSummary)) throw new Error(t("err.historyInvalid"));
      setCommits((current) => offset === 0 ? page.commits : [...current, ...page.commits]);
      setNextOffset(typeof page.nextOffset === "number" && Number.isSafeInteger(page.nextOffset) ? page.nextOffset : null);
    } catch (reason) {
      if (requestGeneration.current !== generation) return;
      setError(describeApiError(reason, t("err.readHistory")));
    } finally {
      offsetsInFlight.current.delete(requestKey);
      if (requestGeneration.current === generation) {
        if (offset === 0) setLoading(false);
        else setLoadingMore(false);
        setSearchPending(false);
      }
    }
  }, [api, filters, repoId]);

  useEffect(() => {
    const generation = ++requestGeneration.current;
    const controller = new AbortController();
    activeController.current = controller;
    offsetsInFlight.current.clear();
    setCommits([]);
    setNextOffset(0);
    setLoading(true);
    setLoadingMore(false);
    setSearchPending(false);
    setError("");
    void readPage(0, generation, controller.signal);
    return () => {
      controller.abort();
      if (activeController.current === controller) activeController.current = undefined;
      requestGeneration.current += 1;
    };
  }, [readPage, refreshKey]);

  useEffect(() => {
    const controller = new AbortController();
    // Refs are cleared only here, next to their refetch: a filter change reloads commits but keeps the badges.
    setRefs([]);
    setRefsError("");
    void api.withSignal(controller.signal).getRepositoryRefs(repoId).then((snapshot) => {
      if (!controller.signal.aborted) setRefs(Array.isArray(snapshot.refs) ? snapshot.refs : []);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setRefsError(describeApiError(reason, t("err.readRefs")));
    });
    return () => controller.abort();
  }, [api, repoId, refreshKey]);

  const loadMore = useCallback(() => {
    const controller = activeController.current;
    if (controller && !controller.signal.aborted && nextOffset !== null && !loadingMore) {
      void readPage(nextOffset, requestGeneration.current, controller.signal);
    }
  }, [loadingMore, nextOffset, readPage]);

  const retry = useCallback(() => {
    const controller = activeController.current;
    if (controller && !controller.signal.aborted) void readPage(commits.length, requestGeneration.current, controller.signal);
  }, [commits.length, readPage]);

  return { commits, refs, loading, loadingMore, searchPending, error, refsError, loadMore, retry };
}
