import type { GitCrestBridge } from "./api/bridge";

declare global {
  interface Window {
    gitcrest?: GitCrestBridge;
  }
}

export {};
