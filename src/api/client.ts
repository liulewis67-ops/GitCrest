import type { components, paths } from "./schema";

export type RepoId = components["schemas"]["RepoId"];
export type ApiErrorResponse = components["schemas"]["ApiErrorResponse"];
export type VersionResponse = components["schemas"]["VersionResponse"];
export type RepositoryResponse = components["schemas"]["Repository"];
export type StatusSnapshotResponse = components["schemas"]["StatusSnapshot"];
export type TaskSnapshotResponse = components["schemas"]["TaskSnapshot"];
export type DiffDocumentResponse = components["schemas"]["DiffDocument"];
export type BlameDocumentResponse = components["schemas"]["BlameDocument"];
export type StagingRequest = components["schemas"]["StagingRequest"];
export type StagingPatchRequest = components["schemas"]["StagingPatchRequest"];
export type CommitRequest = components["schemas"]["CommitRequest"];
export type CommitPageResponse = components["schemas"]["CommitPage"];
export type CommitDetailResponse = components["schemas"]["CommitDetail"];
export type RefSnapshotResponse = components["schemas"]["RefSnapshot"];
export type BranchSnapshotResponse = components["schemas"]["BranchSnapshot"];
export type CreatedTagResponse = components["schemas"]["CreatedTag"];
export type CommitHistoryFilters = Pick<
  NonNullable<paths["/api/v1/repositories/{repoId}/commits"]["get"]["parameters"]["query"]>,
  "sha" | "author" | "message" | "branch" | "path" | "since" | "until"
>;

export class GitCrestApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorResponse,
  ) {
    super(body.error.message);
    this.name = "GitCrestApiError";
  }
}

export class GitCrestApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async getVersion(): Promise<VersionResponse> {
    const response = await this.request<paths["/api/version"]["get"]["responses"][200]["content"]["application/json"]>(
      "/api/version",
      false,
    );
    if (response.apiVersion !== 1) {
      throw new Error(`Unsupported GitCrest API version: ${response.apiVersion}`);
    }
    return response;
  }

  getRepository(repoId: RepoId): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}`);
  }

  openRepository(path: string): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>("/api/v1/repositories", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  }

  initializeRepository(path: string): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>("/api/v1/repositories/initialize", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  }

  listRepositories(): Promise<RepositoryResponse[]> {
    return this.request<RepositoryResponse[]>("/api/v1/repositories");
  }

  setRepositoryFavorite(repoId: RepoId, favorite: boolean): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/favorite`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favorite }),
    });
  }

  forgetRepository(repoId: RepoId): Promise<void> {
    return this.request<void>(`/api/v1/repositories/${encodeURIComponent(repoId)}`, true, { method: "DELETE" });
  }

  getRepositoryStatus(repoId: RepoId): Promise<StatusSnapshotResponse> {
    return this.request<StatusSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/status`);
  }

  getFileDiff(repoId: RepoId, path: string, scope: "workingTree" | "index"): Promise<DiffDocumentResponse> {
    const query = new URLSearchParams({ path, scope });
    return this.request<DiffDocumentResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/diff?${query}`);
  }

  getRepositoryBlame(repoId: RepoId, path: string, revision?: string): Promise<BlameDocumentResponse> {
    const query = new URLSearchParams({ path });
    if (revision) query.set("revision", revision);
    return this.request<BlameDocumentResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/blame?${query}`);
  }

  getRepositoryCommits(repoId: RepoId, offset = 0, limit = 50, filters: CommitHistoryFilters = {}): Promise<CommitPageResponse> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    for (const [name, value] of Object.entries(filters)) {
      if (typeof value === "string" && value.length > 0) query.set(name, value);
    }
    return this.request<CommitPageResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/commits?${query}`);
  }

  getRepositoryCommit(repoId: RepoId, oid: string): Promise<CommitDetailResponse> {
    return this.request<CommitDetailResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/commits/${encodeURIComponent(oid)}`);
  }

  getRepositoryCommitDiff(repoId: RepoId, oid: string, path: string): Promise<DiffDocumentResponse> {
    const query = new URLSearchParams({ path });
    return this.request<DiffDocumentResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/commits/${encodeURIComponent(oid)}/diff?${query}`);
  }

  createRepositoryCommitTag(repoId: RepoId, oid: string, name: string, message: string): Promise<CreatedTagResponse> {
    return this.request<CreatedTagResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/commits/${encodeURIComponent(oid)}/tags`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, message } satisfies components["schemas"]["CreateTagRequest"]),
    });
  }

  getRepositoryRefs(repoId: RepoId): Promise<RefSnapshotResponse> {
    return this.request<RefSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/refs`);
  }

  getRepositoryBranches(repoId: RepoId): Promise<BranchSnapshotResponse> {
    return this.request<BranchSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches`);
  }

  stageRepositoryChanges(repoId: RepoId, request: StagingRequest): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/staging`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  stageSelectedDiffHunks(repoId: RepoId, request: StagingPatchRequest): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/staging/patch`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  commitRepository(repoId: RepoId, message: string, options: Partial<Omit<CommitRequest, "message">> = {}): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/commits`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, ...options } satisfies CommitRequest),
    });
  }

  listTasks(): Promise<TaskSnapshotResponse[]> {
    return this.request<TaskSnapshotResponse[]>("/api/v1/tasks");
  }

  cancelTask(taskId: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/tasks/${encodeURIComponent(taskId)}/cancel`, true, {
      method: "POST",
    });
  }

  fetchRepository(repoId: RepoId, prune = false): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/fetch`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prune }),
    });
  }

  cloneRepository(remoteUrl: string, parentPath: string, directoryName: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>("/api/v1/clones", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteUrl, parentPath, directoryName }),
    });
  }

  private async request<T>(path: string, versioned = true, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (versioned) {
      headers.set("X-GitCrest-API-Version", "1");
    }

    const response = await this.fetcher(new URL(path, this.baseUrl), { ...init, headers });
    if (!response.ok) {
      const body = (await response.json()) as ApiErrorResponse;
      throw new GitCrestApiError(response.status, body);
    }

    if (versioned && response.headers.get("X-GitCrest-API-Version") !== "1") {
      throw new Error("The GitCrest engine did not confirm API version 1.");
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
