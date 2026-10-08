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
export type DiscardPatchRequest = components["schemas"]["DiscardPatchRequest"];
export type ShelfResponse = components["schemas"]["Shelf"];
export type ShelfDetailResponse = components["schemas"]["ShelfDetail"];
export type ShelfCreateRequest = components["schemas"]["ShelfCreateRequest"];
export type ShelfApplyPreviewResponse = components["schemas"]["ShelfApplyPreview"];
export type ShelfApplyRequest = components["schemas"]["ShelfApplyRequest"];
export type CommitRequest = components["schemas"]["CommitRequest"];
export type CommitPageResponse = components["schemas"]["CommitPage"];
export type CommitDetailResponse = components["schemas"]["CommitDetail"];
export type RefSnapshotResponse = components["schemas"]["RefSnapshot"];
export type BranchSnapshotResponse = components["schemas"]["BranchSnapshot"];
export type RemoteBranchDeletePreviewResponse = components["schemas"]["RemoteBranchDeletePreview"];
export type BranchSwitchPreflightResponse = components["schemas"]["BranchSwitchPreflight"];
export type WorkflowPreflightResponse = components["schemas"]["WorkflowPreflight"];
export type RebasePreviewResponse = components["schemas"]["RebasePreview"];
export type RebaseBackupSnapshotResponse = components["schemas"]["RebaseBackupSnapshot"];
export type ResetPreviewResponse = components["schemas"]["ResetPreview"];
export type ResetBackupSnapshotResponse = components["schemas"]["ResetBackupSnapshot"];
export type WorkflowRecoveryPreflightResponse = components["schemas"]["WorkflowRecoveryPreflight"];
export type WorkflowConflictFileResponse = components["schemas"]["WorkflowConflictFile"];
export type WorkflowConflictMutationRequest = components["schemas"]["WorkflowConflictMutationRequest"];
export type WorkflowConflictSaveRequest = components["schemas"]["WorkflowConflictSaveRequest"];
export type RemoteSnapshotResponse = components["schemas"]["RemoteSnapshot"];
export type CredentialStatusResponse = components["schemas"]["CredentialStatus"];
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

  createRepositoryBranch(repoId: RepoId, name: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name } satisfies components["schemas"]["CreateBranchRequest"]),
    });
  }

  renameRepositoryBranch(repoId: RepoId, name: string, newName: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/rename`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, newName } satisfies components["schemas"]["RenameBranchRequest"]),
    });
  }

  previewRepositoryBranchDelete(repoId: RepoId, name: string): Promise<components["schemas"]["BranchDeletePreview"]> {
    return this.request<components["schemas"]["BranchDeletePreview"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/delete-preview`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name } satisfies components["schemas"]["BranchNameRequest"]),
    });
  }

  deleteRepositoryBranch(repoId: RepoId, name: string, allowUnmerged = false): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/delete`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, allowUnmerged } satisfies components["schemas"]["DeleteBranchRequest"]),
    });
  }

  previewRepositoryRemoteBranchDelete(repoId: RepoId, remoteName: string, remoteBranch: string): Promise<RemoteBranchDeletePreviewResponse> {
    const query = new URLSearchParams({ remoteName, remoteBranch });
    return this.request<RemoteBranchDeletePreviewResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/branches/remote-delete-preview?${query}`,
    );
  }

  deleteRepositoryRemoteBranch(repoId: RepoId, request: components["schemas"]["RemoteBranchDeleteRequest"]): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/branches/remote-delete`,
      true,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  }

  setRepositoryBranchFavorite(repoId: RepoId, fullName: string, favorite: boolean): Promise<BranchSnapshotResponse> {
    return this.request<BranchSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/favorite`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName, favorite } satisfies components["schemas"]["BranchFavoriteRequest"]),
    });
  }

  preflightRepositoryBranchSwitch(repoId: RepoId, name: string): Promise<BranchSwitchPreflightResponse> {
    const query = new URLSearchParams({ name });
    return this.request<BranchSwitchPreflightResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/switch-preflight?${query}`);
  }

  switchRepositoryBranch(repoId: RepoId, name: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/switch`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name } satisfies components["schemas"]["BranchNameRequest"]),
    });
  }

  getRepositoryRemotes(repoId: RepoId): Promise<RemoteSnapshotResponse> {
    return this.request<RemoteSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/remotes`);
  }

  getCredentialStatus(host: string): Promise<CredentialStatusResponse> {
    const query = new URLSearchParams({ host });
    return this.request<CredentialStatusResponse>(`/api/v1/credentials?${query}`);
  }

  setCredential(host: string, username: string, token: string): Promise<CredentialStatusResponse> {
    return this.request<CredentialStatusResponse>("/api/v1/credentials", true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, username, token } satisfies components["schemas"]["SetCredentialRequest"]),
    });
  }

  deleteCredential(host: string): Promise<void> {
    const query = new URLSearchParams({ host });
    return this.request<void>(`/api/v1/credentials?${query}`, true, { method: "DELETE" });
  }

  addRepositoryRemote(repoId: RepoId, name: string, url: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/remotes`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url } satisfies components["schemas"]["RemoteUrlRequest"]),
    });
  }

  setRepositoryRemoteUrl(repoId: RepoId, name: string, url: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/remotes/url`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url } satisfies components["schemas"]["RemoteUrlRequest"]),
    });
  }

  deleteRepositoryRemote(repoId: RepoId, name: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/remotes/delete`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name } satisfies components["schemas"]["BranchNameRequest"]),
    });
  }

  setRepositoryDefaultRemote(repoId: RepoId, name: string | null): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/remotes/default`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name } satisfies components["schemas"]["DefaultRemoteRequest"]),
    });
  }

  setRepositoryBranchUpstream(repoId: RepoId, localBranch: string, remoteName: string, remoteBranch: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/remotes/upstream`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ localBranch, remoteName, remoteBranch } satisfies components["schemas"]["BranchUpstreamRequest"]),
    });
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

  discardSelectedDiffChanges(repoId: RepoId, request: DiscardPatchRequest): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>("/api/v1/repositories/" + encodeURIComponent(repoId) + "/staging/discard", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  listRepositoryShelves(repoId: RepoId): Promise<ShelfResponse[]> {
    return this.request<ShelfResponse[]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/shelves`);
  }

  createRepositoryShelf(repoId: RepoId, request: ShelfCreateRequest): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/shelves`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  getRepositoryShelf(repoId: RepoId, shelfId: string): Promise<ShelfDetailResponse> {
    return this.request<ShelfDetailResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/shelves/${encodeURIComponent(shelfId)}`);
  }

  deleteRepositoryShelf(repoId: RepoId, shelfId: string): Promise<void> {
    return this.request<void>(`/api/v1/repositories/${encodeURIComponent(repoId)}/shelves/${encodeURIComponent(shelfId)}`, true, {
      method: "DELETE",
    });
  }

  preflightRepositoryShelfApply(repoId: RepoId, shelfId: string): Promise<ShelfApplyPreviewResponse> {
    return this.request<ShelfApplyPreviewResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/shelves/${encodeURIComponent(shelfId)}/apply-preview`);
  }

  applyRepositoryShelf(repoId: RepoId, shelfId: string, request: ShelfApplyRequest): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/shelves/${encodeURIComponent(shelfId)}/apply`, true, {
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

  preflightRepositoryPull(repoId: RepoId): Promise<components["schemas"]["PullPreflight"]> {
    return this.request<components["schemas"]["PullPreflight"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pull-preflight`);
  }

  pullRepository(
    repoId: RepoId,
    request: components["schemas"]["PullRequest"],
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pull`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  preflightRepositoryWorkflow(
    repoId: RepoId,
    action: components["schemas"]["WorkflowPreflight"]["action"],
    targetOid: string,
  ): Promise<WorkflowPreflightResponse> {
    const query = new URLSearchParams({ action, targetOid });
    return this.request<WorkflowPreflightResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/preflight?${query}`);
  }

  preflightRepositoryRebase(repoId: RepoId, ontoOid: string): Promise<RebasePreviewResponse> {
    const query = new URLSearchParams({ ontoOid });
    return this.request<RebasePreviewResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/rebase-preview?${query}`,
    );
  }

  startRepositoryRebase(
    repoId: RepoId,
    request: components["schemas"]["RebaseRequest"],
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/rebase-preview`,
      true,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  }

  getRepositoryRebaseBackups(repoId: RepoId): Promise<RebaseBackupSnapshotResponse> {
    return this.request<RebaseBackupSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/rebase-backups`,
    );
  }

  rollbackRepositoryRebase(
    repoId: RepoId,
    request: components["schemas"]["RebaseRollbackRequest"],
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/rebase-rollback`,
      true,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  }

  preflightRepositoryReset(repoId: RepoId, targetOid: string, mode: components["schemas"]["ResetMode"]): Promise<ResetPreviewResponse> {
    const query = new URLSearchParams({ targetOid, mode });
    return this.request<ResetPreviewResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/reset-preview?${query}`,
    );
  }

  startRepositoryReset(repoId: RepoId, request: components["schemas"]["ResetRequest"]): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/reset-preview`,
      true,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  }

  getRepositoryResetBackups(repoId: RepoId): Promise<ResetBackupSnapshotResponse> {
    return this.request<ResetBackupSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/reset-backups`,
    );
  }

  restoreRepositoryReset(repoId: RepoId, request: components["schemas"]["ResetRestoreRequest"]): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/reset-restore`,
      true,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  }

  startRepositoryWorkflow(
    repoId: RepoId,
    request: components["schemas"]["WorkflowRequest"],
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/workflows`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  preflightRepositoryWorkflowRecovery(
    repoId: RepoId,
    taskId: string,
  ): Promise<WorkflowRecoveryPreflightResponse> {
    const query = new URLSearchParams({ taskId });
    return this.request<WorkflowRecoveryPreflightResponse>(
      "/api/v1/repositories/" + encodeURIComponent(repoId) + "/workflows/recovery-preflight?" + query,
    );
  }

  recoverRepositoryWorkflow(
    repoId: RepoId,
    request: components["schemas"]["WorkflowRecoveryRequest"],
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      "/api/v1/repositories/" + encodeURIComponent(repoId) + "/workflows/recovery",
      true,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
    );
  }

  getRepositoryWorkflowConflictFile(
    repoId: RepoId,
    taskId: string,
    path: string,
  ): Promise<WorkflowConflictFileResponse> {
    const query = new URLSearchParams({ taskId, path });
    return this.request<WorkflowConflictFileResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/conflicts/file?${query}`,
    );
  }

  saveRepositoryWorkflowConflictFile(
    repoId: RepoId,
    request: WorkflowConflictSaveRequest,
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/conflicts/file`,
      true,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
    );
  }

  markRepositoryWorkflowConflictResolved(
    repoId: RepoId,
    request: WorkflowConflictMutationRequest,
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/conflicts/resolved`,
      true,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
    );
  }

  preflightRepositoryPush(
    repoId: RepoId,
    target?: Pick<components["schemas"]["PushRequest"], "remoteName" | "remoteBranch">,
  ): Promise<components["schemas"]["PushPreflight"]> {
    const query = new URLSearchParams();
    if (target?.remoteName) query.set("remoteName", target.remoteName);
    if (target?.remoteBranch) query.set("remoteBranch", target.remoteBranch);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<components["schemas"]["PushPreflight"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/push-preflight${suffix}`);
  }

  pushRepository(
    repoId: RepoId,
    request: components["schemas"]["PushRequest"],
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/push`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
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
