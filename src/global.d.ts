import type { components } from "./api/schema";

type GitCrestEventEnvelope = components["schemas"]["EventEnvelope"];

interface GitCrestSidecarConnection {
  baseUrl: string;
  token: string;
  windowAccess: "readWrite" | "readOnly" | "conflictResolution";
}

declare global {
  interface Window {
    gitcrest: {
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
      subscribeToEvents: (listener: (event: GitCrestEventEnvelope) => void) => Promise<() => void>;
    };
  };
}

export {};
