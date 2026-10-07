import type { components, paths } from "./schema";

export type RepoId = components["schemas"]["RepoId"];
export type ApiErrorResponse = components["schemas"]["ApiErrorResponse"];
export type VersionResponse = components["schemas"]["VersionResponse"];
export type RepositoryResponse = components["schemas"]["Repository"];

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

  listRepositories(): Promise<RepositoryResponse[]> {
    return this.request<RepositoryResponse[]>("/api/v1/repositories");
  }

  private async request<T>(path: string, versioned = true): Promise<T> {
    const headers = new Headers({ Authorization: `Bearer ${this.token}` });
    if (versioned) {
      headers.set("X-GitCrest-API-Version", "1");
    }

    const response = await this.fetcher(new URL(path, this.baseUrl), { headers });
    if (!response.ok) {
      const body = (await response.json()) as ApiErrorResponse;
      throw new GitCrestApiError(response.status, body);
    }

    if (versioned && response.headers.get("X-GitCrest-API-Version") !== "1") {
      throw new Error("The GitCrest engine did not confirm API version 1.");
    }

    return (await response.json()) as T;
  }
}
