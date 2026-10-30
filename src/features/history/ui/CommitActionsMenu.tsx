import { useI18n } from "../../../shared/i18n";
import { MenuButton } from "../../../shared/ui/MenuButton";

export type CommitWorkflowAction = "merge" | "cherryPick" | "revert";

/** Secondary operations on one commit, kept behind a single button instead of a row of always-visible actions. */
export function CommitActionsMenu({ oid, workflowDisabledReason, onWorkflow, onCreateBranch, onCreateTag, onCopySha, onCheckout, onReset, resetDisabledReason, className = "quietButton compact iconButton" }: {
  oid: string;
  /** Set when Git operations cannot start; every operation item shows it. */
  workflowDisabledReason?: string;
  onWorkflow: (action: CommitWorkflowAction, oid: string) => void;
  onCreateBranch: (oid: string) => void;
  onCreateTag: (oid: string) => void;
  onCopySha: (oid: string) => void;
  /** Opens the branch switcher on this commit to check it out with a detached HEAD. */
  onCheckout?: (oid: string) => void;
  /** Opens the reset dialog with this commit as the target. */
  onReset?: (oid: string) => void;
  /** Why resetting to this commit is unavailable, such as it already being HEAD. */
  resetDisabledReason?: string;
  className?: string;
}) {
  const { t } = useI18n();
  const blocked = Boolean(workflowDisabledReason);
  return <MenuButton
    className={className}
    label={t("hv.actionsFor", { oid: oid.slice(0, 7) })}
    title={t("hv.actions")}
    menuLabel={t("hv.actionsFor", { oid: oid.slice(0, 7) })}
    items={[
      { id: "copy", label: t("hv.copySha"), onSelect: () => onCopySha(oid) },
      ...(onCheckout ? [{ id: "checkout", label: t("hv.checkout"), disabled: blocked, title: workflowDisabledReason, onSelect: () => onCheckout(oid) }] : []),
      { id: "branch", label: t("hv.branchHere"), disabled: blocked, title: workflowDisabledReason, onSelect: () => onCreateBranch(oid) },
      { id: "tag", label: t("hv.createTag"), disabled: blocked, title: workflowDisabledReason, onSelect: () => onCreateTag(oid) },
      { id: "merge", label: t("hv.merge"), disabled: blocked, title: workflowDisabledReason, separatorBefore: true, onSelect: () => onWorkflow("merge", oid) },
      { id: "cherryPick", label: t("hv.cherryPick"), disabled: blocked, title: workflowDisabledReason, onSelect: () => onWorkflow("cherryPick", oid) },
      { id: "revert", label: t("hv.revert"), disabled: blocked, title: workflowDisabledReason, onSelect: () => onWorkflow("revert", oid) },
      ...(onReset ? [{ id: "reset", label: t("hv.reset"), disabled: blocked || Boolean(resetDisabledReason), title: workflowDisabledReason ?? resetDisabledReason, onSelect: () => onReset(oid) }] : []),
    ]}
  ><span aria-hidden="true">⋯</span></MenuButton>;
}
