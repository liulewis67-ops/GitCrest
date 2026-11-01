import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { ErrorMessage } from "../../../shared/ui/ErrorMessage";
import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useI18n } from "../../../shared/i18n";
import { useState } from "react";

export function DiscardChangesDialog({ repositoryPath, path, selectionCount, disabled, error, onCancel, onConfirm }: {
  repositoryPath: string;
  path: string;
  selectionCount: number;
  disabled: boolean;
  error?: DisplayError;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState(false);

  return <Dialog className="taskCenter remoteBranchDeleteDialog" role="dialog" aria-labelledby="discard-changes-title" onClose={onCancel} busy={disabled} closeLabel={t("dc.close")}>
      <DialogHeader className="taskCenterHeader">
        <div><h2 id="discard-changes-title">{t("dc.title")}</h2></div>

      </DialogHeader>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{t("dc.repository")}</span><strong className="monoText">{repositoryPath}</strong></div>
        <div className="repositoryFact"><span>{t("dc.file")}</span><strong className="monoText">{path}</strong></div>
        <div className="repositoryFact"><span>{t("dc.selected")}</span><strong>{t(selectionCount === 1 ? "dc.selectionOne" : "dc.selectionMany", { count: selectionCount })}</strong></div>
        <p className="cloneHelp">{t("dc.help")}</p>
        {error && <p className="taskCenterError" role="alert"><ErrorMessage error={error} /></p>}
        <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("dc.confirm")}</label>
        <DialogFooter className="taskCenterActions">
          <Button variant="secondary" type="button" disabled={disabled} onClick={onCancel}>{t("dc.cancel")}</Button>
          <Button variant="danger" type="button" disabled={disabled || !confirmed} onClick={onConfirm}>{disabled ? t("dc.discarding") : t("dc.discard")}</Button>
        </DialogFooter>
      </div>
    </Dialog>;
}
