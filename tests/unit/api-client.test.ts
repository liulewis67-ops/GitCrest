import { describe, expect, it, vi } from "vitest";
import { GitCrestApiClient, GitCrestApiError } from "../../src/api/client";

const baseUrl = "http://127.0.0.1:43210";
const token = "test-session-token";

describe("GitCrestApiClient", () => {
  it("loads the authenticated bootstrap version without a v1 header", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      name: "gitcrest-core",
      version: "0.1.0",
      apiVersion: 1,
    }), { status: 200 }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getVersion()).resolves.toMatchObject({ apiVersion: 1 });
    const [, request] = fetcher.mock.calls[0];
    expect(request?.headers).toBeInstanceOf(Headers);
    expect(new Headers(request?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(request?.headers).has("X-GitCrest-API-Version")).toBe(false);
  });

  it("encodes file paths and requests the selected diff scope", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      repoId: "repo_fixture", path: "new file.txt", originalPath: null, scope: "workingTree",
      changeKind: "untracked", status: "text", hunks: [],
    }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await client.getFileDiff("repo_fixture", "new file.txt", "workingTree");
    const [url] = fetcher.mock.calls[0];
    expect(new URL(String(url)).pathname).toBe("/api/v1/repositories/repo_fixture/diff");
    expect(new URL(String(url)).searchParams.get("path")).toBe("new file.txt");
    expect(new URL(String(url)).searchParams.get("scope")).toBe("workingTree");
  });

  it("versions repository requests and encodes repoId", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await client.getRepository("repo/with space");
    const [url, request] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${baseUrl}/api/v1/repositories/repo%2Fwith%20space`);
    const headers = new Headers(request?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${token}`);
    expect(headers.get("X-GitCrest-API-Version")).toBe("1");
  });

  it("opens a repository with the selected path and versioned write request", async () => {
    const repository = { repoId: "repo_fixture", path: "C:/fixture", head: null, branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(repository), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.openRepository("C:/fixture")).resolves.toEqual(repository);
    const [url, request] = fetcher.mock.calls[0];
    expect(String(url)).toBe(`${baseUrl}/api/v1/repositories`);
    expect(request?.method).toBe("POST");
    expect(new Headers(request?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    expect(new Headers(request?.headers).get("X-GitCrest-API-Version")).toBe("1");
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(request?.body).toBe(JSON.stringify({ path: "C:/fixture" }));
  });

  it("initializes selected folders and persists favorite and forget actions", async () => {
    const repository = { repoId: "repo_fixture", path: "C:/fixture", head: null, branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(repository), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...repository, isFavorite: true }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await client.initializeRepository("C:/fixture");
    await expect(client.setRepositoryFavorite("repo_fixture", true)).resolves.toMatchObject({ isFavorite: true });
    await expect(client.forgetRepository("repo_fixture")).resolves.toBeUndefined();
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/initialize`);
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/favorite`);
    expect(fetcher.mock.calls[1][1]?.method).toBe("PUT");
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ favorite: true }));
    expect(fetcher.mock.calls[2][1]?.method).toBe("DELETE");
  });

  it("reads a refreshed status snapshot through the repository ID", async () => {
    const snapshot = { repoId: "repo_fixture", refreshedAtMs: 1, files: [] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryStatus("repo/fixture")).resolves.toEqual(snapshot);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/status`);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("X-GitCrest-API-Version")).toBe("1");
  });

  it("reads paginated commits, commit detail, and refs through versioned repository routes", async () => {
    const page = { repoId: "repo_fixture", offset: 50, limit: 50, commits: [], nextOffset: 100 };
    const detail = { repoId: "repo_fixture", oid: "a".repeat(40), parents: [], authorName: "Author", authorEmail: "author@example.invalid", committedAtMs: 1, message: "first", stats: { filesChanged: 0, insertions: 0, deletions: 0 }, files: [] };
    const refs = { repoId: "repo_fixture", head: "a".repeat(40), branch: "main", detached: false, refs: [] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(refs), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryCommits("repo/fixture", 50, 50, {
      sha: "a1b2c3d4", author: "Author One", message: "fix & ship", branch: "main",
      path: "src/App.tsx", since: "2026-01-01", until: "2026-12-31",
    })).resolves.toEqual(page);
    await expect(client.getRepositoryCommit("repo/fixture", "a".repeat(40))).resolves.toEqual(detail);
    await expect(client.getRepositoryRefs("repo/fixture")).resolves.toEqual(refs);
    const historyQuery = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(historyQuery.get("offset")).toBe("50");
    expect(historyQuery.get("limit")).toBe("50");
    expect(historyQuery.get("sha")).toBe("a1b2c3d4");
    expect(historyQuery.get("message")).toBe("fix & ship");
    expect(historyQuery.get("path")).toBe("src/App.tsx");
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/commits/${"a".repeat(40)}`);
    expect(String(fetcher.mock.calls[2][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/refs`);
    for (const [, request] of fetcher.mock.calls) {
      expect(new Headers(request?.headers).get("X-GitCrest-API-Version")).toBe("1");
    }
  });

  it("lists tasks and requests cancellation through versioned task routes", async () => {
    const task = { taskId: "task-1", repoId: "repo_fixture", operation: "fetch", status: "running", phase: "Receiving", progress: 35, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 2, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([task]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...task, cancelRequested: true }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.listTasks()).resolves.toEqual([task]);
    await expect(client.cancelTask("task/one")).resolves.toMatchObject({ cancelRequested: true });
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/tasks`);
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/tasks/task%2Fone/cancel`);
    expect(fetcher.mock.calls[1][1]?.method).toBe("POST");
  });

  it("queues a typed fetch operation against an opaque repository ID", async () => {
    const task = { taskId: "task-1", repoId: "repo_fixture", operation: "fetch", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.fetchRepository("repo/fixture")).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/fetch`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ prune: false }));
  });

  it("queues a commit using the encoded repository ID and exact message text", async () => {
    const task = { taskId: "task-commit", repoId: "repo_fixture", operation: "commit", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    const options = { amend: true, signOff: true, sign: false, selections: [{ path: "src/file.ts", revision: "sha256:fixture", selections: [{ hunkIndex: 1, rowIndex: 2 }] }] };
    await expect(client.commitRepository("repo/fixture", " subject \n\nbody\n", options)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/commits`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ message: " subject \n\nbody\n", ...options }));
  });

  it("queues file-level stage operations with a literal selected path payload", async () => {
    const task = { taskId: "task-stage", repoId: "repo_fixture", operation: "stageFile", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.stageRepositoryChanges("repo/fixture", { action: "stageFile", path: "folder/file [1].txt" })).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/staging`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ action: "stageFile", path: "folder/file [1].txt" }));
  });

  it("queues revision-bound hunk staging selections", async () => {
    const task = { taskId: "task-hunk", repoId: "repo_fixture", operation: "stageHunks", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const request = { action: "stage" as const, path: "src/file.ts", scope: "workingTree" as const, revision: "sha256:abc", selections: [{ hunkIndex: 0 }, { hunkIndex: 2, rowIndex: 1 }] };

    await expect(client.stageSelectedDiffHunks("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/staging/patch`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify(request));
  });

  it("preserves structured API errors and rejects missing version confirmation", async () => {
    const errorFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "REPOSITORY_NOT_FOUND", message: "Repository was not found." },
    }), { status: 404 }));
    const client = new GitCrestApiClient(baseUrl, token, errorFetcher);
    await expect(client.getRepository("repo_missing")).rejects.toMatchObject<Partial<GitCrestApiError>>({
      status: 404,
      body: { error: { code: "REPOSITORY_NOT_FOUND", message: "Repository was not found." } },
    });

    const staleFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]", { status: 200 }));
    await expect(new GitCrestApiClient(baseUrl, token, staleFetcher).listRepositories())
      .rejects.toThrow("did not confirm API version 1");
  });
});
