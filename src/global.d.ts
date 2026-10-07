import type { components } from "./api/schema";

type GitCrestEventEnvelope = components["schemas"]["EventEnvelope"];

interface GitCrestSidecarConnection {
  baseUrl: string;
  token: string;
  windowAccess: "readWrite" | "readOnly";
}

declare global {
  interface Window {
    gitcrest: {
      getSidecarConnection: () => Promise<GitCrestSidecarConnection>;
      chooseRepository: () => Promise<string | undefined>;
      chooseCloneParent: () => Promise<string | undefined>;
      subscribeToEvents: (listener: (event: GitCrestEventEnvelope) => void) => Promise<() => void>;
    };
  };
}

export {};
