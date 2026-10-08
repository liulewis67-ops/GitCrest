import { contextBridge, ipcRenderer } from "electron";
import type { components } from "../../src/api/schema";
import type { UpdateStatus } from "../../src/api/update-status";

type EventEnvelope = components["schemas"]["EventEnvelope"];

export interface SidecarConnection {
  baseUrl: string;
  token: string;
  windowAccess: "readWrite" | "readOnly" | "conflictResolution";
}

export interface DiffWindowRequest {
  repoId: string;
  path: string;
  scope: "workingTree" | "index" | "commit";
  commitOid?: string;
}

export interface ConflictWindowRequest {
  repoId: string;
  taskId: string;
}

const api = {
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
