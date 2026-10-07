import { contextBridge, ipcRenderer } from "electron";
import type { components } from "../../src/api/schema";

type EventEnvelope = components["schemas"]["EventEnvelope"];

export interface SidecarConnection {
  baseUrl: string;
  token: string;
  windowAccess: "readWrite" | "readOnly";
}

const api = {
  getSidecarConnection: (): Promise<SidecarConnection> => {
    return ipcRenderer.invoke("gitcrest:get-sidecar-connection");
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
