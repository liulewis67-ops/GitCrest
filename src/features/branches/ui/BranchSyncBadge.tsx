import type { BranchSnapshotResponse } from "../../../api/client";

type Branch = BranchSnapshotResponse["branches"][number];

/** Compact upstream status: commits ahead (↑), behind (↓), or a deleted upstream. */
export function BranchSyncBadge({ branch }: { branch: Pick<Branch, "kind" | "upstream" | "upstreamGone" | "ahead" | "behind"> }) {
  if (branch.kind !== "local" || !branch.upstream) return null;
  if (branch.upstreamGone) return <span className="branchSync gone" title={`Upstream ${branch.upstream} no longer exists`}>upstream gone</span>;
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead === 0 && behind === 0) return null;
  const parts = [ahead > 0 ? `${ahead} ahead` : "", behind > 0 ? `${behind} behind` : ""].filter(Boolean).join(", ");
  return <span className="branchSync" title={`${parts} of ${branch.upstream}`} aria-label={`${parts} of ${branch.upstream}`}>
    {ahead > 0 && <span>↑{ahead}</span>}{behind > 0 && <span>↓{behind}</span>}
  </span>;
}
