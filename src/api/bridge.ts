import type { CoreStatus } from "./core-status";
import type { UpdateStatus } from "./update-status";
import type { components } from "./schema";
import type { WindowControlsBridge } from "../shared/ui/WindowControls";

export interface GitCrestSidecarConnection {
  baseUrl: string;
  token: string;
  windowAccess: "readWrite" | "readOnly" | "conflictResolution";
}

export type GitCrestEventEnvelope = components["schemas"]["EventEnvelope"];

/** A language plugin folder as the main process read it: a checked manifest, or why it was rejected. */
export interface GitCrestLanguagePluginEntry {
  folder: string;
  manifest?: {
    schemaVersion: 1;
    id: string;
    name: string;
    version: string;
    extensions: string[];
    fileNames: string[];
    grammar: string;
    monacoLanguage?: string;
    structure: unknown;
    syntax?: unknown;
  };
  error?: string;
}

export interface GitCrestLanguagePluginListing {
  directory: string;
  plugins: GitCrestLanguagePluginEntry[];
}

export interface GitCrestBridge {
  /** Present in frameless windows (Windows and Linux), whose headers draw their own controls. */
  windowControls?: WindowControlsBridge;
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
  /** Opens the system file manager with the file selected. */
  showItemInFolder?: (path: string) => Promise<void>;
  listLanguagePlugins?: () => Promise<GitCrestLanguagePluginListing>;
  readLanguagePluginGrammar?: (id: string) => Promise<Uint8Array>;
  /** Main window only: creates the plugin folder if needed and opens it in the file manager. */
  openLanguagePluginFolder?: () => Promise<void>;
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
