import type { RepositoryResponse } from "../../../api/client";

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
    if (repository.availability !== "available") return "This repository is unavailable.";
    if (hasActiveRepositoryTask) return messages.busy;
    return "";
  };

  return {
    remoteDisabledReason: getReason({
      missingRepository: "Open a repository to manage remotes.",
      disconnected: "Connect to the local Git engine to manage remotes.",
      busy: "Wait for the current repository task to finish before changing remotes.",
    }),
    pushDisabledReason: getReason({
      missingRepository: "Open a repository to push its current branch.",
      disconnected: "Connect to the local Git engine to push.",
      busy: "Wait for the current repository task to finish before pushing.",
    }),
    pullDisabledReason: getReason({
      missingRepository: "Open a repository to pull its current branch.",
      disconnected: "Connect to the local Git engine to pull.",
      busy: "Wait for the current repository task to finish before pulling.",
    }),
  };
}
