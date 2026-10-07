import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, shell, type WebContents } from "electron";
import { startSidecar, stopSidecar, type SidecarConnection } from "./sidecar";
import WebSocket from "ws";

let mainWindow: BrowserWindow | undefined;
let sidecarConnection: SidecarConnection | undefined;
type WindowAccess = "readWrite" | "readOnly";
const windowAccessByContentsId = new Map<number, WindowAccess>();

interface EventStream {
  webContents: WebContents;
  windowAccess: WindowAccess;
  socket?: WebSocket;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  attempts: number;
  stopped: boolean;
}

const eventStreamsByContentsId = new Map<number, EventStream>();

function isRendererNavigation(url: string): boolean {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    try {
      return new URL(url).origin === new URL(rendererUrl).origin;
    } catch {
      return false;
    }
  }

  return url === pathToFileURL(join(__dirname, "../renderer/index.html")).href;
}

function openExternalHttpUrl(url: string): void {
  try {
    const protocol = new URL(url).protocol;
    if (protocol === "http:" || protocol === "https:") {
      void shell.openExternal(url);
    }
  } catch {
    // Invalid and non-web schemes are denied.
  }
}

ipcMain.handle("gitcrest:get-sidecar-connection", (event) => {
  const windowAccess = windowAccessByContentsId.get(event.sender.id);
  if (!windowAccess || !sidecarConnection) {
    throw new Error("This window is not authorized to access the GitCrest API.");
  }

  return {
    baseUrl: sidecarConnection.baseUrl,
    token: windowAccess === "readOnly" ? sidecarConnection.readOnlyToken : sidecarConnection.token,
    windowAccess,
  };
});

ipcMain.handle("gitcrest:choose-repository", async (event) => {
  const windowAccess = windowAccessByContentsId.get(event.sender.id);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (windowAccess !== "readWrite" || !window) {
    throw new Error("This window is not authorized to choose a repository.");
  }

  const selection = await dialog.showOpenDialog(window, {
    title: "Open Git Repository",
    buttonLabel: "Open repository",
    properties: ["openDirectory"],
  });
  return selection.canceled ? undefined : selection.filePaths[0];
});

ipcMain.handle("gitcrest:choose-clone-parent", async (event) => {
  const windowAccess = windowAccessByContentsId.get(event.sender.id);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (windowAccess !== "readWrite" || !window) {
    throw new Error("This window is not authorized to choose a clone destination.");
  }
  const selection = await dialog.showOpenDialog(window, {
    title: "Choose Clone Location",
    buttonLabel: "Choose this folder",
    properties: ["openDirectory", "createDirectory"],
  });
  return selection.canceled ? undefined : selection.filePaths[0];
});

function connectEventStream(contentsId: number, stream: EventStream): void {
  if (stream.stopped || stream.webContents.isDestroyed() || !sidecarConnection) {
    return;
  }

  const token = stream.windowAccess === "readOnly"
    ? sidecarConnection.readOnlyToken
    : sidecarConnection.token;
  const socketUrl = new URL("/api/v1/events", sidecarConnection.baseUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

  try {
    const socket = new WebSocket(socketUrl, "gitcrest.events.v1", {
      handshakeTimeout: 5_000,
      perMessageDeflate: false,
      headers: {
        Authorization: `Bearer ${token}`,
        "X-GitCrest-API-Version": "1",
      },
    });
    stream.socket = socket;
    socket.on("open", () => {
      stream.attempts = 0;
    });
    socket.on("message", (data) => {
      if (stream.webContents.isDestroyed()) {
        return;
      }
      try {
        stream.webContents.send("gitcrest:event", JSON.parse(data.toString()));
      } catch {
        console.error("[gitcrest-core] Ignored an invalid event message.");
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (stream.socket !== socket) {
        return;
      }
      stream.socket = undefined;
      scheduleEventReconnect(contentsId, stream);
    });
  } catch {
    scheduleEventReconnect(contentsId, stream);
  }
}

function scheduleEventReconnect(contentsId: number, stream: EventStream): void {
  if (stream.stopped || stream.webContents.isDestroyed() || stream.reconnectTimer) {
    return;
  }

  const delayMs = Math.min(500 * 2 ** Math.min(stream.attempts, 6), 30_000);
  stream.attempts += 1;
  stream.reconnectTimer = setTimeout(() => {
    stream.reconnectTimer = undefined;
    connectEventStream(contentsId, stream);
  }, delayMs);
}

function stopEventStream(contentsId: number): void {
  const stream = eventStreamsByContentsId.get(contentsId);
  if (!stream) {
    return;
  }
  eventStreamsByContentsId.delete(contentsId);
  stream.stopped = true;
  if (stream.reconnectTimer) {
    clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = undefined;
  }
  stream.socket?.close(1000, "window closed");
  stream.socket = undefined;
}

ipcMain.handle("gitcrest:connect-events", (event) => {
  const windowAccess = windowAccessByContentsId.get(event.sender.id);
  if (!windowAccess || !sidecarConnection) {
    throw new Error("This window is not authorized to access GitCrest events.");
  }
  if (!eventStreamsByContentsId.has(event.sender.id)) {
    const stream: EventStream = { webContents: event.sender, windowAccess, attempts: 0, stopped: false };
    eventStreamsByContentsId.set(event.sender.id, stream);
    connectEventStream(event.sender.id, stream);
  }
});

ipcMain.handle("gitcrest:disconnect-events", (event) => {
  stopEventStream(event.sender.id);
});

async function createWindow(windowAccess: WindowAccess = "readWrite"): Promise<void> {
  sidecarConnection = await startSidecar();

  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "GitCrest",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isRendererNavigation(url)) {
      event.preventDefault();
      openExternalHttpUrl(url);
    }
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!isRendererNavigation(url)) {
      event.preventDefault();
    }
  });

  const contentsId = window.webContents.id;
  windowAccessByContentsId.set(contentsId, windowAccess);
  window.webContents.once("destroyed", () => {
    stopEventStream(contentsId);
    windowAccessByContentsId.delete(contentsId);
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });

  if (windowAccess === "readWrite") {
    mainWindow = window;
  }

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => createWindow()).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("GitCrest could not start", message);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createWindow();
  }
});

app.on("before-quit", () => {
  stopSidecar();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
