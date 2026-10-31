import type { components, paths } from "./schema";

export type RepoId = components["schemas"]["RepoId"];
export type ApiErrorResponse = components["schemas"]["ApiErrorResponse"];
export type VersionResponse = components["schemas"]["VersionResponse"];
export type RepositoryResponse = components["schemas"]["Repository"];
export type StatusSnapshotResponse = components["schemas"]["StatusSnapshot"];
export type TaskSnapshotResponse = components["schemas"]["TaskSnapshot"];
export type DiffDocumentResponse = components["schemas"]["DiffDocument"];
export type DiffContext = components["parameters"]["DiffContext"];
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
export type WorktreeSnapshotResponse = components["schemas"]["WorktreeSnapshot"];
export type BranchSwitchPreflightResponse = components["schemas"]["BranchSwitchPreflight"];
export type WorkflowPreflightResponse = components["schemas"]["WorkflowPreflight"];
export type RebasePreviewResponse = components["schemas"]["RebasePreview"];
export type RebaseBackupSnapshotResponse = components["schemas"]["RebaseBackupSnapshot"];
export type ResetPreviewResponse = components["schemas"]["ResetPreview"];
export type ResetBackupSnapshotResponse = components["schemas"]["ResetBackupSnapshot"];
export type WorkflowRecoveryPreflightResponse = components["schemas"]["WorkflowRecoveryPreflight"];
export type WorkflowConflictFileResponse = components["schemas"]["WorkflowConflictFile"];
export type WorkflowConflictMutationRequest = components["schemas"]["WorkflowConflictMutationRequest"];
export type WorkflowConflictChooseRequest = components["schemas"]["WorkflowConflictChooseRequest"];
export type WorkflowConflictSaveRequest = components["schemas"]["WorkflowConflictSaveRequest"];
export type WorkflowConflictSuggestionRequest = components["schemas"]["WorkflowConflictSuggestionRequest"];
export type RemoteSnapshotResponse = components["schemas"]["RemoteSnapshot"];
export type CredentialStatusResponse = components["schemas"]["CredentialStatus"];
export type IgnoreRuleResponse = components["schemas"]["IgnoreRule"];
export type StashPreviewResponse = components["schemas"]["StashPreview"];
export type ReflogPageResponse = components["schemas"]["ReflogPage"];
export type CompareResultResponse = components["schemas"]["CompareResult"];
export type SubmoduleListResponse = components["schemas"]["SubmoduleList"];
export type LfsStatusResponse = components["schemas"]["LfsStatus"];
export type SigningConfigResponse = components["schemas"]["SigningConfig"];
export type SigningTestResponse = components["schemas"]["SigningTestResult"];
export type StashEntryResponse = components["schemas"]["StashEntry"];
export type StashListResponse = components["schemas"]["StashList"];
export type TagPageResponse = components["schemas"]["TagPage"];
export type RemoteTagPreviewResponse = components["schemas"]["RemoteTagPreview"];
export type TagEntryResponse = components["schemas"]["TagEntry"];
export type GitIdentityResponse = components["schemas"]["GitIdentity"];
export type PipelineAppSettingsResponse = components["schemas"]["PipelineAppSettings"];
export type PipelineRepositorySettingsResponse = components["schemas"]["PipelineRepositorySettings"];
export type PipelineRepositorySettingsRequest = components["schemas"]["PipelineRepositorySettingsRequest"];
export type PipelineRule = components["schemas"]["PipelineRule"];
export type PipelineRunResponse = components["schemas"]["PipelineRun"];
export type PipelineRunStepResponse = components["schemas"]["PipelineRunStep"];
export type PipelineRunActionKind = components["schemas"]["PipelineRunActionRequest"]["action"];
export type StartPipelineRunRequest = components["schemas"]["StartPipelineRunRequest"];
export type PipelineRulesDocument = components["schemas"]["PipelineRulesDocument"];
export type PipelineRulesExportResponse = components["schemas"]["PipelineRulesExport"];
export type ImportPipelineRulesResponse = components["schemas"]["ImportPipelineRulesResult"];
export type HostingProvider = components["schemas"]["HostingProvider"];
export type AccountResponse = components["schemas"]["Account"];
export type AccountListResponse = components["schemas"]["AccountList"];
export type BrowserSignInHost = components["schemas"]["BrowserSignInHost"];
export type DeviceFlowResponse = components["schemas"]["DeviceFlow"];
export type AiSettingsResponse = components["schemas"]["AiSettings"];
export type ConflictWindowAiSettingsResponse = components["schemas"]["ConflictWindowAiSettings"];
export type AiProviderResponse = components["schemas"]["AiProvider"];
export type AiProviderInput = components["schemas"]["AiProviderInput"];
export type AiSettingsRequest = components["schemas"]["AiSettingsRequest"];
export type AiApiFormat = components["schemas"]["AiApiFormat"];
export type AiProviderTestReply = components["schemas"]["AiProviderTestReply"];
export type AiReplyResponse = components["schemas"]["AiReply"];
export type AiFileSelection = components["schemas"]["AiFileSelection"];
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

