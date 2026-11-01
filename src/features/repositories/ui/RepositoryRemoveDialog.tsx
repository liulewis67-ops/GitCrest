import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import type { RepositoryResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";
import { getRepositoryDisplayName } from "../../../shared/lib/repository-display-name";

export function RepositoryRemoveDialog({ repository, busy = false, onClose, onConfirm }: {
  repository: RepositoryResponse;
  busy?: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();

  return <Dialog className="dialogCard repositoryRemoveDialog" role="alertdialog" aria-labelledby="repository-remove-title" aria-describedby="repository-remove-description" onClose={onClose} busy={false}>
      <DialogHeader className="dialogHeading"><div><h2 id="repository-remove-title">{t("welcome.removeConfirmTitle", { name: getRepositoryDisplayName(repository.path) })}</h2></div></DialogHeader>
      <p id="repository-remove-description">{t("welcome.removeConfirmBody")}</p>
      <code>{repository.path}</code>
      <DialogFooter className="dialogActions"><Button variant="secondary" type="button" data-dialog-initial-focus onClick={onClose}>{t("welcome.removeConfirmKeep")}</Button><Button variant="danger" type="button" disabled={busy} onClick={onConfirm}>{t("welcome.removeConfirmAction")}</Button></DialogFooter>
    </Dialog>;
}
