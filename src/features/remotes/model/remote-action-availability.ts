import type { RepositoryResponse } from "../../../api/client";
import { t } from "../../../shared/i18n";

interface RemoteActionAvailabilityOptions {
  repository?: RepositoryResponse;
  connected: boolean;
  hasActiveRepositoryTask: boolean;
}

export function getRemoteActionDisabledReasons({
  repository,
  connected,
  hasActiveRepositoryTask,
}: RemoteActionAvailabilityOptions) {
  const getReason = (messages: { missingRepository: string; disconnected: string; busy: string }) => {
    if (!repository) return messages.missingRepository;
    if (!connected) return messages.disconnected;
    if (repository.availability !== "available") return t("remote.unavailable");
    if (hasActiveRepositoryTask) return messages.busy;
    return "";
  };

  return {
    remoteDisabledReason: getReason({
      missingRepository: t("remote.manageNoRepo"),
      disconnected: t("remote.manageDisconnected"),
      busy: t("remote.manageBusy"),
    }),
    pushDisabledReason: getReason({
      missingRepository: t("remote.pushNoRepo"),
      disconnected: t("remote.pushDisconnected"),
      busy: t("remote.pushBusy"),
    }),
    pullDisabledReason: getReason({
      missingRepository: t("remote.pullNoRepo"),
      disconnected: t("remote.pullDisconnected"),
      busy: t("remote.pullBusy"),
    }),
  };
}
