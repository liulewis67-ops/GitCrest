import { useEffect, useMemo, useState } from "react";
import type { BranchSnapshotResponse, RemoteSnapshotResponse } from "../../../api/client";
import { useDialogFocus } from "../../../shared/hooks/use-dialog-focus";
import type { PushTarget } from "../model/push-target";

interface PushTargetDialogProps {
  remotes?: RemoteSnapshotResponse;
  branches?: BranchSnapshotResponse;
  disabled: boolean;
  disabledReason: string;
  onChoose: (target: PushTarget) => void;
  onClose: () => void;
}

export function PushTargetDialog({ remotes, branches, disabled, disabledReason, onChoose, onClose }: PushTargetDialogProps) {
  const { dialogRef, onKeyDown } = useDialogFocus<HTMLElement>(onClose);
  const remoteList = remotes?.remotes || [];
  const branchList = branches?.branches || [];
  const [remoteName, setRemoteName] = useState("");
  const [remoteBranch, setRemoteBranch] = useState("");
  const availableBranches = useMemo(() => branchList
    .filter((branch) => branch.kind === "remote" && branch.fullName.startsWith(`refs/remotes/${remoteName}/`))
    .map((branch) => branch.fullName.slice(`refs/remotes/${remoteName}/`.length))
    .sort((left, right) => left.localeCompare(right)), [branchList, remoteName]);

  useEffect(() => {
    if (!remoteName && remoteList.length > 0) setRemoteName(remotes?.defaultRemote || remoteList[0].name);
  }, [remoteName, remoteList, remotes?.defaultRemote]);
  useEffect(() => {
    if (!availableBranches.includes(remoteBranch)) setRemoteBranch(availableBranches[0] || "");
  }, [availableBranches, remoteBranch]);

  return (
    <div className="paletteBackdrop pushBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={dialogRef} className="cloneDialog pushTargetDialog" role="dialog" aria-modal="true" aria-labelledby="push-target-title" onKeyDown={onKeyDown}>
        <header className="taskCenterHeader">
          <div><p className="sectionEyebrow">ONE-OFF DESTINATION</p><h2 id="push-target-title">Choose push target</h2></div>
          <button className="quietButton compact" type="button" onClick={onClose} aria-label="Close push target selection">Close</button>
        </header>
        <div className="cloneFormBody">
          <label className="cloneField">Remote
            <select value={remoteName} disabled={disabled || remoteList.length === 0} onChange={(event) => { setRemoteName(event.target.value); setRemoteBranch(""); }}>
              {remoteList.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}
            </select>
          </label>
          <label className="cloneField">Remote branch
            <select value={remoteBranch} disabled={disabled || availableBranches.length === 0} onChange={(event) => setRemoteBranch(event.target.value)}>
              {availableBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </select>
          </label>
          {availableBranches.length === 0 && <p className="cloneHelp">Fetch this remote first so its existing branches can be reviewed.</p>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
        </div>
        <footer className="cloneDialogActions">
          <button className="quietButton" type="button" onClick={onClose}>Cancel</button>
          <button className="primaryButton" type="button" disabled={disabled || !remoteName || !remoteBranch} onClick={() => onChoose({ remoteName, remoteBranch })}>Review target</button>
        </footer>
      </section>
    </div>
  );
}
