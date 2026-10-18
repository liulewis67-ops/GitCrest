import type { BranchSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

type Branch = BranchSnapshotResponse["branches"][number];

/** Compact upstream status: commits ahead (↑), behind (↓), or a deleted upstream. */
export function BranchSyncBadge({ branch }: { branch: Pick<Branch, "kind" | "upstream" | "upstreamGone" | "ahead" | "behind"> }) {
  const { t } = useI18n();
  if (branch.kind !== "local" || !branch.upstream) return null;
  if (branch.upstreamGone) return <span className="branchSync gone" title={t("br.upstreamGoneTitle", { upstream: branch.upstream })}>{t("br.upstreamGone")}</span>;
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead === 0 && behind === 0) return null;
  const parts = [ahead > 0 ? t("br.ahead", { count: ahead }) : "", behind > 0 ? t("br.behind", { count: behind }) : ""].filter(Boolean).join(", ");
  return <span className="branchSync" title={t("br.syncOf", { parts, upstream: branch.upstream })} aria-label={t("br.syncOf", { parts, upstream: branch.upstream })}>
    {ahead > 0 && <span>↑{ahead}</span>}{behind > 0 && <span>↓{behind}</span>}
  </span>;
}
