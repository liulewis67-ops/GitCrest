import { describe, expect, it, vi } from "vitest";
import { GitCrestApiClient, GitCrestApiError } from "../../src/api/client";

const baseUrl = "http://127.0.0.1:43210";
const token = "test-session-token";

describe("GitCrestApiClient", () => {
  it("lists the complete active recovery collection and preserves an authoritative empty response", async () => {
    const entry = { operationId: "op", revision: "9223372036854775807", version: "9007199254740993", actionsEnabled: false, allowedActions: [] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([entry]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    await expect(client.listActiveRepositoryOperations("repo/a")).resolves.toEqual([entry]);
    await expect(client.listActiveRepositoryOperations("repo/a")).resolves.toEqual([]);
    for (const [url, init] of fetcher.mock.calls) {
      expect(String(url)).toBe(`${baseUrl}/api/v1/repositories/repo%2Fa/operations?active=true`);
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
    }
  });
  it("reads operation identities without converting durable counters or sending writes", async () => {
    const response = { operationId: "op/a", revision: "9223372036854775807", version: "9007199254740993", actionsEnabled: false, allowedActions: [] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(response), {
      status: 200, headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    await expect(client.getRepositoryOperation("repo/a", "op/a")).resolves.toEqual(response);
    await expect(client.getRepositoryOperationByRequest("repo/a", "request /?&+#中文")).resolves.toEqual(response);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Fa/operations/op%2Fa`);
    const lookup = new URL(String(fetcher.mock.calls[1][0]));
    expect(lookup.pathname).toBe("/api/v1/repositories/repo%2Fa/operation-requests");
    expect(lookup.searchParams.get("requestId")).toBe("request /?&+#中文");
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${token}`);
      expect(new Headers(init?.headers).get("X-GitCrest-API-Version")).toBe("1");
    }
  });
  it("previews, creates and submits operation actions with exact JSON bodies and encoded identities", async () => {
    const request = { kind: "checkoutBranch", changesFingerprint: "f".repeat(64) };
    const created = { operationId: "op/a", dispatched: true, action: null, task: null };
    const accepted = { action: { requestId: "act-1" }, task: null };
    const bodies = [{ request }, created, accepted];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(bodies.shift()), {
      status: 200, headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const input = { command: { kind: "pullRebase" as const }, preservation: "restore" as const };
    await expect(client.previewRepositoryOperation("repo/a", input)).resolves.toEqual(request);
    const creation = { requestId: "req-1", request } as never;
    await expect(client.createRepositoryOperation("repo/a", creation)).resolves.toEqual(created);
    const submission = { requestId: "act-1", kind: "abortPullRebase", expectedVersion: "9007199254740993" } as never;
    await expect(client.submitRepositoryOperationAction("repo/a", "op/a", submission)).resolves.toEqual(accepted);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}/api/v1/repositories/repo%2Fa/operation-previews`,
      `${baseUrl}/api/v1/repositories/repo%2Fa/operations`,
      `${baseUrl}/api/v1/repositories/repo%2Fa/operations/op%2Fa/actions`,
    ]);
    expect(fetcher.mock.calls.map(([, init]) => init?.body)).toEqual([
      JSON.stringify(input), JSON.stringify(creation), JSON.stringify(submission),
    ]);
    for (const [, init] of fetcher.mock.calls) {
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
    }
  });
  it("passes an AbortSignal to fetch and aborts an in-flight request", async () => {
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The request was aborted.", "AbortError")));
    }));
    const controller = new AbortController();
    const request = new GitCrestApiClient(baseUrl, token, fetcher)
      .withSignal(controller.signal)
      .listRepositories();

    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("reports an error response that is not the API error shape with its status and text", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("Payload Too Large", { status: 413 }));
    const request = new GitCrestApiClient(baseUrl, token, fetcher).listRepositories();

    await expect(request).rejects.toBeInstanceOf(GitCrestApiError);
    await expect(request).rejects.toMatchObject({
      status: 413,
      body: { error: { code: "INTERNAL_ERROR", message: "The GitCrest core answered with HTTP 413: Payload Too Large" } },
    });
  });

  it("keeps the API error body when the core sends one", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "REPOSITORY_NOT_FOUND", message: "Repository not found." } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    ));

    await expect(new GitCrestApiClient(baseUrl, token, fetcher).listRepositories()).rejects.toMatchObject({
      status: 404,
      body: { error: { code: "REPOSITORY_NOT_FOUND", message: "Repository not found." } },
    });
  });

  it("explains a refused connection instead of surfacing the network error", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(new GitCrestApiClient(baseUrl, token, fetcher).listRepositories())
      .rejects.toThrow("The local GitCrest core did not respond");
  });

  it("saves the provider list and tests a provider through versioned APIs", async () => {
    const provider = { id: "claude", name: "Claude", apiFormat: "anthropicMessages" as const, baseUrl: "https://api.anthropic.com/v1", model: "claude-model", maxOutputTokens: null, apiKey: "private-test-key" };
    const settings = { activeProviderId: "claude", providers: [{ ...provider, apiKey: undefined, hasApiKey: true, isLocal: false }], configPath: "/data/ai-providers.json" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(settings), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ model: "claude-model", response: "OK" }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await client.setAiSettings({ activeProviderId: "claude", providers: [provider] });
    await expect(client.testAiProvider(provider)).resolves.toEqual({ model: "claude-model", response: "OK" });
    expect(new URL(String(fetcher.mock.calls[0][0])).pathname).toBe("/api/v1/ai/settings");
    expect(fetcher.mock.calls[0][1]?.method).toBe("PUT");
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ activeProviderId: "claude", providers: [provider] }));
    expect(new URL(String(fetcher.mock.calls[1][0])).pathname).toBe("/api/v1/ai/providers/test");
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ provider }));
    expect(new Headers(fetcher.mock.calls[1][1]?.headers).get("X-GitCrest-API-Version")).toBe("1");
  });

  it("sends only the selected reviewed file scopes and revisions to the AI endpoint", async () => {
    const response = { provider: "Local", apiFormat: "openAiChatCompletions", model: "qwen-local", response: "summary", files: ["src/only.ts [worktree]"] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.requestAiReview("repo/a", "summarize", [{ path: "src/only.ts", scope: "index", revision: "sha256:reviewed", selections: [{ hunkIndex: 1, rowIndex: 2 }] }])).resolves.toEqual(response);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Fa/ai/request`);
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify({ prompt: "summarize", files: [{ path: "src/only.ts", scope: "index", revision: "sha256:reviewed", selections: [{ hunkIndex: 1, rowIndex: 2 }] }] }));
  });

  it("binds conflict suggestions to the waiting task, operation, HEAD and result revision", async () => {
    const response = { provider: "ollama", model: "qwen-local", response: "merged result", files: ["src/conflict.ts [base/ours/theirs/result]"] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const request = { taskId: "task-1-2", path: "src/conflict.ts", expectedOperation: "merge" as const, expectedHeadOid: "a".repeat(40), expectedResultRevision: "b".repeat(64) };

    await expect(client.requestRepositoryWorkflowConflictSuggestion("repo/a", request)).resolves.toEqual(response);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Fa/workflows/conflicts/suggestion`);
    expect(fetcher.mock.calls[0][1]?.body).toBe(JSON.stringify(request));
  });

  it("loads AI settings through the conflict-scoped capability route", async () => {
    const settings = { activeProviderId: "local", providers: [{ id: "local", name: "Local", apiFormat: "openAiChatCompletions" as const, baseUrl: "http://127.0.0.1:11434/v1", model: "qwen-local", maxOutputTokens: null, hasApiKey: false, isLocal: true }], configPath: null };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(settings), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryWorkflowConflictAiSettings("repo/a")).resolves.toEqual(settings);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Fa/workflows/conflicts/ai-settings`);
  });

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

  it("encodes repeated literal path scopes for incremental status refresh", async () => {
    const snapshot = { repoId: "repo_fixture", refreshedAtMs: 1, files: [] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryStatusPaths("repo_fixture", ["src/a file.ts", "notes.txt"])).resolves.toEqual(snapshot);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repositories/repo_fixture/status");
    expect(url.searchParams.getAll("paths")).toEqual(["src/a file.ts", "notes.txt"]);
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
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ name: "feature/ui", remote: false, commit: false }));
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
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    await client.fetchRepository("repo/fixture", false, false, true);
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ prune: false, all: true }));
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

  it("requests an ordered rebase todo preview for the selected onto commit", async () => {
    const preview = {
      repoId: "repo_fixture", headOid: "a".repeat(40), ontoOid: "b".repeat(40), currentBranch: "feature", publishedCommitOids: [],
      commits: [{ oid: "c".repeat(40), subject: "feature change" }], omittedCommitCount: 0,
      dirtyPaths: [], omittedDirtyPathCount: 0, operationInProgress: null,
      previewRevision: `sha256:${"d".repeat(64)}`, canStart: true,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(preview), {
      status: 200,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.preflightRepositoryRebase("repo/fixture", "b".repeat(40))).resolves.toEqual(preview);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repositories/repo%2Ffixture/workflows/rebase-preview");
    expect(url.searchParams.get("ontoOid")).toBe("b".repeat(40));
  });

  it("starts rebase with the reviewed head, target, and preview revision", async () => {
    const task = { taskId: "task-rebase", repoId: "repo_fixture", operation: "rebase", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const request = {
      expectedHeadOid: "a".repeat(40), expectedOntoOid: "b".repeat(40),
      previewRevision: `sha256:${"c".repeat(64)}`,
      todo: [{ oid: "c".repeat(40), action: "pick" as const, message: null }], confirmDrop: false, confirmPublishedRewrite: false,
    };

    await expect(client.startRepositoryRebase("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows/rebase-preview`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual(request);
  });

  it("lists rebase backups and queues rollback with explicit snapshot confirmation", async () => {
    const snapshot = {
      headOid: "a".repeat(40), currentBranch: "feature", dirtyPaths: [], operationInProgress: null,
      backups: [{ reference: "refs/gitcrest/rebase-backups/task-1", oid: "b".repeat(40), subject: "before rewrite" }],
      canRollback: true,
    };
    const task = { taskId: "task-rollback", repoId: "repo_fixture", operation: "rebaseRollback", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.getRepositoryRebaseBackups("repo/fixture")).resolves.toEqual(snapshot);
    const request = {
      expectedHeadOid: snapshot.headOid,
      backupReference: snapshot.backups[0]!.reference,
      backupOid: snapshot.backups[0]!.oid,
      confirmRollback: true,
    };
    await expect(client.rollbackRepositoryRebase("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows/rebase-backups`);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows/rebase-rollback`);
    expect(fetcher.mock.calls[1]![1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual(request);
  });

  it("previews and starts reset with the reviewed mode and commit target", async () => {
    const preview = {
      repoId: "repo_fixture", expectedHeadOid: "a".repeat(40), targetOid: "b".repeat(40), currentBranch: "feature",
      mode: "mixed" as const, commitsRemoved: 2, commitsAdded: 0, affectedPaths: ["src/file.ts"], omittedPathCount: 0,
      dirtyPaths: [], operationInProgress: null, previewRevision: `sha256:${"c".repeat(64)}`, canStart: true,
    };
    const task = { taskId: "task-reset", repoId: "repo_fixture", operation: "reset", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    await expect(client.preflightRepositoryReset("repo/fixture", preview.targetOid, "mixed")).resolves.toEqual(preview);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.pathname).toBe("/api/v1/repositories/repo%2Ffixture/workflows/reset-preview");
    expect(url.searchParams.get("mode")).toBe("mixed");
    const request = {
      expectedHeadOid: preview.expectedHeadOid, targetOid: preview.targetOid, mode: preview.mode,
      previewRevision: preview.previewRevision, confirmReset: true,
    };
    await expect(client.startRepositoryReset("repo/fixture", request)).resolves.toEqual(task);
    expect(fetcher.mock.calls[1]![1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual(request);
  });

  it("lists reset recovery refs and restores only the reviewed backup", async () => {
    const snapshot = {
      headOid: "a".repeat(40), currentBranch: "feature", dirtyPaths: [], operationInProgress: null,
      backups: [{ reference: "refs/gitcrest/reset-backups/task-1", oid: "b".repeat(40), subject: "feature work" }],
      canRestore: true,
    };
    const task = { taskId: "task-reset-restore", repoId: "repo_fixture", operation: "resetRestore", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    await expect(client.getRepositoryResetBackups("repo/fixture")).resolves.toEqual(snapshot);
    const request = {
      expectedHeadOid: snapshot.headOid,
      backupReference: snapshot.backups[0]!.reference,
      backupOid: snapshot.backups[0]!.oid,
      confirmRestore: true,
    };
    await expect(client.restoreRepositoryReset("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0]![0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows/reset-backups`);
    expect(String(fetcher.mock.calls[1]![0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows/reset-restore`);
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual(request);
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

  it("preflights and queues a reviewed workflow recovery action", async () => {
    const preview = {
      repoId: "repo_fixture", taskId: "task/merge", operation: "merge", headOid: "a".repeat(40),
      dirtyPaths: ["conflict.txt"], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0,
      canContinue: true, canSkip: false, canAbort: false,
    };
    const task = { taskId: "task-continue", repoId: "repo_fixture", operation: "workflowContinue", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(preview), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    await expect(client.preflightRepositoryWorkflowRecovery("repo/fixture", "task/merge")).resolves.toEqual(preview);
    const request = {
      taskId: preview.taskId, action: "continue" as const, expectedOperation: "merge" as const,
      expectedHeadOid: preview.headOid, expectedConflictedPaths: preview.conflictedPaths,
    };
    await expect(client.recoverRepositoryWorkflow("repo/fixture", request)).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(baseUrl + "/api/v1/repositories/repo%2Ffixture/workflows/recovery-preflight?taskId=task%2Fmerge");
    expect(String(fetcher.mock.calls[1][0])).toBe(baseUrl + "/api/v1/repositories/repo%2Ffixture/workflows/recovery");
    expect(fetcher.mock.calls[1][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(request);
  });

  it("reads a conflict file from a waiting workflow with encoded task and path values", async () => {
    const conflict = {
      repoId: "repo_fixture", taskId: "task/merge", path: "src/file name.ts", operation: "merge", headOid: "a".repeat(40),
      baseContent: "base", oursContent: "ours", theirsContent: "theirs", resultContent: "result", resultRevision: "b".repeat(64), isText: true,
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(conflict), {
      status: 200, headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    await expect(client.getRepositoryWorkflowConflictFile("repo/fixture", "task/merge", "src/file name.ts")).resolves.toEqual(conflict);
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/v1/repositories/repo%2Ffixture/workflows/conflicts/file");
    expect(url.searchParams.get("taskId")).toBe("task/merge");
    expect(url.searchParams.get("path")).toBe("src/file name.ts");
  });

  it("queues revision-bound conflict saves and resolved checks", async () => {
    const task = { taskId: "task-save", repoId: "repo_fixture", operation: "workflowConflictSave", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...task, operation: "workflowConflictResolved" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const request = {
      taskId: "task/merge", path: "src/file name.ts", expectedOperation: "merge" as const,
      expectedHeadOid: "a".repeat(40), expectedResultRevision: "b".repeat(64),
    };
    await expect(client.saveRepositoryWorkflowConflictFile("repo/fixture", { ...request, content: "resolved\n" })).resolves.toEqual(task);
    await expect(client.markRepositoryWorkflowConflictResolved("repo/fixture", request)).resolves.toMatchObject({ operation: "workflowConflictResolved" });
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows/conflicts/file`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ ...request, content: "resolved\n" });
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/workflows/conflicts/resolved`);
    expect(fetcher.mock.calls[1][1]?.method).toBe("POST");
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(request);
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
    const request = { expectedLocalOid: "a".repeat(40), expectedRemoteOid: "b".repeat(40), forceWithLease: true, remoteName: "backup", remoteBranch: "release", tags: "none" as const };

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

  it("queues an undo of the latest staging operation for one repository", async () => {
    const task = { taskId: "task-undo", repoId: "repo_fixture", operation: "undoRecentOperation", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(task), {
      status: 202,
      headers: { "X-GitCrest-API-Version": "1" },
    }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await expect(client.undoRecentOperation("repo/fixture")).resolves.toEqual(task);
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/undo`);
    expect(fetcher.mock.calls[0][1]?.method).toBe("POST");
    expect(fetcher.mock.calls[0][1]?.body).toBeUndefined();
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

  it("lists, creates, previews, and deletes shelves with encoded identifiers", async () => {
    const shelf = {
      shelfId: "shelf/one", repoId: "repo/fixture", name: "work in progress", description: "notes",
      paths: ["folder/notes.txt"], headOid: "a".repeat(40), createdAtMs: 1,
    };
    const task = { taskId: "task-shelf", repoId: "repo/fixture", operation: "shelfCreate", status: "queued", phase: "Waiting", progress: null, message: null, errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false };
    const detail = { shelf, patch: "diff --git a/notes.txt b/notes.txt\n" };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify([shelf]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(task), { status: 202, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { "X-GitCrest-API-Version": "1" } }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);
    const request = {
      name: "work in progress", description: "notes", expectedHeadOid: "a".repeat(40),
      items: [{ path: "folder/notes.txt", scope: "workingTree" as const, revision: "sha256:fixture", selections: [{ hunkIndex: 0 }] }],
    };

    await expect(client.listRepositoryShelves("repo/fixture")).resolves.toEqual([shelf]);
    await expect(client.createRepositoryShelf("repo/fixture", request)).resolves.toEqual(task);
    await expect(client.getRepositoryShelf("repo/fixture", shelf.shelfId)).resolves.toEqual(detail);
    await expect(client.deleteRepositoryShelf("repo/fixture", shelf.shelfId)).resolves.toBeUndefined();
    expect(String(fetcher.mock.calls[0][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/shelves`);
    expect(String(fetcher.mock.calls[1][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/shelves`);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(request);
    expect(String(fetcher.mock.calls[2][0])).toBe(`${baseUrl}/api/v1/repositories/repo%2Ffixture/shelves/shelf%2Fone`);
    expect(fetcher.mock.calls[3][1]?.method).toBe("DELETE");
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

describe("GitCrestApiClient pipelines", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-GitCrest-API-Version": "1" } });

  it("reads and writes settings, rules and runs on the pipeline routes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ rules: [], runs: [], executionMode: "temporaryWorktree", inPlaceDirtyPolicy: "shelve" }));
    const client = new GitCrestApiClient(baseUrl, token, fetcher);

    await client.getPipelineAppSettings();
    await client.setPipelineAppSettings({ executionMode: "switchInPlace", inPlaceDirtyPolicy: "refuse" });
    await client.getPipelineRepositorySettings("repo_a");
    await client.setPipelineRepositorySettings("repo_a", { executionMode: null });
    await client.listPipelineRules("repo_a");
    await client.replacePipelineRules("repo_a", []);
    await client.listPipelineRuns("repo_a", 5);
    await client.startPipelineRun("repo_a", { runId: "run_1", targets: ["dev"] });
    await client.actOnPipelineRun("repo_a", "run_1", "skipTarget");

    const calls = fetcher.mock.calls.map(([input, init]) => `${init?.method ?? "GET"} ${String(input).replace(baseUrl, "")}`);
    expect(calls).toEqual([
      "GET /api/v1/settings/pipelines",
      "PUT /api/v1/settings/pipelines",
      "GET /api/v1/repositories/repo_a/pipelines/settings",
      "PUT /api/v1/repositories/repo_a/pipelines/settings",
      "GET /api/v1/repositories/repo_a/pipelines/rules",
      "PUT /api/v1/repositories/repo_a/pipelines/rules",
      "GET /api/v1/repositories/repo_a/pipelines/runs?limit=5",
      "POST /api/v1/repositories/repo_a/pipelines/runs",
      "POST /api/v1/repositories/repo_a/pipelines/runs/run_1/actions",
    ]);
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).toEqual({ executionMode: null });
    expect(JSON.parse(String(fetcher.mock.calls[7]?.[1]?.body))).toEqual({ runId: "run_1", targets: ["dev"] });
    expect(JSON.parse(String(fetcher.mock.calls[8]?.[1]?.body))).toEqual({ action: "skipTarget" });
  });
});
