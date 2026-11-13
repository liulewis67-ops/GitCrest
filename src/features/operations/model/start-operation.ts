import { GitCrestApiError, type GitCrestApiClient, type OperationCreatedResponse, type OperationPreviewInputRequest, type OperationRequestResponse, type RepoId } from "../../../api/client";

export type StartOperationResult =
  | { readonly kind: "started"; readonly created: OperationCreatedResponse }
  | { readonly kind: "disabled" };

/**
 * Reviews and registers one operation. The preview is the only source of the request body, so the
 * server-computed fingerprint reaches creation unchanged. `disabled` means the caller should use the existing
 * flow: either the rollout flag is off (403 OPERATION_CREATION_DISABLED), or this core is too old to have the
 * operation routes at all (404 or 405 on the preview), which must keep working and not pretend to support
 * recovery. `requestId` is the idempotency key: reuse it when retrying after a lost response.
 */
export async function startOperation(
  api: GitCrestApiClient,
  repoId: RepoId,
  input: OperationPreviewInputRequest,
  requestId: string,
): Promise<StartOperationResult> {
  let request: OperationRequestResponse;
  try {
    request = await api.previewRepositoryOperation(repoId, input);
  } catch (reason) {
    if (reason instanceof GitCrestApiError && (reason.status === 404 || reason.status === 405)) return { kind: "disabled" };
    if (reason instanceof GitCrestApiError && reason.status === 403 && reason.body.error.code === "OPERATION_CREATION_DISABLED") {
      return { kind: "disabled" };
    }
    throw reason;
  }
  return { kind: "started", created: await api.createRepositoryOperation(repoId, { requestId, request }) };
}
