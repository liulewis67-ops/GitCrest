import type { CoreStatus } from "./core-status";
import type { UpdateStatus } from "./update-status";
import type { components } from "./schema";

export interface GitCrestSidecarConnection {
  baseUrl: string;
  token: string;
  windowAccess: "readWrite" | "readOnly" | "conflictResolution";
}

export type GitCrestEventEnvelope = components["schemas"]["EventEnvelope"];

export interface GitCrestBridge {
  getSidecarConnection: () => Promise<GitCrestSidecarConnection>;
  chooseRepository: () => Promise<string | undefined>;
  chooseCloneParent: () => Promise<string | undefined>;
  openDiffWindow: (request: {
    repoId: string;
    path: string;
    scope: "workingTree" | "index" | "commit";
    commitOid?: string;
  }) => Promise<void>;
  openConflictWindow: (request: { repoId: string; taskId: string }) => Promise<void>;
  getCoreStatus?: () => Promise<CoreStatus>;
  restartCore?: () => Promise<CoreStatus>;
  subscribeToCoreStatus?: (listener: (status: CoreStatus) => void) => () => void;
  getUpdateStatus?: () => Promise<UpdateStatus>;
  checkForUpdates?: () => Promise<UpdateStatus>;
  installUpdate?: () => Promise<boolean>;
  subscribeToUpdateStatus?: (listener: (status: UpdateStatus) => void) => () => void;
  subscribeToEvents: (listener: (event: GitCrestEventEnvelope) => void) => Promise<() => void>;
}

export function getGitCrestBridge(): GitCrestBridge | undefined {
  return typeof window === "undefined" ? undefined : window.gitcrest;
}

export function requireGitCrestBridge(): GitCrestBridge {
  const bridge = getGitCrestBridge();
  if (!bridge) {
    throw new Error("GitCrest desktop bridge is unavailable. Open this feature in the GitCrest desktop app.");
  }
  return bridge;
}
