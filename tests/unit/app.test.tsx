// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import App from "../../src/App";

const resyncEvent: components["schemas"]["EventEnvelope"] = {
  eventId: "event-1",
  protocolVersion: 1,
  type: "connection.resyncRequired",
  occurredAtMs: 1_791_386_400_000,
  payload: {},
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("connects to the sidecar and reloads the repository list after event resync", async () => {
    let onEvent: ((event: components["schemas"]["EventEnvelope"]) => void) | undefined;
    const subscribeToEvents = vi.fn(async (listener: typeof onEvent) => {
      onEvent = listener;
      return vi.fn();
    });
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents,
        chooseRepository: vi.fn(),
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "gitcrest-core",
        version: "0.1.0",
        apiVersion: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", {
        status: 200,
        headers: { "X-GitCrest-API-Version": "1" },
      }))
      .mockResolvedValueOnce(new Response("[]", {
        status: 200,
        headers: { "X-GitCrest-API-Version": "1" },
      }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByText("Core connected")).toBeDefined();
    expect(screen.getByText("gitcrest-core 0.1.0 (API v1)")).toBeDefined();
    await waitFor(() => expect(subscribeToEvents).toHaveBeenCalledOnce());

    onEvent?.(resyncEvent);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(String(fetcher.mock.calls[2][0])).toBe("http://127.0.0.1:43210/api/v1/repositories");
  });

  it("opens a keyboard-accessible command palette with reasons for unavailable actions", async () => {
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "gitcrest-core", version: "0.1.0", apiVersion: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));

    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeDefined();
    const openCommand = within(dialog).getByRole("button", { name: /Open local repository/ }) as HTMLButtonElement;
    expect(openCommand.disabled).toBe(false);
    expect(within(dialog).getByRole("button", { name: /Clone repository/ })).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  });

  it("shows task progress and sanitized logs, and requests cancellation", async () => {
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository: vi.fn(),
      },
    });
    const task = { taskId: "task-1", repoId: "repo_fixture", operation: "fetch", status: "running", phase: "Receiving objects", progress: 35, message: null, errorCategory: null, logs: ["Receiving objects: 35%", "https://alice:[REDACTED]@example.test/repo"], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false };
    const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([task]))
      .mockResolvedValueOnce(response({ ...task, cancelRequested: true }))
      .mockResolvedValue(response([{ ...task, cancelRequested: true }]));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: /Background tasks/ }));
    const dialog = await screen.findByRole("dialog", { name: "Tasks" });
    expect(await within(dialog).findByText("Receiving objects")).toBeDefined();
    expect(within(dialog).getByText("35%")).toBeDefined();
    fireEvent.click(within(dialog).getByText(/Sanitized log/));
    expect(dialog.querySelector(".taskLogs pre")?.textContent).toContain("https://alice:[REDACTED]@example.test/repo");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel task" }));
    expect(await within(dialog).findByRole("button", { name: "Stopping safely…" })).toBeDefined();
    expect(String(fetcher.mock.calls[3][0])).toContain("/api/v1/tasks/task-1/cancel");
    expect(fetcher.mock.calls[3][1]?.method).toBe("POST");
  });

  it("queues a clone and automatically opens the registered repository after it succeeds", async () => {
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository: vi.fn(),
        chooseCloneParent: vi.fn().mockResolvedValue("C:/projects"),
      },
    });
    const task = {
      taskId: "task-clone-1", repoId: null, targetPath: "C:/projects/Hello-World", resultRepoId: "repo_cloned",
      operation: "clone", status: "succeeded", phase: "Complete", progress: 100, message: "Task completed",
      errorCategory: null, logs: ["Receiving objects: 100%"], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false,
    };
    const repository = {
      repoId: "repo_cloned", path: "C:/projects/Hello-World", head: null, branch: "main", detached: false,
      state: "normal", isFavorite: false, lastAccessedAt: 2, availability: "available",
    };
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-GitCrest-API-Version": "1" } });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/version")) return response({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 });
      if (url.endsWith("/api/v1/repositories") && init?.method === "POST") return response(repository);
      if (url.endsWith("/api/v1/repositories")) return response([]);
      if (url.endsWith("/api/v1/clones")) return response(task, 202);
      if (url.endsWith("/api/v1/tasks")) return response([task]);
      if (url.endsWith("/api/v1/repositories/repo_cloned/status")) return response({ repoId: "repo_cloned", refreshedAtMs: 2, files: [] });
      if (url.endsWith("/api/v1/repositories/repo_cloned")) return response(repository);
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: /^Clone repository$/ }));
    const dialog = screen.getByRole("dialog", { name: "Clone repository" });
    fireEvent.change(within(dialog).getByLabelText("Remote URL"), { target: { value: "https://github.com/octocat/Hello-World.git" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(within(dialog).getByText("C:/projects")).toBeDefined());
    fireEvent.click(within(dialog).getByRole("button", { name: "Start clone" }));

    await waitFor(() => expect(screen.getByText("C:/projects/Hello-World")).toBeDefined());
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/v1/clones"))).toBe(true);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith("/api/v1/repositories/repo_cloned/status"))).toBe(true);
  });

  it("opens the selected local repository and shows its workspace context", async () => {
    const repository = {
      repoId: "repo_fixture",
      path: "C:/fixture",
      head: null,
      branch: "main",
      detached: false,
      state: "normal",
      isFavorite: false,
      lastAccessedAt: 10,
      availability: "available",
    };
    const chooseRepository = vi.fn().mockResolvedValue("C:/fixture");
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository,
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(repository), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repoId: repository.repoId, refreshedAtMs: 1, files: [
        { path: "README.md", indexStatus: "M", worktreeStatus: "M", kind: "modified", categories: ["staged", "unstaged"], modeChanged: false },
        { path: "src/new-name.ts", originalPath: "src/old-name.ts", indexStatus: "R", worktreeStatus: ".", kind: "renamed", categories: ["staged"], modeChanged: false },
        { path: "scripts/tool.sh", indexStatus: ".", worktreeStatus: "M", kind: "modified", categories: ["unstaged"], modeChanged: true },
        { path: "new file.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked", categories: ["untracked"], modeChanged: false },
        { path: "conflict.txt", indexStatus: "U", worktreeStatus: "U", kind: "conflicted", categories: ["conflicted"], modeChanged: false },
        { path: "ignored.log", indexStatus: "!", worktreeStatus: "!", kind: "ignored", categories: ["ignored"], modeChanged: false },
      ] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "REPOSITORY_STATUS_FAILED", message: "Git status failed." } }), { status: 500, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ taskId: "task-fetch", repoId: repository.repoId, operation: "fetch", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ taskId: "task-fetch", repoId: repository.repoId, operation: "fetch", status: "running", phase: "Receiving objects", progress: 35, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false }]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    expect(await screen.findByText("C:/fixture", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(chooseRepository).toHaveBeenCalledOnce();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ path: "C:/fixture" });
    expect(String(fetcher.mock.calls[3][0])).toContain("/api/v1/repositories/repo_fixture/status");
    expect(screen.getByText("main", { selector: ".navEmpty" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Staged changes" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Unstaged changes" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Untracked changes" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Conflicted changes" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Ignored changes" })).toBeDefined();
    expect(screen.getByText("scripts/tool.sh")).toBeDefined();
    expect(screen.getByText("mode", { exact: true })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh working tree status" }));
    expect(await screen.findByText("Refresh failed. Showing the last snapshot.")).toBeDefined();
    expect(screen.getByText("new file.txt")).toBeDefined();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Fetch from remotes/ }));
    const taskDialog = await screen.findByRole("dialog", { name: "Tasks" });
    expect(await within(taskDialog).findByText("Receiving objects")).toBeDefined();
    expect(String(fetcher.mock.calls[5][0])).toContain("/api/v1/repositories/repo_fixture/fetch");
    expect(fetcher.mock.calls[5][1]?.method).toBe("POST");
  });

  it("shows persisted repositories in Welcome and lets the user favorite or forget them", async () => {
    const repository = {
      repoId: "repo_fixture", path: "C:/project", head: null, branch: "main", detached: false,
      state: "normal", isFavorite: false, lastAccessedAt: 10, availability: "available",
    };
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([repository]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...repository, isFavorite: true }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Recent repositories" })).toBeDefined();
    expect(await screen.findByText("C:/project")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Favorite project" }));
    expect(await screen.findByRole("button", { name: "Remove project from favorites" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove project from recent repositories" }));
    await waitFor(() => expect(screen.queryByText("C:/project")).toBeNull());
    expect(String(fetcher.mock.calls[2][0])).toBe("http://127.0.0.1:43210/api/v1/repositories/repo_fixture/favorite");
    expect(fetcher.mock.calls[3][1]?.method).toBe("DELETE");
  });

  it("initializes only the folder explicitly returned by the folder picker", async () => {
    const repository = {
      repoId: "repo_new", path: "C:/new-project", head: null, branch: "main", detached: false,
      state: "normal", isFavorite: false, lastAccessedAt: 10, availability: "available",
    };
    const chooseRepository = vi.fn().mockResolvedValue("C:/new-project");
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository,
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(repository), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repoId: repository.repoId, refreshedAtMs: 1, files: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Recent repositories" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Initialize a repository/ }));
    expect(await screen.findByText("C:/new-project", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(chooseRepository).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[2][0])).toBe("http://127.0.0.1:43210/api/v1/repositories/initialize");
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ path: "C:/new-project" });
  });

  it("opens a structured split diff from Changes and preserves the selected file", async () => {
    window.localStorage.setItem("gitcrest-workspace-session-v1", JSON.stringify({
      openRepoIds: ["repo_diff"], activeRepoId: "repo_diff", tabs: { repo_diff: { mode: "graph", graphScrollTop: 0 } },
    }));
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    const repository = { repoId: "repo_diff", path: "C:/diff-fixture", head: "abc123", branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const status = { repoId: "repo_diff", refreshedAtMs: 1, files: [{ path: "readme.txt", indexStatus: ".", worktreeStatus: "M", kind: "modified", categories: ["unstaged"], modeChanged: false }] };
    const document = {
      repoId: "repo_diff", path: "readme.txt", revision: "sha256:fixture", originalPath: null, scope: "workingTree", changeKind: "modified", status: "text",
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "old content", newText: "new content" }] }],
    };
    const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }));
      if (url.pathname === "/api/v1/repositories") return response([repository]);
      if (url.pathname.endsWith("/status")) return response(status);
      if (url.pathname.endsWith("/diff")) return response(document);
      if (url.pathname.endsWith("/staging")) return new Response(JSON.stringify({ taskId: "task-stage", repoId: "repo_diff", operation: "stageFile", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
      if (url.pathname.endsWith("/staging/patch")) return new Response(JSON.stringify({ taskId: "task-hunks", repoId: "repo_diff", operation: "stageHunks", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
      if (url.pathname.endsWith("/tasks")) return response([]);
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click((await screen.findAllByRole("button", { name: /readme\.txt/ }))[0]);
    expect(await screen.findByText("old content")).toBeDefined();
    expect(screen.getByText("new content")).toBeDefined();
    expect(screen.getByText("WORKING TREE ↔ INDEX")).toBeDefined();
    expect(screen.queryByRole("complementary", { name: "Commit details" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByRole("complementary", { name: "Commit details" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Diff" }));
    expect(await screen.findByText("new content")).toBeDefined();
    expect(fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname.endsWith("/diff")).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select hunk 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Stage selected changes" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith("/staging/patch"))).toBe(true));
    const stageRequest = fetcher.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith("/staging/patch"));
    expect(JSON.parse(String(stageRequest?.[1]?.body))).toEqual({ action: "stage", path: "readme.txt", scope: "workingTree", revision: "sha256:fixture", selections: [{ hunkIndex: 0 }] });
  });

  it("restores repository tabs independently and closes tabs without deleting repositories", async () => {
    window.localStorage.setItem("gitcrest-workspace-session-v1", JSON.stringify({
      openRepoIds: ["repo_alpha", "repo_beta"],
      activeRepoId: "repo_alpha",
      tabs: {
        repo_alpha: { mode: "diff", selectedCommit: "abc123", graphScrollTop: 147 },
        repo_beta: { mode: "graph", selectedCommit: "def456", graphScrollTop: 23 },
      },
    }));
    window.localStorage.setItem("gitcrest-layout-repo_alpha-sidebar-width", "270");
    window.localStorage.setItem("gitcrest-layout-repo_beta-sidebar-width", "310");
    const repositories = [
      { repoId: "repo_alpha", path: "C:/alpha", head: "abc123", branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 2, availability: "available" },
      { repoId: "repo_beta", path: "C:/beta", head: "def456", branch: "feature", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" },
    ];
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(repositories), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repoId: "repo_alpha", refreshedAtMs: 1, files: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(repositories[1]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repoId: "repo_beta", refreshedAtMs: 2, files: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(repositories), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repoId: "repo_beta", refreshedAtMs: 3, files: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repoId: "repo_alpha", refreshedAtMs: 4, files: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    const firstRun = render(<App />);
    expect(await screen.findByText("C:/alpha", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "alpha" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "Diff" }).className).toContain("active");
    expect(screen.queryByRole("complementary", { name: "Commit details" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    expect(screen.getByText("abc123", { selector: ".repositoryFact strong" })).toBeDefined();
    expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("270");

    fireEvent.click(screen.getByRole("button", { name: "Graph" }));
    const graphViewport = screen.getByRole("region", { name: "Commit graph view" });
    Object.defineProperty(graphViewport, "scrollTop", { configurable: true, writable: true, value: 193 });
    fireEvent.scroll(graphViewport);
    expect(JSON.parse(window.localStorage.getItem("gitcrest-workspace-session-v1") || "{}").tabs.repo_alpha.graphScrollTop).toBe(193);

    fireEvent.click(screen.getByRole("tab", { name: "beta" }));
    expect(await screen.findByText("C:/beta", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("310"));
    expect(screen.getByRole("button", { name: "Graph" }).className).toContain("active");
    const savedSession = JSON.parse(window.localStorage.getItem("gitcrest-workspace-session-v1") || "{}");
    expect(savedSession.activeRepoId).toBe("repo_beta");
    expect(savedSession.tabs.repo_alpha).toMatchObject({ selectedCommit: "abc123", graphScrollTop: 193 });
    expect(savedSession.tabs.repo_beta).toMatchObject({ selectedCommit: "def456", graphScrollTop: 23 });

    firstRun.unmount();
    render(<App />);
    expect(await screen.findByText("C:/beta", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "beta" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("310"));
    expect((screen.getByRole("region", { name: "Commit graph view" }) as HTMLDivElement).scrollTop).toBe(23);

    fireEvent.click(screen.getByRole("button", { name: "Close beta tab" }));
    expect(screen.getByText("C:/alpha", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("270"));
    expect((screen.getByRole("region", { name: "Commit graph view" }) as HTMLDivElement).scrollTop).toBe(193);
    fireEvent.click(screen.getByRole("button", { name: "Close alpha tab" }));
    expect(await screen.findByRole("heading", { name: "Recent repositories" })).toBeDefined();
    expect(screen.getByText("C:/alpha")).toBeDefined();
    expect(screen.getByText("C:/beta")).toBeDefined();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(9));
  });

  it("cycles themes and exposes keyboard-adjustable panel separators", async () => {
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      name: "gitcrest-core", version: "0.1.0", apiVersion: 1,
    }), { status: 200 })));

    render(<App />);
    const themeButton = screen.getByRole("button", { name: /Color theme/ });
    fireEvent.click(themeButton);
    await waitFor(() => expect(["light", "dark"]).toContain(document.documentElement.dataset.theme));

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const separator = screen.getByRole("separator", { name: "Resize repository navigation" });
    const originalWidth = Number(separator.getAttribute("aria-valuenow"));
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(originalWidth + 16);
  });
});
