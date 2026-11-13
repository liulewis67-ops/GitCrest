import { Button } from "../../../shared/ui/Button";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { t as translate, useI18n } from "../../../shared/i18n";
import type { DisplayError } from "../../../shared/i18n/api-errors";
import type { OperationActionKind, OperationRecoveryResponse } from "../../../api/client";
import { availableRecoveryActions, type RecoveryActionGroup } from "../model/operation-recovery";

function describeOperationState(state: OperationRecoveryResponse["state"], hasChoices: boolean): string {
  // Between steps a durable operation reads as running while it only waits for the next explicit action.
  const status = state.status === "running" && hasChoices ? translate("op.status.awaitingChoice") : translate(`op.status.${state.status}`);
  return state.waitReason ? `${status} (${translate(`op.wait.${state.waitReason}`)})` : status;
}

/** Kinds with their own wording; every other kind falls back to its group label. */
const KIND_LABELS = {
  reconcileRestoreConflict: "op.kind.reconcileRestoreConflict",
  reviewFetchedPull: "op.kind.reviewFetchedPull",
  fastForwardPull: "op.kind.fastForwardPull",
  rebasePull: "op.kind.rebasePull",
  mergePull: "op.kind.mergePull",
  preservePull: "op.kind.preservePull",
  continuePullRebase: "op.kind.continuePullRebase",
  continuePullMerge: "op.kind.continuePullMerge",
  abortPullRebase: "op.kind.abortPullRebase",
  abortPullMerge: "op.kind.abortPullMerge",
  cancelPreparation: "op.kind.cancelPreparation",
} as const;

function actionLabel(kind: OperationActionKind, group: RecoveryActionGroup): string {
  const own = (KIND_LABELS as Partial<Record<OperationActionKind, (typeof KIND_LABELS)[keyof typeof KIND_LABELS]>>)[kind];
  return own ? translate(own) : translate(`op.group.${group}`);
}

function isConflictWait(operation: OperationRecoveryResponse): boolean {
  return operation.state.status === "waitingForInput" && (operation.state.waitReason === "historyConflict" || operation.state.waitReason === "restoreConflict");
}

interface OperationRecoveryListProps {
  operations: OperationRecoveryResponse[];
  error: DisplayError;
  submitting: string;
  onSubmit: (operation: OperationRecoveryResponse, kind: OperationActionKind) => void;
}

/** Presentational list; every action offered comes from the server's allowedActions for this token. */
export function OperationRecoveryList({ operations, error, submitting, onSubmit }: OperationRecoveryListProps) {
  const { t } = useI18n();
  if (operations.length === 0 && !error) return null;
  return (
    <section aria-label={t("op.title")} className="operationRecovery">
      <h3>{t("op.title")}</h3>
      <ErrorMessage error={error} />
      {operations.map((operation) => {
        const choices = availableRecoveryActions(operation);
        return (
          <div key={operation.operationId} className="operationRecoveryItem" data-operation-id={operation.operationId}>
            <p>{t("op.state", { state: describeOperationState(operation.state, choices.length > 0) })}</p>
            {isConflictWait(operation) ? <p>{t("op.hint.conflict")}</p> : choices.length === 0 ? <p>{t("op.noActions")}</p> : null}
            {choices.map((choice) => (
              <Button
                key={choice.kind}
                variant={choice.group === "abort" ? "danger" : "secondary"}
                size="compact"
                disabled={submitting === operation.operationId}
                data-action-kind={choice.kind}
                onClick={() => onSubmit(operation, choice.kind)}
              >
                {actionLabel(choice.kind, choice.group)}
              </Button>
            ))}
          </div>
        );
      })}
    </section>
  );
}
