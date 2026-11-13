import { GitCrestApiError, type GitCrestApiClient, type OperationCreatedResponse, type OperationPreviewInputRequest, type RepoId } from "../../../api/client";

export type StartOperationResult =
  | { readonly kind: "started"; readonly created: OperationCreatedResponse }
  | { readonly kind: "disabled" };

/**
 * Reviews and registers one operation. The preview is the only source of the request body, so the
 * server-computed fingerprint reaches creation unchanged. A rollout-disabled server answers 403
 * OPERATION_CREATION_DISABLED to the preview, reported as `disabled` so callers can fall back to the
 * existing flow. `requestId` is the idempotency key: reuse it when retrying after a lost response.
 */
export async function startOperation(
  api: GitCrestApiClient,
  repoId: RepoId,
  input: OperationPreviewInputRequest,
  requestId: string,
): Promise<StartOperationResult> {
  try {
    const request = await api.previewRepositoryOperation(repoId, input);
    const created = await api.createRepositoryOperation(repoId, { requestId, request });
    return { kind: "started", created };
  } catch (reason) {
    if (reason instanceof GitCrestApiError && reason.status === 403 && reason.body.error.code === "OPERATION_CREATION_DISABLED") {
      return { kind: "disabled" };
    }
    throw reason;
  }
}
