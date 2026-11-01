import type { RepositoryResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { getRepositoryDisplayName } from "../../../shared/lib/repository-display-name";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

export function RepositoryRemoveDialog({ repository, busy = false, onClose, onConfirm }: {
  repository: RepositoryResponse;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose);
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="dialogCard repositoryRemoveDialog" role="alertdialog" aria-modal="true" aria-labelledby="repository-remove-title" aria-describedby="repository-remove-description" onKeyDown={onKeyDown}>
      <div className="dialogHeading"><div><h2 id="repository-remove-title">{t("welcome.removeConfirmTitle", { name: getRepositoryDisplayName(repository.path) })}</h2></div></div>
      <p id="repository-remove-description">{t("welcome.removeConfirmBody")}</p>
      <code>{repository.path}</code>
      <div className="dialogActions"><button className="secondaryButton" type="button" data-dialog-initial-focus onClick={onClose}>{t("welcome.removeConfirmKeep")}</button><button className="dangerButton" type="button" disabled={busy} onClick={onConfirm}>{t("welcome.removeConfirmAction")}</button></div>
    </section>
  </div>;
}
