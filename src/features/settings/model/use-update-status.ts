import { t } from "../../../shared/i18n";
import { useCallback, useEffect, useState } from "react";
import { getGitCrestBridge } from "../../../api/bridge";
import type { UpdateStatus } from "../../../api/update-status";

export function useUpdateStatus() {
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();

  useEffect(() => {
    const bridge = getGitCrestBridge();
    const getStatus = bridge?.getUpdateStatus;
    const subscribe = bridge?.subscribeToUpdateStatus;
    if (!getStatus || !subscribe) return;

    let active = true;
    const unsubscribe = subscribe((next) => {
      if (active) setUpdateStatus(next);
    });
    void getStatus().then((next) => {
      if (active) setUpdateStatus(next);
    }).catch(() => {
      if (active) setUpdateStatus({ state: "error", message: t("upd.loadFailed") });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const checkForUpdates = useCallback(async () => {
    const check = getGitCrestBridge()?.checkForUpdates;
    if (!check) return;
    try { setUpdateStatus(await check()); }
    catch { setUpdateStatus({ state: "error", message: t("upd.checkFailed") }); }
  }, []);

  const installUpdate = useCallback(() => {
    const install = getGitCrestBridge()?.installUpdate;
    if (install) void install().catch(() => setUpdateStatus({ state: "error", message: t("upd.installFailed") }));
  }, []);

  return { updateStatus, checkForUpdates, installUpdate };
}
