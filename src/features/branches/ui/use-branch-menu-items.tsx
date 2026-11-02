import type { BranchSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import type { ContextMenuItem } from "../../../shared/ui/ContextMenu";
import { pipelineRunBlocker } from "../../pipelines";
type Branch = BranchSnapshotResponse["branches"][number];

export interface BranchMenuActions {
  onOpenWorktree: (path: string) => void;
  onSwitchBranch: (name: string) => void;
  onCheckoutRemoteBranch: (name: string) => void;
  onCreateBranchFrom: (oid: string) => void;
  onNewWorktreeFrom: (oid: string, label: string) => void;
  onNewWorktreeForBranch: (name: string, fromRemote: boolean) => void;
  onMergeBranch: (oid: string, name: string) => void;
  onRebaseOnto: (oid: string) => void;
  onManageBranch: (name: string, mode: "rename" | "delete") => void;
  onRemoveWorktree: (path: string) => void;
  onDeleteRemoteBranch: (branchRef: string) => void;
  onRunPipeline?: (branch: { name: string; oid: string }) => void;
  onCompareRef?: (name: string) => void;
  onCopyBranchName: (name: string) => void;
}

interface BranchMenuOptions extends BranchMenuActions { connected: boolean; blocked: boolean; hasActiveRepositoryTask: boolean; }

function MenuIcon({ name }: { name: "checkout" | "branch" | "merge" | "rebase" | "worktree" | "rename" | "delete" | "copy" }) {
  const paths = {
    checkout: <><path d="M2.5 8h9" /><path d="m8.5 4.5 3.5 3.5-3.5 3.5" /><path d="M13.5 3v10" /></>,
    branch: <><circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><path d="M5 5.5v5" /><path d="M11 4.5v5M8.5 7h5" /></>,
    merge: <><circle cx="5" cy="3.5" r="1.5" /><circle cx="5" cy="12.5" r="1.5" /><circle cx="11" cy="8" r="1.5" /><path d="M5 5v6M5 5c0 2.5 2 3 4.5 3" /></>,
    rebase: <><circle cx="5" cy="12.5" r="1.5" /><circle cx="11" cy="3.5" r="1.5" /><path d="M5 11V7a3 3 0 0 1 3-3h1.5" /></>,
    worktree: <><rect x="2.5" y="3" width="11" height="10" rx="1.5" /><path d="M2.5 6h11" /></>,
    rename: <><path d="M3 13h3l7-7-3-3-7 7Z" /><path d="m8.5 4.5 3 3" /></>,
    delete: <><path d="M3 4.5h10M6.5 4.5V3h3v1.5" /><path d="M4.5 4.5 5 13h6l.5-8.5" /></>,
    copy: <><rect x="5.5" y="5.5" width="8" height="8" rx="1.5" /><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" /></>,
  };
  return <svg viewBox="0 0 16 16">{paths[name]}</svg>;
}

/** History and the branch picker share the same branch operations and availability rules. */
export function useBranchMenuItems(options?: BranchMenuOptions) {
  const { t } = useI18n();
  return (branch: Branch): ContextMenuItem[] => {
    if (!options) return [];
    const { connected, blocked, hasActiveRepositoryTask, onOpenWorktree, onSwitchBranch, onCheckoutRemoteBranch, onCreateBranchFrom, onNewWorktreeFrom, onNewWorktreeForBranch, onMergeBranch, onRebaseOnto, onManageBranch, onRemoveWorktree, onDeleteRemoteBranch, onRunPipeline, onCompareRef, onCopyBranchName } = options;
    const local = branch.kind === "local";
    const items: ContextMenuItem[] = [];
    if (local && branch.worktreePath) {
      items.push({ id: "open-worktree", label: t("bs.menuOpenWorktree"), title: branch.worktreePath, icon: <MenuIcon name="worktree" />, disabled: !connected || hasActiveRepositoryTask, onSelect: () => onOpenWorktree(branch.worktreePath!) });
    } else if (!branch.isCurrent) {
      items.push({ id: "checkout", label: local ? t("bs.menuCheckout") : t("bs.menuCheckoutRemote"), icon: <MenuIcon name="checkout" />, disabled: blocked, onSelect: () => local ? onSwitchBranch(branch.name) : onCheckoutRemoteBranch(branch.name) });
    }
    items.push({ id: "new-branch", label: t("bs.menuNewBranch"), icon: <MenuIcon name="branch" />, separatorBefore: items.length > 0, disabled: blocked, onSelect: () => onCreateBranchFrom(branch.oid) });
    // A branch can be checked out in one worktree at a time, so one that already is gets a new branch from its tip.
    if (local && (branch.isCurrent || branch.worktreePath)) {
      items.push({ id: "new-worktree-from", label: t("bs.menuNewWorktreeFrom", { name: branch.name }), icon: <MenuIcon name="worktree" />, disabled: blocked, onSelect: () => onNewWorktreeFrom(branch.oid, branch.name) });
    } else if (!branch.isCurrent) {
      items.push({ id: "new-worktree", label: t("br.openNewWorktree"), icon: <MenuIcon name="worktree" />, disabled: blocked, onSelect: () => onNewWorktreeForBranch(branch.name, !local) });
    }
    if (!branch.isCurrent) {
      items.push({ id: "merge", label: t("bs.menuMerge", { name: branch.name }), icon: <MenuIcon name="merge" />, separatorBefore: true, disabled: blocked, onSelect: () => onMergeBranch(branch.oid, branch.name) });
      items.push({ id: "rebase", label: t("bs.menuRebase", { name: branch.name }), icon: <MenuIcon name="rebase" />, disabled: blocked, onSelect: () => onRebaseOnto(branch.oid) });
    }
    if (local) {
      items.push({ id: "rename", label: t("br.rename"), icon: <MenuIcon name="rename" />, separatorBefore: true, disabled: blocked, onSelect: () => onManageBranch(branch.name, "rename") });
      if (!branch.isCurrent && branch.worktreePath) {
        const worktreePath = branch.worktreePath;
        items.push({ id: "remove-worktree", label: t("bs.menuRemoveWorktree"), title: worktreePath, icon: <MenuIcon name="delete" />, danger: true, disabled: blocked, onSelect: () => onRemoveWorktree(worktreePath) });
      }
      if (!branch.isCurrent) {
        items.push({ id: "delete", label: t("br.delete"), icon: <MenuIcon name="delete" />, danger: true, disabled: blocked || Boolean(branch.worktreePath), title: branch.worktreePath ? t("br.removeWorktreeFirst") : undefined, onSelect: () => onManageBranch(branch.name, "delete") });
      }
    } else {
      items.push({ id: "delete-remote", label: t("bs.menuDeleteRemote"), icon: <MenuIcon name="delete" />, danger: true, separatorBefore: true, disabled: blocked, onSelect: () => onDeleteRemoteBranch(branch.fullName) });
    }
    if (onRunPipeline && local) {
      const blocker = pipelineRunBlocker(branch);
      items.push({ id: "run-pipeline", label: t("pl.run.menu"), separatorBefore: true, disabled: Boolean(blocker), title: blocker === "noUpstream" ? t("pl.run.noUpstream") : blocker === "unpushed" ? t("pl.run.unpushed") : undefined, onSelect: () => onRunPipeline({ name: branch.name, oid: branch.oid }) });
    }
    if (onCompareRef) items.push({ id: "compare", label: t("bs.menuCompare"), separatorBefore: true, onSelect: () => onCompareRef(branch.name) });
    items.push({ id: "copy", label: t("bs.menuCopyName"), icon: <MenuIcon name="copy" />, separatorBefore: true, onSelect: () => onCopyBranchName(branch.name) });
    return items;
  };
}