/** Reads an error response, which a proxy or the HTTP layer may send without the API error shape. */
async function readErrorBody(response: Response): Promise<ApiErrorResponse> {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text) as Partial<ApiErrorResponse>;
    if (body.error && typeof body.error.code === "string" && typeof body.error.message === "string") {
      return body as ApiErrorResponse;
    }
  } catch {
    // Not JSON: described below from the status and text.
  }
  const detail = text.trim().slice(0, 200);
  return {
    error: {
      code: "INTERNAL_ERROR",
      message: `The GitCrest core answered with HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
    },
  };
}

export class GitCrestApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  withSignal(signal: AbortSignal): GitCrestApiClient {
    return new GitCrestApiClient(this.baseUrl, this.token, (input, init) =>
      this.fetcher(input, { ...init, signal }),
    );
  }

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

  getRepositoryStatus(repoId: RepoId, forceRefresh = false): Promise<StatusSnapshotResponse> {
    const query = forceRefresh ? "?refresh=true" : "";
    return this.request<StatusSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/status${query}`);
  }

  getRepositoryStatusPaths(repoId: RepoId, paths: string[]): Promise<StatusSnapshotResponse> {
    const query = new URLSearchParams();
    for (const path of paths) query.append("paths", path);
    return this.request<StatusSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/status?${query}`,
    );
  }

  getFileDiff(repoId: RepoId, path: string, scope: "workingTree" | "index", context: DiffContext = "hunks"): Promise<DiffDocumentResponse> {
    const query = new URLSearchParams({ path, scope });
    if (context !== "hunks") query.set("context", context);
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

  getRepositoryCommitDiff(repoId: RepoId, oid: string, path: string, context: DiffContext = "hunks"): Promise<DiffDocumentResponse> {
    const query = new URLSearchParams({ path });
    if (context !== "hunks") query.set("context", context);
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

  getRepositoryWorktrees(repoId: RepoId): Promise<WorktreeSnapshotResponse> {
    return this.request<WorktreeSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/worktrees`);
  }

  addRepositoryWorktree(repoId: RepoId, branch: string, path: string, fromRemote = false, copyFiles: string[] = []): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/worktrees/add`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch, path, ...(fromRemote ? { fromRemote: true } : {}), ...(copyFiles.length > 0 ? { copyFiles } : {}) } as components["schemas"]["AddWorktreeRequest"]),
    });
  }

  listWorktreeLocalFiles(repoId: RepoId): Promise<components["schemas"]["CopyableFiles"]> {
    return this.request<components["schemas"]["CopyableFiles"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/worktrees/local-files`);
  }

  checkWorktreeFolder(repoId: RepoId, path: string): Promise<components["schemas"]["WorktreeFolderCheck"]> {
    const query = new URLSearchParams({ path });
    return this.request<components["schemas"]["WorktreeFolderCheck"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/worktrees/folder-check?${query}`);
  }

  pruneRepositoryWorktrees(repoId: RepoId): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/worktrees/prune`, true, {
      method: "POST",
    });
  }

  removeRepositoryWorktree(repoId: RepoId, path: string, force = false, branch: { deleteBranch?: boolean; allowUnmerged?: boolean } = {}): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/worktrees/remove`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, force, deleteBranch: Boolean(branch.deleteBranch), allowUnmerged: Boolean(branch.deleteBranch && branch.allowUnmerged) } satisfies components["schemas"]["RemoveWorktreeRequest"]),
    });
  }

  createRepositoryBranch(repoId: RepoId, name: string, options: { checkout?: boolean; worktreePath?: string; startPoint?: string; copyFiles?: string[] } = {}): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, ...(options.checkout ? { checkout: true } : {}), ...(options.worktreePath ? { worktreePath: options.worktreePath } : {}), ...(options.startPoint ? { startPoint: options.startPoint } : {}), ...(options.copyFiles && options.copyFiles.length > 0 ? { copyFiles: options.copyFiles } : {}) } as components["schemas"]["CreateBranchRequest"]),
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

  /** With `remote`, `name` is a remote-tracking branch such as `origin/feature`. */
  preflightRepositoryBranchSwitch(repoId: RepoId, name: string, remote = false, commit = false): Promise<BranchSwitchPreflightResponse> {
    const query = new URLSearchParams({ name });
    if (remote) query.set("remote", "true");
    if (commit) query.set("commit", "true");
    return this.request<BranchSwitchPreflightResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/switch-preflight?${query}`);
  }

  /** With `remote`, the remote branch is fetched and checked out through a local tracking branch. */
  switchRepositoryBranch(repoId: RepoId, name: string, remote = false, commit = false): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/branches/switch`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, remote, commit } satisfies components["schemas"]["BranchSwitchRequest"]),
    });
  }

  getRepositoryRemotes(repoId: RepoId): Promise<RemoteSnapshotResponse> {
    return this.request<RemoteSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/remotes`);
  }

  previewIgnoreRule(repoId: RepoId, path: string, mode: components["schemas"]["IgnoreMode"], target: components["schemas"]["IgnoreTarget"]): Promise<IgnoreRuleResponse> {
    const query = new URLSearchParams({ path, mode, target });
    return this.request<IgnoreRuleResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/ignore-preview?${query}`);
  }

  addIgnoreRule(repoId: RepoId, path: string, mode: components["schemas"]["IgnoreMode"], target: components["schemas"]["IgnoreTarget"]): Promise<IgnoreRuleResponse> {
    return this.request<IgnoreRuleResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/ignore`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, mode, target } satisfies components["schemas"]["IgnoreRuleRequest"]),
    });
  }

  previewStash(repoId: RepoId, oid: string): Promise<StashPreviewResponse> {
    const query = new URLSearchParams({ oid });
    return this.request<StashPreviewResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/stashes/preview?${query}`);
  }

  applyStash(repoId: RepoId, oid: string, pop: boolean, expectedHeadOid: string | null): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/stashes/apply`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oid, pop, expectedHeadOid } satisfies components["schemas"]["StashApplyRequest"]),
    });
  }

  listSubmodules(repoId: RepoId): Promise<SubmoduleListResponse> {
    return this.request<SubmoduleListResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/submodules`);
  }

  /** Queues checking out the recorded commits; an empty `paths` means every submodule that can be updated. */
  updateSubmodules(repoId: RepoId, request: { paths: string[]; init: boolean }): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/submodules/update`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request satisfies components["schemas"]["SubmoduleUpdateRequest"]),
    });
  }

  dropStash(repoId: RepoId, oid: string): Promise<components["schemas"]["StashDropped"]> {
    return this.request<components["schemas"]["StashDropped"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/stashes/drop`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oid } satisfies components["schemas"]["StashDropRequest"]),
    });
  }

  importStash(repoId: RepoId, oid: string, name: string, dropAfter: boolean): Promise<components["schemas"]["StashImported"]> {
    return this.request<components["schemas"]["StashImported"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/stashes/import`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oid, name, dropAfter } satisfies components["schemas"]["StashImportRequest"]),
    });
  }

  getRepositoryReflog(repoId: RepoId, options: { ref?: string; offset?: number; limit?: number } = {}): Promise<ReflogPageResponse> {
    const query = new URLSearchParams();
    if (options.ref) query.set("ref", options.ref);
    if (options.offset) query.set("offset", String(options.offset));
    if (options.limit) query.set("limit", String(options.limit));
    return this.request<ReflogPageResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/reflog?${query}`);
  }

  compareRevisions(repoId: RepoId, options: { base: string; head?: string; mode?: "threeDot" | "twoDot"; offset?: number; limit?: number }): Promise<CompareResultResponse> {
    const query = new URLSearchParams({ base: options.base });
    if (options.head) query.set("head", options.head);
    if (options.mode) query.set("mode", options.mode);
    if (options.offset) query.set("offset", String(options.offset));
    if (options.limit) query.set("limit", String(options.limit));
    return this.request<CompareResultResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/compare?${query}`);
  }

  /** One file of a comparison; `to` is left out to compare with the working tree. */
  getRepositoryCompareDiff(repoId: RepoId, request: { from: string; to?: string; path: string }): Promise<DiffDocumentResponse> {
    const query = new URLSearchParams({ from: request.from, path: request.path });
    if (request.to) query.set("to", request.to);
    return this.request<DiffDocumentResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/compare/diff?${query}`);
  }

  /** One side of an image file: the image bytes, its media type and size. */
  getRepositoryImage(repoId: RepoId, request: { path: string; scope: "workingTree" | "index" | "commit"; side: "old" | "new"; commitOid?: string; originalPath?: string }): Promise<{ blob: Blob; type: string; size: number }> {
    const query = new URLSearchParams({ path: request.path, scope: request.scope, side: request.side });
    if (request.commitOid) query.set("commitOid", request.commitOid);
    if (request.originalPath) query.set("originalPath", request.originalPath);
    return this.request(`/api/v1/repositories/${encodeURIComponent(repoId)}/image?${query}`, true, {}, async (response) => {
      const blob = await response.blob();
      return { blob, type: response.headers.get("Content-Type") ?? blob.type, size: blob.size };
    });
  }

  getGitLfsStatus(): Promise<LfsStatusResponse> {
    return this.request<LfsStatusResponse>("/api/v1/git/lfs");
  }

  getRepositorySigning(repoId: RepoId): Promise<SigningConfigResponse> {
    return this.request<SigningConfigResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/signing`);
  }

  testRepositorySigning(repoId: RepoId): Promise<SigningTestResponse> {
    return this.request<SigningTestResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/signing/test`, true, { method: "POST" });
  }

  getRepositoryStashes(repoId: RepoId): Promise<StashListResponse> {
    return this.request<StashListResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/stashes`);
  }

  getRepositoryTags(repoId: RepoId, options: { offset?: number; limit?: number; filter?: string; targets?: readonly string[] } = {}): Promise<TagPageResponse> {
    const query = new URLSearchParams();
    if (options.offset) query.set("offset", String(options.offset));
    if (options.limit) query.set("limit", String(options.limit));
    if (options.filter) query.set("filter", options.filter);
    if (options.targets) query.set("targets", options.targets.join(","));
    return this.request<TagPageResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/tags?${query}`);
  }

  deleteRepositoryTag(repoId: RepoId, name: string, expectedTargetOid: string): Promise<components["schemas"]["DeletedTag"]> {
    return this.request<components["schemas"]["DeletedTag"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/tags/delete`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, expectedTargetOid } satisfies components["schemas"]["DeleteTagRequest"]),
    });
  }

  previewRemoteTag(repoId: RepoId, remoteName: string, name: string): Promise<RemoteTagPreviewResponse> {
    const query = new URLSearchParams({ remoteName, name });
    return this.request<RemoteTagPreviewResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/tags/remote-preview?${query}`);
  }

  pushRepositoryTag(repoId: RepoId, remoteName: string, name: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/tags/push`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteName, name } satisfies components["schemas"]["PushTagRequest"]),
    });
  }

  deleteRemoteTag(repoId: RepoId, remoteName: string, name: string, expectedRemoteOid: string): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/tags/remote-delete`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteName, name, expectedRemoteOid } satisfies components["schemas"]["DeleteRemoteTagRequest"]),
    });
  }

  getGlobalIdentity(): Promise<GitIdentityResponse> {
    return this.request<GitIdentityResponse>("/api/v1/identity");
  }

  setGlobalIdentity(name: string, email: string): Promise<GitIdentityResponse> {
    return this.request<GitIdentityResponse>("/api/v1/identity", true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email } satisfies components["schemas"]["SetIdentityRequest"]),
    });
  }

  getPipelineAppSettings(): Promise<PipelineAppSettingsResponse> {
    return this.request<PipelineAppSettingsResponse>("/api/v1/settings/pipelines");
  }

  setPipelineAppSettings(settings: PipelineAppSettingsResponse): Promise<PipelineAppSettingsResponse> {
    return this.request<PipelineAppSettingsResponse>("/api/v1/settings/pipelines", true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  getPipelineRepositorySettings(repoId: RepoId): Promise<PipelineRepositorySettingsResponse> {
    return this.request<PipelineRepositorySettingsResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/settings`);
  }

  setPipelineRepositorySettings(repoId: RepoId, settings: PipelineRepositorySettingsRequest): Promise<PipelineRepositorySettingsResponse> {
    return this.request<PipelineRepositorySettingsResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/settings`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  }

  async listPipelineRules(repoId: RepoId): Promise<PipelineRule[]> {
    const body = await this.request<components["schemas"]["PipelineRules"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/rules`);
    return body.rules;
  }

  async replacePipelineRules(repoId: RepoId, rules: PipelineRule[]): Promise<PipelineRule[]> {
    const body = await this.request<components["schemas"]["PipelineRules"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/rules`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules } satisfies components["schemas"]["PipelineRules"]),
    });
    return body.rules;
  }

  exportPipelineRules(repoId: RepoId): Promise<PipelineRulesDocument> {
    return this.request<PipelineRulesDocument>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/rules/export`);
  }

  writePipelineRulesFile(repoId: RepoId): Promise<PipelineRulesExportResponse> {
    return this.request<PipelineRulesExportResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/rules/export`, true, { method: "POST" });
  }

  /** Reads `.gitcrest/pipelines.json` (or the given document); nothing is saved unless `apply` is set. */
  importPipelineRules(repoId: RepoId, options: { apply: boolean; document?: PipelineRulesDocument }): Promise<ImportPipelineRulesResponse> {
    return this.request<ImportPipelineRulesResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/rules/import`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
  }

  async listPipelineRuns(repoId: RepoId, limit = 50): Promise<PipelineRunResponse[]> {
    const body = await this.request<components["schemas"]["PipelineRuns"]>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/runs?limit=${limit}`);
    return body.runs;
  }

  startPipelineRun(repoId: RepoId, request: StartPipelineRunRequest): Promise<PipelineRunResponse> {
    return this.request<PipelineRunResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/runs`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  actOnPipelineRun(repoId: RepoId, runId: string, action: PipelineRunActionKind): Promise<PipelineRunResponse> {
    return this.request<PipelineRunResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/pipelines/runs/${encodeURIComponent(runId)}/actions`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action } satisfies components["schemas"]["PipelineRunActionRequest"]),
    });
  }

  getRepositoryIdentity(repoId: RepoId): Promise<GitIdentityResponse> {
    return this.request<GitIdentityResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/identity`);
  }

  setRepositoryIdentity(repoId: RepoId, name: string, email: string): Promise<GitIdentityResponse> {
    return this.request<GitIdentityResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/identity`, true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email } satisfies components["schemas"]["SetIdentityRequest"]),
    });
  }

  clearRepositoryIdentity(repoId: RepoId): Promise<GitIdentityResponse> {
    return this.request<GitIdentityResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/identity`, true, { method: "DELETE" });
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

  listAccounts(): Promise<AccountListResponse> {
    return this.request<AccountListResponse>("/api/v1/accounts");
  }

  signInWithToken(provider: HostingProvider, host: string, token: string): Promise<AccountResponse> {
    return this.request<AccountResponse>("/api/v1/accounts/tokens", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, host, token } satisfies components["schemas"]["TokenSignInRequest"]),
    });
  }

  startDeviceFlow(provider: HostingProvider, host: string): Promise<DeviceFlowResponse> {
    return this.request<DeviceFlowResponse>("/api/v1/accounts/device-flows", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, host } satisfies components["schemas"]["DeviceFlowRequest"]),
    });
  }

  getDeviceFlow(flowId: string): Promise<DeviceFlowResponse> {
    return this.request<DeviceFlowResponse>(`/api/v1/accounts/device-flows/${encodeURIComponent(flowId)}`);
  }

  cancelDeviceFlow(flowId: string): Promise<void> {
    return this.request<void>(`/api/v1/accounts/device-flows/${encodeURIComponent(flowId)}`, true, { method: "DELETE" });
  }

  selectAccount(accountId: string): Promise<AccountResponse> {
    return this.request<AccountResponse>(`/api/v1/accounts/${encodeURIComponent(accountId)}/select`, true, { method: "POST" });
  }

  validateAccount(accountId: string): Promise<AccountResponse> {
    return this.request<AccountResponse>(`/api/v1/accounts/${encodeURIComponent(accountId)}/validate`, true, { method: "POST" });
  }

  signOutAccount(accountId: string): Promise<void> {
    return this.request<void>(`/api/v1/accounts/${encodeURIComponent(accountId)}`, true, { method: "DELETE" });
  }

  getAiSettings(): Promise<AiSettingsResponse> {
    return this.request<AiSettingsResponse>("/api/v1/ai/settings");
  }

  getRepositoryWorkflowConflictAiSettings(repoId: RepoId): Promise<ConflictWindowAiSettingsResponse> {
    return this.request<ConflictWindowAiSettingsResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/conflicts/ai-settings`,
    );
  }

  setAiSettings(settings: AiSettingsRequest): Promise<AiSettingsResponse> {
    return this.request<AiSettingsResponse>("/api/v1/ai/settings", true, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings satisfies AiSettingsRequest),
    });
  }

  testAiProvider(provider: AiProviderInput): Promise<AiProviderTestReply> {
    return this.request<AiProviderTestReply>("/api/v1/ai/providers/test", true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider } satisfies components["schemas"]["AiProviderTestRequest"]),
    });
  }

  requestAiReview(repoId: RepoId, prompt: string, files: AiFileSelection[]): Promise<AiReplyResponse> {
    return this.request<AiReplyResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/ai/request`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, files } satisfies components["schemas"]["AiRequest"]),
    });
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

  undoRecentOperation(repoId: RepoId): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/undo`, true, {
      method: "POST",
    });
  }

  /** With `background`, a scheduled fetch that the core skips (409) while the repository has another task. */
  fetchRepository(repoId: RepoId, prune = false, background = false): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(`/api/v1/repositories/${encodeURIComponent(repoId)}/fetch`, true, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(background ? { prune, background } : { prune }),
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

  requestRepositoryWorkflowConflictSuggestion(
    repoId: RepoId,
    request: WorkflowConflictSuggestionRequest,
  ): Promise<AiReplyResponse> {
    return this.request<AiReplyResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/conflicts/suggestion`,
      true,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) },
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

  adoptRepositoryWorkflow(repoId: RepoId): Promise<components["schemas"]["WorkflowAdoption"]> {
    return this.request<components["schemas"]["WorkflowAdoption"]>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/adopt`,
      true,
      { method: "POST" },
    );
  }

  chooseRepositoryWorkflowConflictSide(
    repoId: RepoId,
    request: WorkflowConflictChooseRequest,
  ): Promise<TaskSnapshotResponse> {
    return this.request<TaskSnapshotResponse>(
      `/api/v1/repositories/${encodeURIComponent(repoId)}/workflows/conflicts/choose`,
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

  private async request<T>(path: string, versioned = true, init: RequestInit = {}, read: (response: Response) => Promise<T> = (response) => response.json() as Promise<T>): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.token}`);
    if (versioned) {
      headers.set("X-GitCrest-API-Version", "1");
    }

    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.baseUrl), { ...init, headers });
    } catch (error) {
      // An aborted request stays an AbortError; a refused connection gets a message a person can act on.
      if (init.signal?.aborted || (error as { name?: unknown } | undefined)?.name === "AbortError") throw error;
      throw new Error("The local GitCrest core did not respond. If it stopped, GitCrest restarts it; try again in a moment.");
    }
    if (!response.ok) {
      throw new GitCrestApiError(response.status, await readErrorBody(response));
    }

    if (versioned && response.headers.get("X-GitCrest-API-Version") !== "1") {
      throw new Error("The GitCrest engine did not confirm API version 1.");
    }

    if (response.status === 204) return undefined as T;
    return read(response);
  }
}
