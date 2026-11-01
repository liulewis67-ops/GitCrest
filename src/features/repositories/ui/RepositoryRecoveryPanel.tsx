import { useEffect, useId, useRef } from "react";
import type { RepositoryResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import type { DisplayError } from "../../../shared/i18n/api-errors";
import { getRepositoryDisplayName } from "../../../shared/lib/repository-display-name";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";

export function RepositoryRecoveryPanel({ repository, error, busy = false, onLocate, onRemove, onRetry }: {
  repository: RepositoryResponse;
  error?: DisplayError;
  busy?: boolean;
  onLocate: () => void;
  onRemove: () => void;
  onRetry?: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (document.querySelector('[aria-modal="true"]')) return;
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView?.({ block: "nearest", behavior: "instant" });
  }, [repository.repoId]);
  return <section ref={panel} className="repositoryRecovery" role="alert" tabIndex={-1} aria-labelledby={titleId}>
    <h2 id={titleId}>{t("rr.title", { name: getRepositoryDisplayName(repository.path) })}</h2>
    <p><ErrorMessage error={error || t("apiError.REPOSITORY_PATH_NOT_FOUND")} /></p>
    <code>{repository.path}</code>
    <div className="repositoryRecoveryActions">
      <button className="primaryButton" type="button" disabled={busy} onClick={onLocate}>{t("rr.locate")}</button>
      <button className="secondaryButton" type="button" disabled={busy} onClick={onRemove}>{t("rr.remove")}</button>
      {onRetry && <button className="quietButton" type="button" disabled={busy} onClick={onRetry}>{t("rr.retry")}</button>}
    </div>
  </section>;
}
