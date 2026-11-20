import { useEffect, useRef } from "react";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../../api/client";
import { isAuthenticationFailure } from "../../tasks";
import { getBackgroundFetchPreferences } from "./background-fetch-preferences";

/** How often the schedule is checked; the interval itself is the user's setting. */
const TICK_MS = 30_000;
/** After the core skips a fetch because a task is running, look again soon rather than a full interval later. */
const RETRY_AFTER_SKIP_MS = 60_000;

interface BackgroundFetchOptions {
  getApi: () => GitCrestApiClient | undefined;
  repoId?: string;
  /** The repository is open, available, connected, has remotes and is not busy with another task. */
  ready: boolean;
  tasks: TaskSnapshotResponse[];
  /** The task is recorded without opening the task list. */
  onTaskAccepted: (task: TaskSnapshotResponse) => void;
  /** A scheduled fetch could not sign in; reported once and then paused for that repository. */
  onAuthenticationFailure: (repoId: string) => void;
  now?: () => number;
}

/**
 * Fetches the open repository now and then so ahead and behind stay current. It only runs while the
 * window is visible and online, never interrupts a running task, and stops asking a repository that
 * rejected its credentials until the user fetches by hand or changes the settings.
 */
export function useBackgroundFetch({ getApi, repoId, ready, tasks, onTaskAccepted, onAuthenticationFailure, now = Date.now }: BackgroundFetchOptions) {
  const latest = useRef({ getApi, repoId, ready, onTaskAccepted, now });
  latest.current = { getApi, repoId, ready, onTaskAccepted, now };
  const lastRun = useRef(new Map<string, number>());
  const startedAt = useRef(now());
  const paused = useRef(new Set<string>());
  const inFlight = useRef(false);
  const seenFailures = useRef(new Set<string>());
  const lastPreferences = useRef(getBackgroundFetchPreferences());

  // A repository that rejected its sign-in stays quiet until a fetch of the user's own works.
  useEffect(() => {
    for (const task of tasks) {
      if (!task.repoId) continue;
      if (task.operation === "fetch" && task.status === "succeeded") paused.current.delete(task.repoId);
      if (task.operation === "fetchBackground" && task.status === "succeeded") paused.current.delete(task.repoId);
      if (task.operation === "fetchBackground" && task.status === "failed" && task.updatedAtMs >= now() - 86_400_000 && !seenFailures.current.has(task.taskId)) {
        seenFailures.current.add(task.taskId);
        if (isAuthenticationFailure(task) && !paused.current.has(task.repoId)) {
          paused.current.add(task.repoId);
          onAuthenticationFailure(task.repoId);
        }
      }
    }
  }, [tasks]);

  useEffect(() => {
    async function tick() {
      const { getApi: api, repoId: id, ready: isReady, onTaskAccepted: accept, now: clock } = latest.current;
      const preferences = getBackgroundFetchPreferences();
      // Changing the settings is a reason to try again, even for a repository that was paused.
      if (preferences !== lastPreferences.current) {
        lastPreferences.current = preferences;
        paused.current.clear();
      }
      if (!id || !isReady || !preferences.enabled || preferences.disabledRepositories.includes(id) || paused.current.has(id)) return;
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) return;
      if (inFlight.current) return;
      const current = clock();
      if (current - (lastRun.current.get(id) ?? startedAt.current) < preferences.intervalMinutes * 60_000) return;
      const client = api();
      if (!client) return;
      inFlight.current = true;
      lastRun.current.set(id, current);
      try {
        accept(await client.fetchRepository(id, false, true));
      } catch (error) {
        // 409: the core found another task running. Try again soon instead of waiting a whole interval.
        if (error instanceof GitCrestApiError && error.status === 409) {
          lastRun.current.set(id, current - preferences.intervalMinutes * 60_000 + RETRY_AFTER_SKIP_MS);
        }
      } finally {
        inFlight.current = false;
      }
    }
    const timer = window.setInterval(() => { void tick(); }, TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
}
