import type { BranchSnapshotResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

type Branch = BranchSnapshotResponse["branches"][number];

/**
 * Compact upstream status: commits ahead (↑, green), behind (↓, amber), a deleted upstream, or with
 * `showUnpublished` a local branch that has no upstream yet (a dashed ↑). With `onPush` or `onPull`
 * the arrows are buttons; `disabledReason` turns them off and says why. The direction and the count
 * are always printed, so color is never the only signal.
 */
export function BranchSyncBadge({ branch, showUnpublished = false, onPush, onPull, pushDisabledReason, pullDisabledReason, staticHint }: {
  branch: Pick<Branch, "kind" | "upstream" | "upstreamGone" | "ahead" | "behind">;
  showUnpublished?: boolean;
  onPush?: () => void;
  onPull?: () => void;
  /** Why Push or Pull cannot start now; shown as the arrow's tooltip while it is off. */
  pushDisabledReason?: string;
  pullDisabledReason?: string;
  /** Added to the tooltip of arrows that are not buttons, such as how to push this branch. */
  staticHint?: string;
}) {
  const { t } = useI18n();
  if (branch.kind !== "local") return null;
  if (!branch.upstream) {
    if (!showUnpublished) return null;
    const label = t("br.unpublished");
    return onPush
      ? <span className="branchSync"><button type="button" className="branchSyncButton unpublished" aria-label={label} title={pushDisabledReason ?? t("br.unpublishedPush")} disabled={Boolean(pushDisabledReason)} onClick={onPush}>↑</button></span>
      : <span className="branchSync"><span className="branchSyncArrow unpublished" aria-label={label} title={staticHint ? `${t("br.unpublished")} ${staticHint}` : t("br.unpublished")}>↑</span></span>;
  }
  if (branch.upstreamGone) return <span className="branchSync gone" title={t("br.upstreamGoneTitle", { upstream: branch.upstream })}>{t("br.upstreamGone")}</span>;
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead === 0 && behind === 0) return null;
  const parts = [ahead > 0 ? t("br.ahead", { count: ahead }) : "", behind > 0 ? t("br.behind", { count: behind }) : ""].filter(Boolean).join(", ");
  const summary = t("br.syncOf", { parts, upstream: branch.upstream });
  if (!onPush && !onPull) {
    return <span className="branchSync" title={staticHint ? `${summary}. ${staticHint}` : summary} aria-label={summary}>
      {ahead > 0 && <span className="branchSyncArrow ahead">↑{ahead}</span>}{behind > 0 && <span className="branchSyncArrow behind">↓{behind}</span>}
    </span>;
  }
  return <span className="branchSync">
    {ahead > 0 && <button type="button" className="branchSyncButton ahead" aria-label={t("br.pushAhead", { count: ahead, upstream: branch.upstream })} title={pushDisabledReason ?? t("br.pushAheadTitle", { count: ahead, upstream: branch.upstream })} disabled={Boolean(pushDisabledReason) || !onPush} onClick={onPush}>↑{ahead}</button>}
    {behind > 0 && <button type="button" className="branchSyncButton behind" aria-label={t("br.pullBehind", { count: behind, upstream: branch.upstream })} title={pullDisabledReason ?? t("br.pullBehindTitle", { count: behind, upstream: branch.upstream })} disabled={Boolean(pullDisabledReason) || !onPull} onClick={onPull}>↓{behind}</button>}
  </span>;
}
