import { useI18n } from "../../../shared/i18n";
import { useState } from "react";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";

export function DiscardChangesDialog({ repositoryPath, path, selectionCount, disabled, error, onCancel, onConfirm }: {
  repositoryPath: string;
  path: string;
  selectionCount: number;
  disabled: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState(false);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onCancel, disabled);
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !disabled) onCancel(); }}>
    <section ref={dialogRef} className="taskCenter remoteBranchDeleteDialog" role="dialog" aria-modal="true" aria-labelledby="discard-changes-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">{t("dc.eyebrow")}</p><h2 id="discard-changes-title">{t("dc.title")}</h2></div>
        <button className="quietButton compact" type="button" disabled={disabled} onClick={onCancel}>{t("dc.close")}</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>{t("dc.repository")}</span><strong className="monoText">{repositoryPath}</strong></div>
        <div className="repositoryFact"><span>{t("dc.file")}</span><strong className="monoText">{path}</strong></div>
        <div className="repositoryFact"><span>{t("dc.selected")}</span><strong>{t(selectionCount === 1 ? "dc.selectionOne" : "dc.selectionMany", { count: selectionCount })}</strong></div>
        <p className="cloneHelp">{t("dc.help")}</p>
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />{t("dc.confirm")}</label>
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={disabled} onClick={onCancel}>{t("dc.cancel")}</button>
          <button className="dangerTextButton" type="button" disabled={disabled || !confirmed} onClick={onConfirm}>{disabled ? t("dc.discarding") : t("dc.discard")}</button>
        </div>
      </div>
    </section>
  </div>;
}
