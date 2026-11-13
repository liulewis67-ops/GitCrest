import type { OperationActionKind, OperationActionSubmissionRequest, OperationRecoveryResponse } from "../../../api/client";

export type RecoveryActionGroup = "continue" | "abort" | "reconcile" | "resume" | "other";

const CONTINUE: ReadonlySet<OperationActionKind> = new Set(["continuePullRebase", "continuePullMerge"]);
const ABORT: ReadonlySet<OperationActionKind> = new Set([
  "abortPullRebase", "abortPullMerge", "cancelPreparation", "cancelPreservedCheckout", "cancelPreservedPull", "abandonPlannedCheckout",
]);

export function recoveryActionGroup(kind: OperationActionKind): RecoveryActionGroup {
  if (CONTINUE.has(kind)) return "continue";
  if (ABORT.has(kind)) return "abort";
  if (kind.startsWith("reconcile")) return "reconcile";
  if (kind.startsWith("resume") || kind.startsWith("restore") || kind === "startPreservedCheckout" || kind === "completePreparedCheckout") return "resume";
  return "other";
}

export interface RecoveryActionChoice {
  readonly kind: OperationActionKind;
  readonly group: RecoveryActionGroup;
}

/** Actions the caller may submit now; empty whenever the server reports actions disabled. */
export function availableRecoveryActions(operation: OperationRecoveryResponse): RecoveryActionChoice[] {
  if (!operation.actionsEnabled) return [];
  return operation.allowedActions.map((kind) => ({ kind, group: recoveryActionGroup(kind) }));
}

/**
 * Builds the submission for one action. The version is carried verbatim as a string so 64-bit counters
 * never pass through a JS number; a stable requestId lets a retry after a lost response replay.
 */
export function buildActionSubmission(
  operation: OperationRecoveryResponse,
  kind: OperationActionKind,
  requestId: string,
): OperationActionSubmissionRequest {
  if (!availableRecoveryActions(operation).some((choice) => choice.kind === kind)) {
    throw new Error(`Action ${kind} is not currently allowed for operation ${operation.operationId}`);
  }
  return { requestId, kind, expectedVersion: operation.version };
}
