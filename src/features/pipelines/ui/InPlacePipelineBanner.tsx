import { useI18n } from "../../../shared/i18n";
import { inPlacePipelineState, usePipelineState } from "../model/pipeline-store";

/** Shown while a switch-in-place pipeline uses the repository's own working tree. */
export function InPlacePipelineBanner({ repoId }: { repoId?: string }) {
  const { t } = useI18n();
  const phase = inPlacePipelineState(usePipelineState(), repoId);
  if (!phase) return null;
  return <div className="pipelineBanner" role="status">
    {phase === "running" ? t("pl.banner.running") : phase === "waitingForConflicts" ? t("pl.banner.conflicts") : t("pl.banner.interrupted")}
  </div>;
}
