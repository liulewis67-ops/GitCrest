// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCrestApiError, type GitCrestApiClient, type TaskSnapshotResponse } from "../../src/api/client";
import {
  BACKGROUND_FETCH_STORAGE_KEY,
  DEFAULT_BACKGROUND_FETCH,
  getBackgroundFetchPreferences,
  readBackgroundFetchPreferences,
  resetBackgroundFetchPreferencesCache,
  setRepositoryBackgroundFetch,
  updateBackgroundFetchPreferences,
} from "../../src/features/remotes/model/background-fetch-preferences";
import { useBackgroundFetch } from "../../src/features/remotes/model/use-background-fetch";
import { BackgroundFetchSettings } from "../../src/features/remotes/ui/BackgroundFetchSettings";

const MINUTE = 60_000;

beforeEach(() => {
  localStorage.clear();
  resetBackgroundFetchPreferencesCache();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function task(overrides: Partial<TaskSnapshotResponse>): TaskSnapshotResponse {
  return { taskId: "t1", repoId: "repo_a", operation: "fetchBackground", status: "succeeded", phase: "", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false, ...overrides } as TaskSnapshotResponse;
}

function setup(props: { ready?: boolean; repoId?: string; tasks?: TaskSnapshotResponse[] } = {}) {
  const fetchRepository = vi.fn().mockResolvedValue(task({ taskId: "new", status: "queued" }));
  const api = { fetchRepository } as unknown as GitCrestApiClient;
  const onTaskAccepted = vi.fn();
  const onAuthenticationFailure = vi.fn();
  const hook = renderHook((current: { ready: boolean; repoId?: string; tasks: TaskSnapshotResponse[] }) => useBackgroundFetch({
    getApi: () => api, repoId: current.repoId, ready: current.ready, tasks: current.tasks, onTaskAccepted, onAuthenticationFailure,
  }), { initialProps: { ready: props.ready ?? true, repoId: "repoId" in props ? props.repoId : "repo_a", tasks: props.tasks ?? [] } });
  return { fetchRepository, onTaskAccepted, onAuthenticationFailure, ...hook };
}

async function advance(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe("background fetch preferences", () => {
  it("defaults to on, every 10 minutes", () => {
    expect(readBackgroundFetchPreferences(null)).toEqual(DEFAULT_BACKGROUND_FETCH);
    expect(DEFAULT_BACKGROUND_FETCH).toMatchObject({ enabled: true, intervalMinutes: 10 });
  });

  it("accepts only known intervals and shapes", () => {
    expect(readBackgroundFetchPreferences(JSON.stringify({ enabled: false, intervalMinutes: 30, disabledRepositories: ["a"] }))).toEqual({ enabled: false, intervalMinutes: 30, disabledRepositories: ["a"] });
    expect(readBackgroundFetchPreferences(JSON.stringify({ intervalMinutes: 7 })).intervalMinutes).toBe(10);
    expect(readBackgroundFetchPreferences(JSON.stringify({ disabledRepositories: [1, "b"] })).disabledRepositories).toEqual(["b"]);
    expect(readBackgroundFetchPreferences("{broken")).toEqual(DEFAULT_BACKGROUND_FETCH);
  });

  it("stores changes and switches one repository off and on", () => {
    updateBackgroundFetchPreferences({ intervalMinutes: 15 });
    setRepositoryBackgroundFetch("repo_a", false);
    expect(getBackgroundFetchPreferences()).toMatchObject({ intervalMinutes: 15, disabledRepositories: ["repo_a"] });
    expect(JSON.parse(localStorage.getItem(BACKGROUND_FETCH_STORAGE_KEY)!)).toMatchObject({ intervalMinutes: 15 });
    setRepositoryBackgroundFetch("repo_a", true);
    expect(getBackgroundFetchPreferences().disabledRepositories).toEqual([]);
  });
});

describe("background fetch schedule", () => {
  it("fetches once the interval has passed, as a background fetch, and records the task quietly", async () => {
    const { fetchRepository, onTaskAccepted } = setup();
    await advance(9 * MINUTE);
    expect(fetchRepository).not.toHaveBeenCalled();
    await advance(2 * MINUTE);
    expect(fetchRepository).toHaveBeenCalledWith("repo_a", false, true);
    expect(onTaskAccepted).toHaveBeenCalledTimes(1);
    await advance(5 * MINUTE);
    expect(fetchRepository).toHaveBeenCalledTimes(1);
    await advance(6 * MINUTE);
    expect(fetchRepository).toHaveBeenCalledTimes(2);
  });

  it("follows the chosen interval", async () => {
    updateBackgroundFetchPreferences({ intervalMinutes: 5 });
    const { fetchRepository } = setup();
    await advance(6 * MINUTE);
    expect(fetchRepository).toHaveBeenCalledTimes(1);
  });

  it("does nothing when switched off, for a switched-off repository, with nothing open or when not ready", async () => {
    updateBackgroundFetchPreferences({ enabled: false });
    const off = setup();
    await advance(30 * MINUTE);
    expect(off.fetchRepository).not.toHaveBeenCalled();
    off.unmount();

    updateBackgroundFetchPreferences({ enabled: true });
    setRepositoryBackgroundFetch("repo_a", false);
    const repositoryOff = setup();
    await advance(30 * MINUTE);
    expect(repositoryOff.fetchRepository).not.toHaveBeenCalled();
    repositoryOff.unmount();

    setRepositoryBackgroundFetch("repo_a", true);
    const nothingOpen = setup({ repoId: undefined });
    await advance(30 * MINUTE);
    expect(nothingOpen.fetchRepository).not.toHaveBeenCalled();
    nothingOpen.unmount();

    const busy = setup({ ready: false });
    await advance(30 * MINUTE);
    expect(busy.fetchRepository).not.toHaveBeenCalled();
  });

  it("waits while the window is hidden or offline", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    const { fetchRepository } = setup();
    await advance(30 * MINUTE);
    expect(fetchRepository).not.toHaveBeenCalled();
    visibility.mockReturnValue("visible");
    online.mockReturnValue(false);
    await advance(MINUTE);
    expect(fetchRepository).not.toHaveBeenCalled();
    online.mockReturnValue(true);
    await advance(MINUTE);
    expect(fetchRepository).toHaveBeenCalledTimes(1);
  });

  it("looks again within a minute when the core skipped it because a task was running", async () => {
    const { fetchRepository } = setup();
    fetchRepository.mockRejectedValueOnce(new GitCrestApiError(409, { error: { code: "REPOSITORY_STATE_CONFLICT", message: "busy" } } as never));
    await advance(10 * MINUTE);
    expect(fetchRepository).toHaveBeenCalledTimes(1);
    await advance(30_000);
    expect(fetchRepository).toHaveBeenCalledTimes(1);
    await advance(60_000);
    expect(fetchRepository).toHaveBeenCalledTimes(2);
  });
});

describe("background fetch sign-in failures", () => {
  const failed = task({ taskId: "bg1", status: "failed", errorCategory: "authentication" });

  it("reports a rejected sign-in once and stops asking that repository", async () => {
    const { fetchRepository, onAuthenticationFailure, rerender } = setup();
    rerender({ ready: true, repoId: "repo_a", tasks: [failed] });
    expect(onAuthenticationFailure).toHaveBeenCalledWith("repo_a");
    rerender({ ready: true, repoId: "repo_a", tasks: [failed, task({ taskId: "bg2", status: "failed", errorCategory: "authentication" })] });
    expect(onAuthenticationFailure).toHaveBeenCalledTimes(1);
    await advance(60 * MINUTE);
    expect(fetchRepository).not.toHaveBeenCalled();
  });

  it("starts again after the user's own fetch succeeds", async () => {
    const { fetchRepository, rerender } = setup();
    rerender({ ready: true, repoId: "repo_a", tasks: [failed] });
    rerender({ ready: true, repoId: "repo_a", tasks: [failed, task({ taskId: "manual", operation: "fetch", status: "succeeded" })] });
    await advance(11 * MINUTE);
    expect(fetchRepository).toHaveBeenCalledTimes(1);
  });

  it("starts again when the settings change", async () => {
    const { fetchRepository, rerender } = setup();
    rerender({ ready: true, repoId: "repo_a", tasks: [failed] });
    await advance(11 * MINUTE);
    expect(fetchRepository).not.toHaveBeenCalled();
    act(() => updateBackgroundFetchPreferences({ intervalMinutes: 5 }));
    await advance(MINUTE);
    expect(fetchRepository).toHaveBeenCalledTimes(1);
  });

  it("does not treat other failures as a sign-in problem", () => {
    const { onAuthenticationFailure, rerender } = setup();
    rerender({ ready: true, repoId: "repo_a", tasks: [task({ taskId: "net", status: "failed", errorCategory: "network" })] });
    expect(onAuthenticationFailure).not.toHaveBeenCalled();
  });
});

describe("background fetch settings", () => {
  it("switches the feature, the interval and the repository", () => {
    vi.useRealTimers();
    render(<BackgroundFetchSettings repoId="repo_a" />);
    fireEvent.change(screen.getByLabelText("Fetch every"), { target: { value: "30" } });
    expect(getBackgroundFetchPreferences().intervalMinutes).toBe(30);
    fireEvent.click(screen.getByLabelText("Also for this repository"));
    expect(getBackgroundFetchPreferences().disabledRepositories).toEqual(["repo_a"]);
    fireEvent.click(screen.getByLabelText("Fetch the open repository in the background"));
    expect(getBackgroundFetchPreferences().enabled).toBe(false);
    expect((screen.getByLabelText("Fetch every") as HTMLSelectElement).disabled).toBe(true);
  });

  it("offers no repository switch when none is open", () => {
    vi.useRealTimers();
    render(<BackgroundFetchSettings />);
    expect(screen.queryByLabelText("Also for this repository")).toBeNull();
  });
});
