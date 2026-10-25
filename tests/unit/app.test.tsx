// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import App from "../../src/app/App";

vi.mock("../../src/features/diff/ui/MonacoFileDiff", () => ({
  MonacoFileDiff: (props: { original: string; modified: string; label: string }) => createElement(
    "pre",
    { "aria-label": props.label },
    `${props.original}||${props.modified}`,
  ),
}));

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

  it("reloads the task list as soon as a task finishes instead of waiting for the poll", async () => {
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
    const fetcher = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/api/version")
      ? new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 })
      : new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByText("Core connected")).toBeDefined();
    await waitFor(() => expect(subscribeToEvents).toHaveBeenCalledOnce());
    const taskRequests = () => fetcher.mock.calls.filter(([input]) => String(input).endsWith("/api/v1/tasks")).length;
    const before = taskRequests();

    onEvent?.({ ...resyncEvent, eventId: "event-2", type: "task.completed", repoId: "repo_a", payload: {} });
    await waitFor(() => expect(taskRequests()).toBe(before + 1));
  });

  it("opens a keyboard-accessible command palette with reasons for unavailable actions", async () => {
    const chooseRepository = vi.fn().mockResolvedValue(undefined);
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
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "gitcrest-core", version: "0.1.0", apiVersion: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));

    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeDefined();
    const search = within(dialog).getByRole("textbox", { name: "Search commands" });
    await waitFor(() => expect(document.activeElement).toBe(search));
    const openCommand = within(dialog).getByRole("button", { name: /Open local repository/ }) as HTMLButtonElement;
    expect(openCommand.disabled).toBe(false);
    expect(within(dialog).getByRole("button", { name: /Clone repository/ })).toBeDefined();
    // AI assistance is deferred, so the palette offers no AI command.
    expect(within(dialog).queryByRole("button", { name: /Generate commit message suggestion/ })).toBeNull();
    fireEvent.keyDown(openCommand, { key: "o", ctrlKey: true });
    expect(chooseRepository).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
    fireEvent.keyDown(window, { key: "o", ctrlKey: true });
    await waitFor(() => expect(chooseRepository).toHaveBeenCalledOnce());
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
    const dialog = await screen.findByRole("dialog", { name: "Clone repository" });
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
    const branchSnapshot = { repoId: repository.repoId, current: "main", detached: false, branches: [
      { name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
    ] };
    const favoriteBranchSnapshot = { ...branchSnapshot, branches: [{ ...branchSnapshot.branches[0], isFavorite: true }] };
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
    const statusFiles = [
      { path: "README.md", indexStatus: "M", worktreeStatus: "M", kind: "modified", categories: ["staged", "unstaged"], modeChanged: false },
      { path: "src/new-name.ts", originalPath: "src/old-name.ts", indexStatus: "R", worktreeStatus: ".", kind: "renamed", categories: ["staged"], modeChanged: false },
      { path: "scripts/tool.sh", indexStatus: ".", worktreeStatus: "M", kind: "modified", categories: ["unstaged"], modeChanged: true },
      { path: "new file.txt", indexStatus: "?", worktreeStatus: "?", kind: "untracked", categories: ["untracked"], modeChanged: false },
      { path: "conflict.txt", indexStatus: "U", worktreeStatus: "U", kind: "conflicted", categories: ["conflicted"], modeChanged: false },
      { path: "ignored.log", indexStatus: "!", worktreeStatus: "!", kind: "ignored", categories: ["ignored"], modeChanged: false },
    ];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-GitCrest-API-Version": "1" } });
    let statusReads = 0;
    let favorite = false;
    let opened = false;
    // Routed by URL: which panels load data depends on the active view, so call order is not fixed.
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const path = url.pathname;
      if (path === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 });
      if (path === "/api/v1/repositories" && method === "POST") { opened = true; return json(repository); }
      if (path === "/api/v1/repositories") return json(opened ? [repository] : []);
      if (path.endsWith("/status")) {
        statusReads += 1;
        return statusReads === 1 ? json({ repoId: repository.repoId, refreshedAtMs: 1, files: statusFiles }) : json({ error: { code: "REPOSITORY_STATUS_FAILED", message: "Git status failed." } }, 500);
      }
      if (path.endsWith("/branches/favorite")) { favorite = true; return json(favoriteBranchSnapshot); }
      if (path.endsWith("/branches")) return json(favorite ? favoriteBranchSnapshot : branchSnapshot);
      if (path.endsWith("/remotes")) return json({ repoId: repository.repoId, defaultRemote: null, remotes: [] });
      if (path.endsWith("/worktrees")) return json({ repoId: repository.repoId, worktrees: [{ path: "C:/fixture", head: null, branch: "main", detached: false, locked: false, prunable: false, isCurrent: true }] });
      if (path.endsWith("/fetch") && method === "POST") return json({ taskId: "task-fetch", repoId: repository.repoId, operation: "fetch", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false }, 202);
      if (path === "/api/v1/tasks") return json([{ taskId: "task-fetch", repoId: repository.repoId, operation: "fetch", status: "running", phase: "Receiving objects", progress: 35, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false }]);
      if (path.includes("adopt")) return json({ adopted: false, task: null });
      return json([]);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    expect(await screen.findByText("C:/fixture", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(chooseRepository).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetcher.mock.calls.find(([input, init]) => new URL(String(input)).pathname === "/api/v1/repositories" && init?.method === "POST")?.[1]?.body))).toEqual({ path: "C:/fixture" });
    // A repository opens in Changes: changed files grouped by state, conflicts first; no branch list here.
    expect(screen.getByRole("tab", { name: /Workspace/ }).getAttribute("aria-selected")).toBe("true");
    // Tracked changes share one group; a checkbox per file says whether it is staged.
    const changes = await screen.findByRole("region", { name: "Changes" });
    expect(screen.getByRole("region", { name: "Unversioned Files" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Merge Conflicts" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Ignored Files" })).toBeDefined();
    expect(within(changes).getByText("3 files")).toBeDefined();
    const readme = within(changes).getByRole("checkbox", { name: "Stage README.md" }) as HTMLInputElement;
    expect(readme.indeterminate).toBe(true);
    expect((within(changes).getByRole("checkbox", { name: "Stage src/new-name.ts" }) as HTMLInputElement).checked).toBe(true);
    expect((within(changes).getByRole("checkbox", { name: "Stage scripts/tool.sh" }) as HTMLInputElement).checked).toBe(false);
    // Ignored files are folded away, and conflicts cannot be staged from a checkbox.
    expect(screen.queryByRole("button", { name: "ignored ignored.log" })).toBeNull();
    expect(within(screen.getByRole("region", { name: "Merge Conflicts" })).queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "modified scripts/tool.sh" })).toBeDefined();
    expect(screen.getByRole("button", { name: "untracked new file.txt" })).toBeDefined();
    expect(screen.getByText("mode", { exact: true })).toBeDefined();
    expect(screen.queryByRole("list", { name: "Repository branches" })).toBeNull();
    // The conflict is announced above every view.
    expect(screen.getByText("1 conflicted file")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Refresh working tree status" }));
    expect(await screen.findByText("Refresh failed. Showing the last snapshot.")).toBeDefined();
    expect(screen.getByText("new file.txt")).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByText("main", { selector: ".branchItemName" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Add refs/heads/main to favorites" }));
    expect(await screen.findByRole("button", { name: "Remove refs/heads/main from favorites" })).toBeDefined();
    expect(fetcher.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith("/branches/favorite"))?.[1]?.method).toBe("PUT");
    // Without remotes there is nothing to fetch, pull or push from the toolbar; the palette still offers Fetch.
    expect(screen.getByText("No remotes")).toBeDefined();
    expect(screen.queryByRole("group", { name: "Synchronize with remotes" })).toBeNull();

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Fetch from remotes/ }));
    const taskDialog = await screen.findByRole("dialog", { name: "Tasks" });
    expect(await within(taskDialog).findByText("Receiving objects")).toBeDefined();
    const fetchRequest = fetcher.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith("/repositories/repo_fixture/fetch"));
    expect(String(fetchRequest?.[0])).toContain("/api/v1/repositories/repo_fixture/fetch");
    expect(fetchRequest?.[1]?.method).toBe("POST");
  });

  it("previews dirty work before a branch switch and queues the switch after a clean preflight", async () => {
    const repository = { repoId: "repo_switch", path: "C:/switch", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const branches = { repoId: repository.repoId, current: "main", detached: false, branches: [
      { name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
      { name: "feature/test", fullName: "refs/heads/feature/test", oid: "b".repeat(40), kind: "local", isCurrent: false, isFavorite: true, upstream: null, upstreamGone: false, ahead: null, behind: null },
    ] };
    const task = { taskId: "task-switch", repoId: repository.repoId, operation: "branchSwitch", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository: vi.fn().mockResolvedValue(repository.path),
      },
    });
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-GitCrest-API-Version": "1" } });
    let preflightCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }));
      if (url.pathname === "/api/v1/repositories" && init?.method === "POST") return response(repository);
      if (url.pathname === "/api/v1/repositories") return response([]);
      if (url.pathname === "/api/v1/tasks") return response([task]);
      if (url.pathname === `/api/v1/repositories/${repository.repoId}`) return response(repository);
      if (url.pathname.endsWith("/status")) return response({ repoId: repository.repoId, refreshedAtMs: 1, files: [] });
      if (url.pathname.endsWith("/branches") && !url.pathname.includes("/switch")) return response(branches);
      if (url.pathname.endsWith("/branches/switch-preflight")) {
        preflightCount += 1;
        return response(preflightCount <= 2
          ? { repoId: repository.repoId, current: "main", target: "feature/test", isClean: false, dirtyFiles: ["src/working.ts"], potentiallyOverwrittenPaths: ["src/working.ts"] }
          : { repoId: repository.repoId, current: "main", target: "feature/test", isClean: false, dirtyFiles: ["docs/notes.md"], potentiallyOverwrittenPaths: [] });
      }
      if (url.pathname.endsWith("/branches/switch")) return response(task, 202);
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("C:/switch", { selector: ".workspaceCrumb .mutedText" });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    const closeBranchSwitcher = within(dialog).getByRole("button", { name: "Close branch switcher" });
    await waitFor(() => expect(document.activeElement).toBe(closeBranchSwitcher));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch branch" })).toBeNull());
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    const reopenedDialog = await screen.findByRole("dialog", { name: "Switch branch" });
    fireEvent.click(within(reopenedDialog).getByRole("button", { name: /feature\/test/ }));
    expect(await within(reopenedDialog).findByText("src/working.ts")).toBeDefined();
    expect(within(reopenedDialog).getByText("May be overwritten")).toBeDefined();
    expect((within(reopenedDialog).getByRole("button", { name: "Shelve & switch" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(reopenedDialog).getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(reopenedDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch branch" })).toBeNull());
    expect(fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith("/branches/switch"))).toBe(false);
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    const commitDialog = await screen.findByRole("dialog", { name: "Switch branch" });
    fireEvent.click(within(commitDialog).getByRole("button", { name: /feature\/test/ }));
    expect(await within(commitDialog).findByText("src/working.ts")).toBeDefined();
    fireEvent.click(within(commitDialog).getByRole("button", { name: "Commit changes" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch branch" })).toBeNull());
    fireEvent.click(screen.getByTitle(/Switch branches/));
    const secondDialog = await screen.findByRole("dialog", { name: "Switch branch" });
    fireEvent.click(within(secondDialog).getByRole("button", { name: /feature\/test/ }));
    await within(secondDialog).findByText("docs/notes.md");
    const continueSwitch = within(secondDialog).getByRole("button", { name: "Continue" });
    expect((continueSwitch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueSwitch);
    expect(await screen.findByRole("dialog", { name: "Tasks" })).toBeDefined();
    expect(fetcher.mock.calls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/branches/switch") && init?.method === "POST")).toBe(true);
  });

  it("switches or merges a branch straight from the sidebar branch row", async () => {
    const repository = { repoId: "repo_rows", path: "C:/rows", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const branch = (name: string, oid: string, isCurrent: boolean) => ({ name, fullName: `refs/heads/${name}`, oid, kind: "local", isCurrent, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null });
    const branches = { repoId: repository.repoId, current: "main", detached: false, branches: [branch("main", "a".repeat(40), true), branch("feature/row", "b".repeat(40), false)] };
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository: vi.fn().mockResolvedValue(repository.path),
      },
    });
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-GitCrest-API-Version": "1" } });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }));
      if (url.pathname === "/api/v1/repositories" && init?.method === "POST") return response(repository);
      if (url.pathname === "/api/v1/repositories") return response([]);
      if (url.pathname === "/api/v1/tasks") return response([]);
      if (url.pathname === `/api/v1/repositories/${repository.repoId}`) return response(repository);
      if (url.pathname.endsWith("/status")) return response({ repoId: repository.repoId, refreshedAtMs: 1, files: [] });
      if (url.pathname.endsWith("/branches")) return response(branches);
      if (url.pathname.endsWith("/remotes")) return response({ repoId: repository.repoId, defaultRemote: null, remotes: [] });
      if (url.pathname.endsWith("/worktrees")) return response({ repoId: repository.repoId, worktrees: [] });
      if (url.pathname.endsWith("/commits") || url.pathname.endsWith("/refs")) return response([]);
      if (url.pathname.endsWith("/branches/switch-preflight")) return response({ repoId: repository.repoId, current: "main", target: "feature/row", isClean: true, dirtyFiles: [], potentiallyOverwrittenPaths: [] });
      if (url.pathname.endsWith("/workflows/preflight")) return response({ repoId: repository.repoId, action: "merge", targetOid: "b".repeat(40), targetSubject: "Row commit", headOid: "a".repeat(40), isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], operationInProgress: null, canStart: true });
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("C:/rows", { selector: ".workspaceCrumb .mutedText" });
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.queryByRole("button", { name: "Switch to main" })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Switch to feature/row" }));
    const dialog = await screen.findByRole("dialog", { name: "Switch branch" });
    expect(await within(dialog).findByText("The working tree is clean. GitCrest can switch to this branch.")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Switch branch" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Merge refs/heads/feature/row into the current branch" }));
    expect(await screen.findByText("Row commit")).toBeDefined();
    expect(fetcher.mock.calls.some(([input]) => String(input).includes("action=merge") && String(input).includes("b".repeat(40)))).toBe(true);

    // Choosing a branch narrows the commit graph to its history until the scope is cleared.
    const commitsRequests = () => fetcher.mock.calls.map(([input]) => new URL(String(input))).filter((url) => url.pathname.endsWith("/commits"));
    const lastCommitsRequest = () => commitsRequests()[commitsRequests().length - 1];
    expect(commitsRequests().every((url) => !url.searchParams.has("branch"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Show history of feature/row" }));
    await waitFor(() => expect(lastCommitsRequest()?.searchParams.get("branch")).toBe("feature/row"));
    // The branch tip becomes the selected commit, whose changes show under the graph.
    expect(screen.getByRole("region", { name: "Commit graph" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Changes in the selected commit" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Show history of feature/row" }).getAttribute("aria-pressed")).toBe("true");
    const requestsBefore = commitsRequests().length;
    fireEvent.click(screen.getByRole("button", { name: "Show all branches" }));
    await waitFor(() => expect(commitsRequests().length).toBeGreaterThan(requestsBefore));
    expect(lastCommitsRequest()?.searchParams.has("branch")).toBe(false);
    expect(screen.queryByRole("button", { name: "Show all branches" })).toBeNull();
  });

  it("continues a reviewed branch switch after the selected changes are shelved", async () => {
    const repository = { repoId: "repo_auto_shelf", path: "C:/auto-shelf", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const branches = { repoId: repository.repoId, current: "main", detached: false, branches: [
      { name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
      { name: "feature/auto", fullName: "refs/heads/feature/auto", oid: "b".repeat(40), kind: "local", isCurrent: false, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
    ] };
    const shelfTask = { taskId: "task-auto-shelf", repoId: repository.repoId, operation: "shelfCreate", status: "queued", phase: "Saving shelf", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const switchTask = { ...shelfTask, taskId: "task-auto-switch", operation: "branchSwitch", phase: "Switching branch" };
    const restoreTask = { ...shelfTask, taskId: "task-auto-restore", operation: "shelfApply:shelf_new", phase: "Restoring shelf" };
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository: vi.fn().mockResolvedValue(repository.path),
      },
    });
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-GitCrest-API-Version": "1" } });
    let shelfCreated = false;
    let branchSwitched = false;
    let createdShelf: Record<string, unknown> | undefined;
    let preflightCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }));
      if (url.pathname === "/api/v1/repositories" && init?.method === "POST") return response(repository);
      if (url.pathname === "/api/v1/repositories") return response([]);
      if (url.pathname === "/api/v1/tasks") return response([
        ...(shelfCreated ? [{ ...shelfTask, status: "succeeded" }] : []),
        ...(branchSwitched ? [{ ...switchTask, status: "succeeded" }] : []),
      ]);
      if (url.pathname === `/api/v1/repositories/${repository.repoId}`) return response(repository);
      if (url.pathname.endsWith("/status")) return response({ repoId: repository.repoId, refreshedAtMs: 1, files: shelfCreated ? [] : [{ path: "src/working.ts", indexStatus: ".", worktreeStatus: "M", kind: "modified", categories: ["unstaged"], modeChanged: false }] });
      if (url.pathname.endsWith("/branches") && !url.pathname.includes("/switch")) return response(branches);
      if (url.pathname.endsWith("/branches/switch-preflight")) {
        preflightCount += 1;
        return response(preflightCount === 1
          ? { repoId: repository.repoId, current: "main", target: "feature/auto", isClean: false, dirtyFiles: ["src/working.ts"], potentiallyOverwrittenPaths: ["src/working.ts"] }
          : { repoId: repository.repoId, current: "main", target: "feature/auto", isClean: true, dirtyFiles: [], potentiallyOverwrittenPaths: [] });
      }
      if (url.pathname.endsWith("/diff")) return response({ repoId: repository.repoId, path: "src/working.ts", revision: "r1", originalPath: null, scope: "workingTree", changeKind: "modified", status: "text", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "old", newText: "new" }] }] });
      if (url.pathname.endsWith("/shelves") && init?.method === "POST") {
        shelfCreated = true;
        createdShelf = { shelfId: "shelf_new", repoId: repository.repoId, name: "before feature/auto", description: "", paths: ["src/working.ts"], scope: "workingTree", headOid: repository.head, createdAtMs: 2 };
        return response(shelfTask, 202);
      }
      if (url.pathname.endsWith("/shelves")) return response(createdShelf ? [createdShelf] : []);
      if (url.pathname.endsWith("/shelf_new/apply-preview")) return response({ repoId: repository.repoId, shelf: createdShelf, expectedHeadOid: repository.head, previewRevision: "preview-1", canApplyCleanly: true, canApplyWithConflicts: true, conflictingPaths: [] });
      if (url.pathname.endsWith("/shelf_new/apply") && init?.method === "POST") return response(restoreTask, 202);
      if (url.pathname.endsWith("/branches/switch")) {
        branchSwitched = true;
        return response(switchTask, 202);
      }
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));
    await screen.findByText("C:/auto-shelf", { selector: ".workspaceCrumb .mutedText" });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    const switchDialog = await screen.findByRole("dialog", { name: "Switch branch" });
    fireEvent.click(within(switchDialog).getByRole("button", { name: /feature\/auto/ }));
    await within(switchDialog).findByText("src/working.ts");
    fireEvent.click(within(switchDialog).getByRole("button", { name: "Shelve & switch" }));

    const shelfDialog = await screen.findByRole("dialog", { name: "Shelve selected changes" });
    expect(within(shelfDialog).getByRole("status").textContent).toContain("feature/auto");
    fireEvent.click(within(shelfDialog).getByRole("checkbox"));
    await within(shelfDialog).findByText(/Whole file selected/);
    fireEvent.change(within(shelfDialog).getByRole("textbox", { name: "Name" }), { target: { value: "before feature/auto" } });
    fireEvent.click(within(shelfDialog).getByRole("button", { name: "Create shelf" }));

    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/shelf_new/apply") && init?.method === "POST"), JSON.stringify(fetcher.mock.calls.map(([input, init]) => [new URL(String(input)).pathname, init?.method]))).toBe(true), { timeout: 10000 });
    expect(fetcher.mock.calls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/shelves") && init?.method === "POST")).toBe(true);
    expect(fetcher.mock.calls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/branches/switch") && init?.method === "POST")).toBe(true);
  }, 15000);

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
    // Removing deletes the shelves GitCrest keeps for the repository, so nothing is sent before confirming.
    const confirmation = screen.getByRole("alertdialog", { name: "Remove “project” from recent repositories?" });
    expect(confirmation.textContent).toContain("Shelved changes cannot be recovered");
    fireEvent.click(screen.getByRole("button", { name: "Keep repository" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove project from recent repositories" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove and delete shelves" }));
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
      openRepoIds: ["repo_diff"], activeRepoId: "repo_diff", tabs: { repo_diff: { mode: "history", graphScrollTop: 0 } },
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
    // History never shows the working tree or the commit composer.
    expect(await screen.findByRole("tab", { name: "History", selected: true })).toBeDefined();
    expect(screen.queryByRole("region", { name: "Commit" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Workspace/ }));
    fireEvent.click((await screen.findAllByRole("button", { name: /readme\.txt/ }))[0]);
    expect((await screen.findByLabelText("Side-by-side comparison of readme.txt")).textContent).toBe("old content||new content");
    expect(screen.getByText("Your version")).toBeDefined();
    const diffQueries = () => fetcher.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith("/diff"))
      .map((url) => url.searchParams.get("context"));
    expect(diffQueries()).toEqual(["full"]);
    expect(screen.queryByRole("complementary", { name: "Commit details" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Select lines…" }));
    expect(await screen.findByText((_, element) => element?.tagName === "CODE" && element.textContent === "old content")).toBeDefined();
    expect(diffQueries()).toEqual(["full", null]);
    expect(screen.getByText((_, element) => element?.tagName === "CODE" && element.textContent === "new content")).toBeDefined();
    expect(screen.getByText("WORKING TREE ↔ INDEX")).toBeDefined();
    expect(screen.queryByRole("complementary", { name: "Commit details" })).toBeNull();

    // The commit form sits under the file list whenever there is something to commit.
    const composer = screen.getByRole("region", { name: "Commit" });
    expect(within(composer).getByRole("textbox", { name: "Commit description (optional)" })).toBeDefined();
    expect((within(composer).getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(screen.queryByRole("region", { name: "Commit" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Workspace/ }));
    expect(await screen.findByText((_, element) => element?.tagName === "CODE" && element.textContent === "new content")).toBeDefined();
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
    let onEvent: ((event: components["schemas"]["EventEnvelope"]) => void) | undefined;
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async (listener: typeof onEvent) => { onEvent = listener; return vi.fn(); }),
      },
    });
    const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }));
      if (url.pathname === "/api/v1/repositories") return response(repositories);
      if (url.pathname === "/api/v1/repositories/repo_alpha") return response(repositories[0]);
      if (url.pathname === "/api/v1/repositories/repo_beta") return response(repositories[1]);
      if (url.pathname.endsWith("/status")) return response({ repoId: url.pathname.includes("repo_alpha") ? "repo_alpha" : "repo_beta", refreshedAtMs: 1, files: [] });
      if (url.pathname.endsWith("/remotes")) return response({ repoId: url.pathname.includes("repo_alpha") ? "repo_alpha" : "repo_beta", defaultRemote: null, remotes: [] });
      if (url.pathname.endsWith("/shelves")) return response([]);
      if (url.pathname.endsWith("/branches")) {
        const repoId = url.pathname.includes("repo_alpha") ? "repo_alpha" : "repo_beta";
        const branchName = repoId === "repo_alpha" ? "main" : "feature";
        return response({ repoId, current: branchName, detached: false, branches: [
          { name: branchName, fullName: `refs/heads/${branchName}`, oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: false, upstream: null, upstreamGone: false, ahead: null, behind: null },
        ] });
      }
      throw new Error(`Unexpected API request: ${url}`);
    });
    vi.stubGlobal("fetch", fetcher);

    const firstRun = render(<App />);
    expect(await screen.findByText("C:/alpha", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "alpha" }).getAttribute("aria-selected")).toBe("true");
    // A tab saved in the old Diff mode reopens in Changes, which has no commit inspector.
    expect(screen.getByRole("tab", { name: /Workspace/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("complementary", { name: "Commit details" })).toBeNull();
    const separator = screen.getByRole("separator", { name: "Resize repository navigation" });
    expect(separator.getAttribute("aria-valuenow")).toBe("270");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator.getAttribute("aria-valuenow")).toBe("286");
    fireEvent.keyDown(separator, { key: "ArrowLeft" });

    fireEvent.click(screen.getByRole("tab", { name: "beta" }));
    expect(await screen.findByText("C:/beta", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    // The old Graph mode reopens in History; each tab keeps its own view.
    expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
    // History's branch list shares the repository navigation width with Changes.
    expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("310");
    fireEvent.click(screen.getByRole("tab", { name: /Workspace/ }));
    await waitFor(() => expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("310"));
    const savedSession = JSON.parse(window.localStorage.getItem("gitcrest-workspace-session-v1") || "{}");
    expect(savedSession.activeRepoId).toBe("repo_beta");
    expect(savedSession.tabs.repo_alpha).toMatchObject({ mode: "changes", selectedCommit: "abc123", graphScrollTop: 147 });
    expect(savedSession.tabs.repo_beta).toMatchObject({ mode: "changes", selectedCommit: "def456", graphScrollTop: 23 });

    firstRun.unmount();
    render(<App />);
    expect(await screen.findByText("C:/beta", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(screen.getByRole("tab", { name: "beta" }).getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("310"));

    fireEvent.click(screen.getByRole("button", { name: "Close beta tab" }));
    expect(screen.getByText("C:/alpha", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    await waitFor(() => expect(screen.getByRole("separator", { name: "Resize repository navigation" }).getAttribute("aria-valuenow")).toBe("270"));
    const closedBetaRequests = ["/status", "/branches", "/remotes"].map((suffix) => fetcher.mock.calls.filter(([input]) => {
      const url = new URL(String(input));
      return url.pathname.includes("repo_beta") && url.pathname.endsWith(suffix);
    }).length);
    act(() => {
      onEvent?.({ eventId: "event-4", protocolVersion: 1, repoId: "repo_beta", type: "status.changed", occurredAtMs: 4, payload: { full: false, paths: ["tracked.txt"] } });
      onEvent?.({ eventId: "event-5", protocolVersion: 1, repoId: "repo_beta", type: "log.refsChanged", occurredAtMs: 5, payload: {} });
      onEvent?.({ eventId: "event-6", protocolVersion: 1, repoId: "repo_beta", type: "repository.updated", occurredAtMs: 6, payload: {} });
    });
    await waitFor(() => expect(fetcher.mock.calls.filter(([input]) => new URL(String(input)).pathname === "/api/v1/repositories").length).toBeGreaterThan(2));
    expect(["/status", "/branches", "/remotes"].map((suffix) => fetcher.mock.calls.filter(([input]) => {
      const url = new URL(String(input));
      return url.pathname.includes("repo_beta") && url.pathname.endsWith(suffix);
    }).length)).toEqual(closedBetaRequests);
    fireEvent.click(screen.getByRole("button", { name: "Close alpha tab" }));
    expect(await screen.findByRole("heading", { name: "Recent repositories" })).toBeDefined();
    expect(screen.getByText("C:/alpha")).toBeDefined();
    expect(screen.getByText("C:/beta")).toBeDefined();
    expect(fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith("/branches"))).toBe(true);
  });

  it("submits a commit only after staged changes and a message are ready", async () => {
    window.localStorage.setItem("gitcrest-workspace-session-v1", JSON.stringify({
      openRepoIds: ["repo_commit"], activeRepoId: "repo_commit", tabs: { repo_commit: { mode: "changes", graphScrollTop: 0 } },
    }));
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    const repository = { repoId: "repo_commit", path: "C:/commit-fixture", head: "abc123", branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const snapshot = { repoId: "repo_commit", refreshedAtMs: 1, files: [{ path: ".env.local", indexStatus: "A", worktreeStatus: ".", kind: "added", categories: ["staged"], modeChanged: false }] };
    const stagedDiff = { repoId: "repo_commit", path: ".env.local", originalPath: null, scope: "index", revision: "sha256:staged-fixture", changeKind: "added", status: "text", hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1, rows: [{ kind: "change", oldLine: null, newLine: 1, oldText: null, newText: "SECRET=value" }] }] };
    const task = { taskId: "task-commit", repoId: "repo_commit", operation: "commit", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }));
      if (url.pathname === "/api/v1/repositories") return response([repository]);
      if (url.pathname.endsWith("/status")) return response(snapshot);
      if (url.pathname.endsWith("/diff")) return response(stagedDiff);
      if (url.pathname.endsWith("/tasks")) return response([]);
      if (url.pathname.endsWith("/commits")) return new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
      if (url.pathname.endsWith("/tasks/task-commit")) return response(task);
      throw new Error(`Unexpected API request: ${url} ${init?.method || "GET"}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(await screen.findByRole("tab", { name: "commit-fixture" }));
    fireEvent.click((await screen.findAllByRole("button", { name: /.env.local/ }))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "Select lines…" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select hunk 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Add to commit selection" }));
    expect(screen.getByText(/Other staged changes stay in the index/)).toBeDefined();
    const summary = await screen.findByRole("textbox", { name: "Commit message" });
    const description = screen.getByRole("textbox", { name: "Commit description (optional)" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit" }).hasAttribute("disabled")).toBe(true));
    expect(screen.getByText(/Review sensitive staged files/)).toBeDefined();
    fireEvent.change(description, { target: { value: "Loads local overrides before defaults.\n" } });
    expect(screen.getByRole("button", { name: "Commit" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: "Message template" }), { target: { value: "conventional" } });
    expect((summary as HTMLInputElement).value).toBe("feat: ");
    expect((description as HTMLTextAreaElement).value).toBe("Loads local overrides before defaults.\n");
    fireEvent.change(summary, { target: { value: "feat: add environment config" } });
    const commitButton = screen.getByRole("button", { name: "Commit" });
    await waitFor(() => expect(commitButton.hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("checkbox", { name: "Amend" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Sign-off" }));
    expect(screen.getByText(/Amend replaces the current HEAD commit/)).toBeDefined();
    fireEvent.click(commitButton);
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => new URL(String(input)).pathname.endsWith("/commits"))).toBe(true));
    const request = fetcher.mock.calls.find(([input]) => new URL(String(input)).pathname.endsWith("/commits"));
    expect(request?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      message: "feat: add environment config\n\nLoads local overrides before defaults.", amend: true, signOff: true, sign: false,
      selections: [{ path: ".env.local", revision: "sha256:staged-fixture", selections: [{ hunkIndex: 0 }] }],
    });
    expect(await screen.findByRole("dialog", { name: "Tasks" })).toBeDefined();
  });

  it("runs commit and push from Ctrl+Shift+Enter without waiting for a second commit", async () => {
    const repository = { repoId: "repo_combo", path: "C:/combo-fixture", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const branches = { repoId: repository.repoId, current: "main", detached: false, branches: [
      { name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, upstream: "origin/main", upstreamGone: false, ahead: 0, behind: 0, isFavorite: false },
      { name: "main", fullName: "refs/remotes/origin/main", oid: "a".repeat(40), kind: "remote", isCurrent: false, upstream: null, upstreamGone: false, ahead: null, behind: null, isFavorite: false },
    ] };
    const remotes = { repoId: repository.repoId, defaultRemote: "origin", remotes: [
      { name: "origin", fetchUrls: ["https://example.test/repo.git"], pushUrls: ["https://example.test/repo.git"], isDefault: true },
    ] };
    const status = { repoId: repository.repoId, refreshedAtMs: 1, files: [
      { path: "change.txt", indexStatus: "A", worktreeStatus: ".", kind: "added", categories: ["staged"], modeChanged: false },
    ] };
    const commitTask = { taskId: "task-commit-push", repoId: repository.repoId, operation: "commit", status: "succeeded", phase: "Complete", progress: 100, message: "Task completed", errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false };
    const pushTask = { taskId: "task-push-after-commit", repoId: repository.repoId, operation: "push", status: "succeeded", phase: "Complete", progress: 100, message: "Task completed", errorCategory: null, logs: [], createdAtMs: 2, updatedAtMs: 3, cancelRequested: false };
    const preview = {
      repoId: repository.repoId, localBranch: "main", remoteName: "origin", remoteBranch: "main",
      localOid: "b".repeat(40), expectedRemoteOid: "a".repeat(40), ahead: 1, behind: 0,
      commitsToPush: [{ oid: "b".repeat(40), subject: "new change" }], overwrittenCommitCount: 0,
      changedPaths: ["change.txt"], changedPathCount: 1, omittedChangedPathCount: 0,
    };
    window.localStorage.setItem("gitcrest-workspace-session-v1", JSON.stringify({
      openRepoIds: [repository.repoId], activeRepoId: repository.repoId, tabs: { [repository.repoId]: { mode: "changes", graphScrollTop: 0 } },
    }));
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "X-GitCrest-API-Version": "1" } });
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/version") return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }));
      if (url.pathname === "/api/v1/repositories" && init?.method !== "POST") return response([repository]);
      if (url.pathname === `/api/v1/repositories/${repository.repoId}`) return response(repository);
      if (url.pathname.endsWith("/status")) return response(status);
      if (url.pathname.endsWith("/branches")) return response(branches);
      if (url.pathname.endsWith("/remotes")) return response(remotes);
      if (url.pathname === "/api/v1/tasks") return response([]);
      if (url.pathname.endsWith("/commits") && init?.method === "POST") return response(commitTask, 202);
      if (url.pathname.endsWith("/push-preflight")) return response(preview);
      if (url.pathname.endsWith("/push") && init?.method === "POST") return response(pushTask, 202);
      throw new Error(`Unexpected API request: ${url} ${init?.method || "GET"}`);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    await screen.findByText("C:/combo-fixture", { selector: ".workspaceCrumb .mutedText" });
    fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "add change" } });
    fireEvent.click(screen.getByRole("button", { name: "Choose commit action" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Commit and Push to…" }));
    await screen.findByRole("dialog", { name: "Choose push target" });
    await waitFor(() => {
      const savedSession = JSON.parse(window.localStorage.getItem("gitcrest-workspace-session-v1") || "{}");
      expect(savedSession.tabs[repository.repoId].commitAction).toBe("commitAndPushTo");
    });
    fireEvent.click(screen.getByRole("button", { name: "Close push target selection" }));

    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true, shiftKey: true });

    await screen.findByRole("dialog", { name: "Tasks" });
    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => new URL(String(input)).pathname.endsWith("/push") && init?.method === "POST")).toBe(true));
    const commitRequest = fetcher.mock.calls.find(([input, init]) => new URL(String(input)).pathname.endsWith("/commits") && init?.method === "POST");
    const pushRequest = fetcher.mock.calls.find(([input, init]) => new URL(String(input)).pathname.endsWith("/push") && init?.method === "POST");
    expect(JSON.parse(String(commitRequest?.[1]?.body)).message).toBe("add change");
    expect(JSON.parse(String(pushRequest?.[1]?.body))).toMatchObject({ remoteName: "origin", remoteBranch: "main", forceWithLease: false });
    expect(fetcher.mock.calls.filter(([input, init]) => new URL(String(input)).pathname.endsWith("/commits") && init?.method === "POST")).toHaveLength(1);
  });

  it("cycles themes from the command palette", async () => {
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
    // Theme lives in Settings and the palette; the titlebar keeps only global essentials.
    expect(screen.queryByRole("button", { name: /Color theme/ })).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.click(screen.getByRole("button", { name: /Cycle color theme/ }));
    await waitFor(() => expect(["light", "dark"]).toContain(document.documentElement.dataset.theme));
  });
});
