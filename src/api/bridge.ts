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

export interface GitCrestDiffWindowRequest {
  repoId: string;
  path: string;
  scope: "workingTree" | "index" | "commit";
  commitOid?: string;
}

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

export type GitCrestEditorChoice =
  | { kind: "auto" }
  | { kind: "known"; id: string }
  | { kind: "custom"; program: string };

export interface GitCrestExternalTools {
  editor: GitCrestEditorChoice;
  detected: Array<{ id: string; name: string }>;
}

/** A repository by id and, optionally, a path inside it; the main process resolves the folder itself. */
export interface GitCrestOpenRequest {
  repoId: string;
  relativePath?: string;
}

export type GitCrestOpenResult =
  | { ok: true }
  | { ok: false; code: "noEditor" | "badEditor" | "badPath" | "startFailed" | "noTerminal"; message: string };

export interface GitCrestBridge {
  /** Present in frameless windows (Windows and Linux), whose headers draw their own controls. */
  windowControls?: WindowControlsBridge;
  getSidecarConnection: () => Promise<GitCrestSidecarConnection>;
  chooseRepository: () => Promise<string | undefined>;
  chooseCloneParent: () => Promise<string | undefined>;
  /** Opens the repository's Diff window, or adds the file as a tab when one is already open. */
  openDiffWindow: (request: GitCrestDiffWindowRequest) => Promise<void>;
  /** Diff windows only: further Diffs opened for this window's repository. */
  subscribeToDiffWindowRequests?: (listener: (requests: GitCrestDiffWindowRequest[]) => void) => () => void;
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
  /** Main window only: the saved editor choice and the editors found on this computer. */
  getExternalTools?: () => Promise<GitCrestExternalTools>;
  setExternalEditor?: (choice: GitCrestEditorChoice) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Opens the repository, or a file or folder inside it, in the chosen editor. */
  openInEditor?: (request: GitCrestOpenRequest) => Promise<GitCrestOpenResult>;
  openInTerminal?: (request: GitCrestOpenRequest) => Promise<GitCrestOpenResult>;
  /** Opens an http or https address in the default browser. */
  openExternalUrl?: (url: string) => Promise<boolean>;
  /** The disk path of a dropped file or folder. */
  getPathForFile?: (file: File) => string;
  /** Zooms this window's interface; 1 is 100%. */
  setZoomFactor?: (factor: number) => void;
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
