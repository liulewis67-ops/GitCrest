import { SearchableSelect } from "../../../shared/ui/SearchableSelect";
import { Button } from "../../../shared/ui/Button";
import { Dialog, DialogHeader, DialogFooter } from "../../../shared/ui/Dialog";
import { useI18n } from "../../../shared/i18n";
import { useEffect, useMemo, useState } from "react";
import type { BranchSnapshotResponse, RemoteSnapshotResponse } from "../../../api/client";
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
  const { t } = useI18n();

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
    <Dialog className="cloneDialog pushTargetDialog" role="dialog" aria-labelledby="push-target-title" onClose={onClose} busy={false} closeLabel={t("pt.closeAria")} backdropClassName="pushBackdrop">
        <DialogHeader className="taskCenterHeader">
          <div><h2 id="push-target-title">{t("pt.title")}</h2></div>

        </DialogHeader>
        <div className="cloneFormBody">
          <label className="cloneField">{t("pt.remote")}
            <SearchableSelect value={remoteName} disabled={disabled || remoteList.length === 0} onChange={(event) => { setRemoteName(event.target.value); setRemoteBranch(""); }}>
              {remoteList.map((remote) => <option key={remote.name} value={remote.name}>{remote.name}</option>)}
            </SearchableSelect>
          </label>
          <label className="cloneField">{t("pt.remoteBranch")}
            <SearchableSelect value={remoteBranch} disabled={disabled || availableBranches.length === 0} onChange={(event) => setRemoteBranch(event.target.value)}>
              {availableBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
            </SearchableSelect>
          </label>
          {availableBranches.length === 0 && <p className="cloneHelp">{t("pt.fetchFirst")}</p>}
          {disabled && disabledReason && <p className="cloneHelp" role="note">{disabledReason}</p>}
        </div>
        <DialogFooter className="cloneDialogActions">
          <Button variant="secondary" type="button" onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="button" disabled={disabled || !remoteName || !remoteBranch} onClick={() => onChoose({ remoteName, remoteBranch })}>{t("pt.review")}</Button>
        </DialogFooter>
      </Dialog>
  );
}
