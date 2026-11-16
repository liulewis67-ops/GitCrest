import { contextBridge, ipcRenderer, webFrame, webUtils } from "electron";
import type { components } from "../../src/api/schema";
import type { CoreStatus } from "../../src/api/core-status";
import type { UpdateStatus } from "../../src/api/update-status";
import type { LanguagePluginListing } from "../main/language-plugins";

type EventEnvelope = components["schemas"]["EventEnvelope"];

export interface SidecarConnection {
  baseUrl: string;
  token: string;
  windowAccess: "readWrite" | "readOnly" | "conflictResolution";
}

export interface DiffWindowRequest {
  repoId: string;
  path: string;
  scope: "workingTree" | "index" | "commit" | "range";
  commitOid?: string;
  fromOid?: string;
  toOid?: string;
}

export interface ConflictWindowRequest {
  repoId: string;
  taskId: string;
}

// Only frameless windows draw their own controls; macOS keeps its native traffic lights.
const windowControls = process.platform === "darwin" ? undefined : {
  minimize: (): Promise<void> => ipcRenderer.invoke("gitcrest:window-control", "minimize"),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke("gitcrest:window-control", "toggleMaximize"),
  close: (): Promise<void> => ipcRenderer.invoke("gitcrest:window-control", "close"),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke("gitcrest:is-window-maximized"),
  subscribeToMaximized: (listener: (maximized: boolean) => void): (() => void) => {
    const handleMaximized = (_event: Electron.IpcRendererEvent, maximized: boolean): void => listener(maximized);
    ipcRenderer.on("gitcrest:window-maximized", handleMaximized);
    return () => ipcRenderer.removeListener("gitcrest:window-maximized", handleMaximized);
  },
};

