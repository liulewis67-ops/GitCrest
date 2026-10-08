import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, ipcMain, shell, type WebContents } from "electron";
import { startSidecar, stopSidecar, type SidecarConnection } from "./sidecar";
import { UpdateController, type UpdateEventSource } from "./update-controller";
import WebSocket from "ws";

let mainWindow: BrowserWindow | undefined;
let sidecarConnection: SidecarConnection | undefined;
type WindowAccess = "readWrite" | "readOnly" | "conflictResolution";
interface DiffWindowRequest {
  repoId: string;
  path: string;
  scope: "workingTree" | "index" | "commit";
  commitOid?: string;
}
interface ConflictWindowRequest { repoId: string; taskId: string }
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
const updateFeedConfigured = app.isPackaged && existsSync(join(process.resourcesPath, "app-update.yml"));
const autoUpdater: (UpdateEventSource & { autoDownload: boolean; autoInstallOnAppQuit: boolean }) | undefined = updateFeedConfigured
  ? (await import("electron-updater")).default.autoUpdater
  : undefined;
if (autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
}
const updateController = new UpdateController(updateFeedConfigured, autoUpdater, (status) => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (windowAccessByContentsId.has(window.webContents.id) && !window.webContents.isDestroyed()) {
      window.webContents.send("gitcrest:update-status", status);
    }
  }
});

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
    token: windowAccess === "readOnly" ? sidecarConnection.readOnlyToken : windowAccess === "conflictResolution" ? sidecarConnection.conflictToken : sidecarConnection.token,
    windowAccess,
  };
});

ipcMain.handle("gitcrest:get-update-status", (event) => {
  if (!windowAccessByContentsId.has(event.sender.id)) {
    throw new Error("This window is not authorized to read application update status.");
  }
  return updateController.getStatus();
});

ipcMain.handle("gitcrest:check-for-updates", async (event) => {
  assertApplicationWindow(event.sender.id);
  return await updateController.checkForUpdates();
});

ipcMain.handle("gitcrest:install-update", (event) => {
  assertApplicationWindow(event.sender.id);
  return updateController.installDownloadedUpdate();
});

function assertApplicationWindow(contentsId: number): void {
  if (!windowAccessByContentsId.has(contentsId)) {
    throw new Error("This window is not authorized to manage application updates.");
  }
}

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
    : stream.windowAccess === "conflictResolution"
      ? sidecarConnection.conflictToken
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

ipcMain.handle("gitcrest:open-diff-window", async (event, value: unknown) => {
  if (windowAccessByContentsId.get(event.sender.id) !== "readWrite") {
    throw new Error("Only the main window can open a Diff window.");
  }
  const request = parseDiffWindowRequest(value);
  await createWindow("readOnly", request);
});

ipcMain.handle("gitcrest:open-conflict-window", async (event, value: unknown) => {
  if (windowAccessByContentsId.get(event.sender.id) !== "readWrite") {
    throw new Error("Only the main window can open a conflict window.");
  }
  await createWindow("conflictResolution", undefined, parseConflictWindowRequest(value));
});

function parseConflictWindowRequest(value: unknown): ConflictWindowRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid conflict window request.");
  const request = value as Partial<ConflictWindowRequest>;
  if (typeof request.repoId !== "string" || !/^repo_[a-f0-9]{64}$/.test(request.repoId)) throw new Error("Invalid repository ID for conflict window.");
  if (typeof request.taskId !== "string" || !/^task-[0-9]{1,20}-[0-9]{1,20}$/.test(request.taskId)) throw new Error("Invalid workflow task ID for conflict window.");
  return request as ConflictWindowRequest;
}

function parseDiffWindowRequest(value: unknown): DiffWindowRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid Diff window request.");
  const request = value as Partial<DiffWindowRequest>;
  if (typeof request.repoId !== "string" || !/^repo_[a-f0-9]{64}$/.test(request.repoId)) {
    throw new Error("Invalid repository ID for Diff window.");
  }
  if (typeof request.path !== "string" || request.path.trim().length === 0 || request.path.length > 4096) {
    throw new Error("Invalid file path for Diff window.");
  }
  if (!["workingTree", "index", "commit"].includes(request.scope || "")) {
    throw new Error("Invalid Diff scope.");
  }
  if (request.scope === "commit" && (typeof request.commitOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(request.commitOid))) {
    throw new Error("A full commit ID is required for a historical Diff window.");
  }
  if (request.scope !== "commit" && request.commitOid !== undefined) {
    throw new Error("A commit ID is only valid for a historical Diff window.");
  }
  return request as DiffWindowRequest;
}

async function createWindow(windowAccess: WindowAccess = "readWrite", diffRequest?: DiffWindowRequest, conflictRequest?: ConflictWindowRequest): Promise<void> {
  sidecarConnection = await startSidecar();
  const secondaryWindow = Boolean(diffRequest || conflictRequest);

  const window = new BrowserWindow({
    width: secondaryWindow ? 1180 : 1280,
    height: secondaryWindow ? 780 : 820,
    minWidth: secondaryWindow ? 760 : 960,
    minHeight: secondaryWindow ? 520 : 640,
    title: diffRequest ? `Diff · ${diffRequest.path}` : conflictRequest ? "Resolve conflicts · GitCrest" : "GitCrest",
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

  const query: Record<string, string> | undefined = diffRequest ? {
    view: "diff",
    repoId: diffRequest.repoId,
    path: diffRequest.path,
    scope: diffRequest.scope,
    ...(diffRequest.commitOid ? { commitOid: diffRequest.commitOid } : {}),
  } : conflictRequest ? { view: "conflicts", repoId: conflictRequest.repoId, taskId: conflictRequest.taskId } : undefined;
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [key, value] of Object.entries(query || {})) rendererUrl.searchParams.set(key, value);
    await window.loadURL(rendererUrl.toString());
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"), query ? { query } : undefined);
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
