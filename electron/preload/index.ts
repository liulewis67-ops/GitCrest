import { contextBridge, ipcRenderer } from "electron";

export interface SidecarConnection {
  baseUrl: string;
  token: string;
}

const api = {
  getSidecarConnection: (): Promise<SidecarConnection> => {
    return ipcRenderer.invoke("gitcrest:get-sidecar-connection");
  },
};

contextBridge.exposeInMainWorld("gitcrest", api);