const api = {
  windowControls,
  /** The path of a file or folder the user dropped on the window; empty for anything that is not on disk. */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  getExternalTools: (): Promise<unknown> => ipcRenderer.invoke("gitcrest:external-tools-get"),
  setExternalEditor: (choice: unknown): Promise<unknown> => ipcRenderer.invoke("gitcrest:external-tools-set-editor", choice),
  openInEditor: (request: unknown): Promise<unknown> => ipcRenderer.invoke("gitcrest:open-in-editor", request),
  openInTerminal: (request: unknown): Promise<unknown> => ipcRenderer.invoke("gitcrest:open-in-terminal", request),
  showNotification: (request: unknown): Promise<boolean> => ipcRenderer.invoke("gitcrest:show-notification", request),
  subscribeToNotificationClicks: (listener: (target: { repoId?: string; taskId: string }) => void): (() => void) => {
    const handle = (_event: Electron.IpcRendererEvent, target: { repoId?: string; taskId: string }): void => listener(target);
    ipcRenderer.on("gitcrest:notification-click", handle);
    return () => ipcRenderer.removeListener("gitcrest:notification-click", handle);
  },
  openExternalUrl: (url: string): Promise<boolean> => ipcRenderer.invoke("gitcrest:open-external-url", url),
  setZoomFactor: (factor: number): void => {
    // Only a sane factor reaches the window, whatever the renderer asks for.
    if (Number.isFinite(factor) && factor >= 0.5 && factor <= 2) webFrame.setZoomFactor(factor);
  },
  getSidecarConnection: (): Promise<SidecarConnection> => {
    return ipcRenderer.invoke("gitcrest:get-sidecar-connection");
  },
  chooseRepository: (): Promise<string | undefined> => {
    return ipcRenderer.invoke("gitcrest:choose-repository");
  },
  chooseCloneParent: (): Promise<string | undefined> => {
    return ipcRenderer.invoke("gitcrest:choose-clone-parent");
  },
  openDiffWindow: (request: DiffWindowRequest): Promise<void> => ipcRenderer.invoke("gitcrest:open-diff-window", request),
  openConflictWindow: (request: ConflictWindowRequest): Promise<void> => ipcRenderer.invoke("gitcrest:open-conflict-window", request),
  returnToTaskCenter: (): Promise<{ ok: true } | { ok: false; reason: string }> => ipcRenderer.invoke("gitcrest:return-to-task-center"),
  subscribeToTaskCenterRequests: (listener: (target: { requestId: string; repoId: string; taskId: string }) => void): (() => void) => {
    let active = true;
    const received = new Set<string>();
    const take = () => {
      void ipcRenderer.invoke("gitcrest:take-task-center-requests").then((targets: Array<{ requestId: string; repoId: string; taskId: string }>) => {
        if (!active) return;
        for (const target of targets) if (!received.has(target.requestId)) { received.add(target.requestId); listener(target); }
      }, () => undefined);
    };
    ipcRenderer.on("gitcrest:task-center-requests-pending", take);
    take();
    return () => { active = false; ipcRenderer.removeListener("gitcrest:task-center-requests-pending", take); };
  },
  acknowledgeTaskCenter: (requestId: string): Promise<boolean> => ipcRenderer.invoke("gitcrest:acknowledge-task-center", requestId),
  /** Diff windows only: further Diffs the main window opened for this repository, including any sent before this subscribed. */
  subscribeToDiffWindowRequests: (listener: (requests: DiffWindowRequest[]) => void): (() => void) => {
    const takeRequests = (): void => {
      void ipcRenderer.invoke("gitcrest:take-diff-window-requests").then((requests: DiffWindowRequest[]) => {
        if (requests.length > 0) listener(requests);
      }, () => undefined);
    };
    ipcRenderer.on("gitcrest:diff-window-requests-pending", takeRequests);
    takeRequests();
    return () => ipcRenderer.removeListener("gitcrest:diff-window-requests-pending", takeRequests);
  },
  showItemInFolder: (path: string): Promise<void> => ipcRenderer.invoke("gitcrest:show-item-in-folder", path),
  listLanguagePlugins: (): Promise<LanguagePluginListing> => ipcRenderer.invoke("gitcrest:list-language-plugins"),
  readLanguagePluginGrammar: (id: string): Promise<Uint8Array> => ipcRenderer.invoke("gitcrest:read-language-plugin-grammar", id),
  openLanguagePluginFolder: (): Promise<void> => ipcRenderer.invoke("gitcrest:open-language-plugin-folder"),
  getCoreStatus: (): Promise<CoreStatus> => ipcRenderer.invoke("gitcrest:get-core-status"),
  restartCore: (): Promise<CoreStatus> => ipcRenderer.invoke("gitcrest:restart-core"),
  showCoreHealthLog: (): Promise<void> => ipcRenderer.invoke("gitcrest:show-core-health-log"),
  subscribeToCoreStatus: (listener: (status: CoreStatus) => void): (() => void) => {
    const handleCoreStatus = (_event: Electron.IpcRendererEvent, status: CoreStatus): void => listener(status);
    ipcRenderer.on("gitcrest:core-status", handleCoreStatus);
    return () => ipcRenderer.removeListener("gitcrest:core-status", handleCoreStatus);
  },
  getUpdateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("gitcrest:get-update-status"),
  checkForUpdates: (): Promise<UpdateStatus> => ipcRenderer.invoke("gitcrest:check-for-updates"),
  installUpdate: (): Promise<boolean> => ipcRenderer.invoke("gitcrest:install-update"),
  subscribeToUpdateStatus: (listener: (status: UpdateStatus) => void): (() => void) => {
    const handleUpdateStatus = (_event: Electron.IpcRendererEvent, status: UpdateStatus): void => listener(status);
    ipcRenderer.on("gitcrest:update-status", handleUpdateStatus);
    return () => ipcRenderer.removeListener("gitcrest:update-status", handleUpdateStatus);
  },
  subscribeToEvents: async (listener: (event: EventEnvelope) => void): Promise<() => void> => {
    const handleEvent = (_event: Electron.IpcRendererEvent, payload: EventEnvelope): void => listener(payload);
    ipcRenderer.on("gitcrest:event", handleEvent);
    try {
      await ipcRenderer.invoke("gitcrest:connect-events");
    } catch (error) {
      ipcRenderer.removeListener("gitcrest:event", handleEvent);
      throw error;
    }

    return () => {
      ipcRenderer.removeListener("gitcrest:event", handleEvent);
      void ipcRenderer.invoke("gitcrest:disconnect-events").catch(() => undefined);
    };
  },
};

contextBridge.exposeInMainWorld("gitcrest", api);
