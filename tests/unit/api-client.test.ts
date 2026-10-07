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

  it("encodes the path and optional historical revision for blame", async () => {
    const response = { repoId: "repo_fixture", path: "folder/source file.ts", revision: "a".repeat(40), lines: [] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryBlame("repo_fixture", response.path, response.revision)).resolves.toEqual(response);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repositories/repo_fixture/blame");
    expect(url.searchParams.get("path")).toBe(response.path);
    expect(url.searchParams.get("revision")).toBe(response.revision);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
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

  it("sends versioned remote management requests with the OpenAPI payloads", async () => {
    const task = { taskId: "task_fixture", repoId: "repo_fixture", operation: "remoteAdd", status: "queued", phase: "queued", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await client.addRepositoryRemote("repo_fixture", "upstream", "https://example.test/org/repo.git");
    await client.setRepositoryRemoteUrl("repo_fixture", "upstream", "ssh://example.test/org/repo.git");
    await client.deleteRepositoryRemote("repo_fixture", "upstream");
    await client.setRepositoryDefaultRemote("repo_fixture", null);
    await client.setRepositoryBranchUpstream("repo_fixture", "main", "upstream", "main");

    expect(fetcher.mock.calls.map(([url, request]) => [new URL(String(url)).pathname, request?.method, request?.body])).toEqual([
      ["/api/v1/repositories/repo_fixture/remotes", "POST", JSON.stringify({ name: "upstream", url: "https://example.test/org/repo.git" })],
      ["/api/v1/repositories/repo_fixture/remotes/url", "PUT", JSON.stringify({ name: "upstream", url: "ssh://example.test/org/repo.git" })],
      ["/api/v1/repositories/repo_fixture/remotes/delete", "POST", JSON.stringify({ name: "upstream" })],
      ["/api/v1/repositories/repo_fixture/remotes/default", "PUT", JSON.stringify({ name: null })],
      ["/api/v1/repositories/repo_fixture/remotes/upstream", "PUT", JSON.stringify({ localBranch: "main", remoteName: "upstream", remoteBranch: "main" })],
    ]);
    for (const [, request] of fetcher.mock.calls) {
      expect(new Headers(request?.headers).get("X-GitCrest-API-Version")).toBe("1");
      expect(new Headers(request?.headers).get("Authorization")).toBe(`Bearer ${token}`);
    }
  });

  it("uses the credential API with a write-only token and a host-only status query", async () => {
    const response = { host: "example.test", username: "lewis", isConfigured: true };
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(JSON.stringify(response), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(response), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockImplementationOnce(async () => new Response(null, { status: 204, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getCredentialStatus("example.test:8443")).resolves.toEqual(response);
    await expect(client.setCredential("example.test", "lewis", "personal-access-token")).resolves.toEqual(response);
    await expect(client.deleteCredential("example.test")).resolves.toBeUndefined();

    expect(new URL(String(fetcher.mock.calls[0][0])).searchParams.get("host")).toBe("example.test:8443");
    expect(fetcher.mock.calls[1][1]?.method).toBe("PUT");
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ host: "example.test", username: "lewis", token: "personal-access-token" }));
    expect(String(fetcher.mock.calls[2][0])).toBe(`${baseUrl}/api/v1/credentials?host=example.test`);
    expect(fetcher.mock.calls[2][1]?.method).toBe("DELETE");
  });

  it("reads local and remote branch tracking state through the versioned API", async () => {
    const response = {
      repoId: "repo_fixture", current: "feature/one", detached: false,
      branches: [{ name: "feature/one", fullName: "refs/heads/feature/one", oid: "a".repeat(40), kind: "local", isCurrent: true, upstream: "origin/feature/one", upstreamGone: false, ahead: 2, behind: 1 }],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryBranches("repo_fixture")).resolves.toEqual(response);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/branches`);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe(`Bearer ${token}`);
  });

  it("queues local branch creation as a repository task", async () => {
    const task = { taskId: "task-branch", repoId: "repo_fixture", operation: "branchCreate", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.createRepositoryBranch("repo_fixture", "feature/new-ui")).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/branches`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ name: "feature/new-ui" }));
  });

  it("renames branches, reads delete impact, and sends the unmerged confirmation choice", async () => {
    const task = { taskId: "task-branch", repoId: "repo_fixture", operation: "branchRename", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const preview = { name: "feature/old", isCurrent: false, unmergedCommitCount: 2, requiresConfirmation: true };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...task, operation: "branchDelete" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.renameRepositoryBranch("repo_fixture", "feature/old", "feature/new")).resolves.toEqual(task);
    await expect(client.previewRepositoryBranchDelete("repo_fixture", "feature/old")).resolves.toEqual(preview);
    await client.deleteRepositoryBranch("repo_fixture", "feature/old", true);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/branches/rename`);
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ name: "feature/old", newName: "feature/new" }));
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/branches/delete-preview`);
    expect(String(fetcher.mock.calls[2][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/branches/delete`);
    expect(fetcher.mock.calls[2][1]?.body).toBe(JSON.stringify({ name: "feature/old", allowUnmerged: true }));
  });

  it("persists a branch favorite by its full ref name", async () => {
    const snapshot = { repoId: "repo_fixture", current: "main", detached: false, branches: [
      { name: "main", fullName: "refs/heads/main", oid: "a".repeat(40), kind: "local", isCurrent: true, isFavorite: true, upstream: null, upstreamGone: false, ahead: null, behind: null },
    ] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.setRepositoryBranchFavorite("repo_fixture", "refs/heads/main", true)).resolves.toEqual(snapshot);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/branches/favorite`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("PUT");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ fullName: "refs/heads/main", favorite: true }));
  });

  it("preflights a branch switch with a read request and queues a clean switch", async () => {
    const preflight = { repoId: "repo_fixture", current: "main", target: "feature/ui", isClean: true, dirtyFiles: [], potentiallyOverwrittenPaths: [] };
    const task = { taskId: "task-switch", repoId: "repo_fixture", operation: "branchSwitch", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(preflight), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.preflightRepositoryBranchSwitch("repo_fixture", "feature/ui")).resolves.toEqual(preflight);
    await expect(client.switchRepositoryBranch("repo_fixture", "feature/ui")).resolves.toEqual(task);
    const preflightUrl = new URL(String(fetcher.mock.calls[0][0]));
    expect(preflightUrl.pathname).toBe("/api/v1/repositories/repo_fixture/branches/switch-preflight");
    expect(preflightUrl.searchParams.get("name")).toBe("feature/ui");
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/branches/switch`);
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ name: "feature/ui" }));
  });

  it("reads sanitized remote configuration through a versioned repository request", async () => {
    const snapshot = { repoId: "repo_fixture", defaultRemote: "origin", remotes: [
      { name: "origin", fetchUrls: ["https://[REDACTED]@example.test/org/repo.git"], pushUrls: ["ssh://[REDACTED]@example.test/org/repo.git"], isDefault: true },
    ] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryRemotes("repo_fixture")).resolves.toEqual(snapshot);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo_fixture/remotes`);
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("X-GitCrest-API-Version")).toBe("1");
  });

  it("reads paginated commits, commit detail, and refs through versioned repository routes", async () => {
    const page = { repoId: "repo_fixture", offset: 50, limit: 50, commits: [], nextOffset: 100 };
    const detail = { repoId: "repo_fixture", oid: "a".repeat(40), parents: [], authorName: "Author", authorEmail: "author@example.invalid", committedAtMs: 1, message: "first", stats: { filesChanged: 0, insertions: 0, deletions: 0 }, files: [] };
    const refs = { repoId: "repo_fixture", head: "a".repeat(40), branch: "main", detached: false, refs: [] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(page), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(refs), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...detail, scope: "commit", path: "src/App.tsx", revision: "rev", originalPath: null, changeKind: "modified", status: "text", hunks: [] }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ repoId: "repo_fixture", name: "v1.0", fullName: "refs/tags/v1.0", oid: "a".repeat(40) }), { status: 201, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryCommits("repo/fixture", 50, 50, {
      sha: "a1b2c3d4", author: "Author One", message: "fix & ship", branch: "main",
      path: "src/App.tsx", since: "2026-01-01", until: "2026-12-31",
    })).resolves.toEqual(page);
    await expect(client.getRepositoryCommit("repo/fixture", "a".repeat(40))).resolves.toEqual(detail);
    await expect(client.getRepositoryRefs("repo/fixture")).resolves.toEqual(refs);
    await expect(client.getRepositoryCommitDiff("repo/fixture", "a".repeat(40), "src/App.tsx")).resolves.toMatchObject({ scope: "commit", path: "src/App.tsx" });
    await expect(client.createRepositoryCommitTag("repo/fixture", "a".repeat(40), "v1.0", "Release")).resolves.toMatchObject({ name: "v1.0" });
    const historyQuery = new URL(String(fetcher.mock.calls[0][0])).searchParams;
    expect(historyQuery.get("offset")).toBe("50");
    expect(historyQuery.get("limit")).toBe("50");
    expect(historyQuery.get("sha")).toBe("a1b2c3d4");
    expect(historyQuery.get("message")).toBe("fix & ship");
    expect(historyQuery.get("path")).toBe("src/App.tsx");
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/commits/${"a".repeat(40)}`);
    expect(String(fetcher.mock.calls[2][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/refs`);
    expect(String(fetcher.mock.calls[3][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/commits/${"a".repeat(40)}/diff?path=src%2FApp.tsx`);
    expect(String(fetcher.mock.calls[4][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/commits/${"a".repeat(40)}/tags`);
    expect(fetcher.mock.calls[4][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[4][1]?.body))).toEqual({ name: "v1.0", message: "Release" });
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

  it("reads pull safety state and queues a pull with an explicit strategy", async () => {
    const preview = {
      repoId: "repo_fixture", localBranch: "main", remoteName: "origin", remoteBranch: "main",
      localOid: "a".repeat(40), trackingOid: "b".repeat(40), ahead: 0, behind: 2,
      isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, hasConflicts: false, operationInProgress: false,
    };
    const task = { taskId: "task-pull", repoId: "repo_fixture", operation: "pullMerge", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.preflightRepositoryPull("repo/fixture")).resolves.toEqual(preview);
    const request = { expectedLocalOid: preview.localOid, expectedTrackingOid: preview.trackingOid, strategy: "merge" as const };
    await expect(client.pullRepository("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/pull-preflight`);
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/pull`);
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify(request));
  });

  it("reads the push preview for an encoded repository ID", async () => {
    const preview = {
      repoId: "repo_fixture", localBranch: "main", remoteName: "origin", remoteBranch: "main",
      localOid: "a".repeat(40), expectedRemoteOid: "b".repeat(40), ahead: 1, behind: 0,
      commitsToPush: [{ oid: "a".repeat(40), subject: "feature change" }], overwrittenCommitCount: 0,
      changedPaths: ["src/file.ts"], changedPathCount: 1, omittedChangedPathCount: 0,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(preview), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.preflightRepositoryPush("repo/fixture")).resolves.toEqual(preview);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/push-preflight`);
    expect(fetcher.mock.calls[0][1]?.method).toBeUndefined();
  });

  it("requests a typed merge safety preview for an encoded commit target", async () => {
    const preview = {
      repoId: "repo_fixture", action: "cherryPick", headOid: "a".repeat(40), targetOid: "b".repeat(40),
      targetSubject: "selected change", operationInProgress: null, isClean: true, dirtyPaths: [],
      omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: true,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(preview), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.preflightRepositoryWorkflow("repo/fixture", "cherryPick", "b".repeat(40))).resolves.toEqual(preview);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repositories/repo%2Ffixture/workflows/preflight");
    expect(url.searchParams.get("action")).toBe("cherryPick");
    expect(url.searchParams.get("targetOid")).toBe("b".repeat(40));
  });

  it("queues a snapshot-bound cherry-pick using a typed workflow request", async () => {
    const task = { taskId: "task-cherry-pick", repoId: "repo_fixture", operation: "cherryPick", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const request = { action: "cherryPick" as const, targetOid: "b".repeat(40), expectedHeadOid: "a".repeat(40) };

    await expect(client.startRepositoryWorkflow("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(request);
  });

  it("requests a one-off push preview for the selected remote branch", async () => {
    const preview = {
      repoId: "repo_fixture", localBranch: "main", remoteName: "backup", remoteBranch: "release/2026",
      localOid: "a".repeat(40), expectedRemoteOid: "b".repeat(40), ahead: 1, behind: 0,
      commitsToPush: [], overwrittenCommitCount: 0, changedPaths: [], changedPathCount: 0, omittedChangedPathCount: 0,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(preview), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.preflightRepositoryPush("repo/fixture", { remoteName: "backup", remoteBranch: "release/2026" })).resolves.toEqual(preview);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repositories/repo%2Ffixture/push-preflight");
    expect(url.searchParams.get("remoteName")).toBe("backup");
    expect(url.searchParams.get("remoteBranch")).toBe("release/2026");
  });

  it("queues a push bound to both preflight OIDs", async () => {
    const task = { taskId: "task-push", repoId: "repo_fixture", operation: "push", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const request = { expectedLocalOid: "a".repeat(40), expectedRemoteOid: "b".repeat(40), forceWithLease: true, remoteName: "backup", remoteBranch: "release" };

    await expect(client.pushRepository("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/push`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify(request));
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
