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
  const [confirmed, setConfirmed] = useState(false);
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onCancel, disabled);
  return <div className="paletteBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !disabled) onCancel(); }}>
    <section ref={dialogRef} className="taskCenter remoteBranchDeleteDialog" role="dialog" aria-modal="true" aria-labelledby="discard-changes-title" onKeyDown={onKeyDown}>
      <div className="taskCenterHeader">
        <div><p className="sectionEyebrow">DISCARD WORKING-TREE CHANGES</p><h2 id="discard-changes-title">Discard selected changes?</h2></div>
        <button className="quietButton compact" type="button" disabled={disabled} onClick={onCancel}>Close</button>
      </div>
      <div className="workflowDialogBody">
        <div className="repositoryFact"><span>REPOSITORY</span><strong className="monoText">{repositoryPath}</strong></div>
        <div className="repositoryFact"><span>FILE</span><strong className="monoText">{path}</strong></div>
        <div className="repositoryFact"><span>SELECTED CHANGES</span><strong>{selectionCount} hunk or changed-row selection{selectionCount === 1 ? "" : "s"}</strong></div>
        <p className="cloneHelp">Only the selected lines from this reviewed working-tree diff will be reverted. Staged changes are not included. For a recovery copy, cancel and save these changes to a shelf first; GitCrest cannot undo this discard. GitCrest will refuse if the file changes before the task applies.</p>
        {error && <p className="taskCenterError" role="alert">{error}</p>}
        <label className="rebaseConfirm"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the selected lines and understand this discards their working-tree changes.</label>
        <div className="taskCenterActions">
          <button className="quietButton compact" type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
          <button className="dangerTextButton" type="button" disabled={disabled || !confirmed} onClick={onConfirm}>{disabled ? "Discarding…" : "Discard selected changes"}</button>
        </div>
      </div>
    </section>
  </div>;
}
