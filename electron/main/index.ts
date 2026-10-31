import { parseDiffWindowRequest, type DiffWindowRequest } from "./diff-window-request";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, Notification, app, dialog, ipcMain, shell, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { CoreStatus } from "../../src/api/core-status";
import { CoreRestartPolicy } from "./core-supervisor";
import {
  DEFAULT_EXTERNAL_TOOLS,
  detectEditors,
  openInEditor,
  openInTerminal,
  parseExternalToolsConfig,
  resolveInsideRepository,
  validateCustomProgram,
  type EditorChoice,
  type ExternalToolsConfig,
  type ExternalToolsEnvironment,
  type OpenResult,
} from "./external-tools";
import { listLanguagePlugins, readLanguagePluginGrammar } from "./language-plugins";
import { onSidecarUnexpectedExit, startSidecar, stopSidecar, type SidecarConnection } from "./sidecar";
import { UpdateController, type UpdateEventSource } from "./update-controller";
import { getLinuxUpdateManifestPublicKey, isUpdateFeedConfigured } from "./update-config";
import { requireLinuxUpdateInfoSignature } from "./update-manifest-signature";
import WebSocket from "ws";

// Startup phase marks for the desktop benchmark, in epoch milliseconds; kept only when the benchmark asks for them.
const startupPhases: Record<string, number> | undefined = process.env.GITCREST_BENCH_STARTUP_PHASES === "1"
  ? { mainProcessStart: performance.timeOrigin }
  : undefined;
if (startupPhases) Object.assign(globalThis, { gitcrestStartupPhases: startupPhases });

function markStartupPhase(name: string): void {
  if (startupPhases && startupPhases[name] === undefined) startupPhases[name] = performance.timeOrigin + performance.now();
}

let mainWindow: BrowserWindow | undefined;
let sidecarConnection: SidecarConnection | undefined;
let finishingQuit = false;
// The generation goes up each time a core becomes ready, so a window can tell a restarted core from the one it used.
let coreStatus: CoreStatus = { state: "restarting", message: "Starting local GitCrest core..." };
let coreGeneration = 0;
let coreRestartTimer: ReturnType<typeof setTimeout> | undefined;
const coreRestartPolicy = new CoreRestartPolicy();
type WindowAccess = "readWrite" | "readOnly" | "conflictResolution";
interface ConflictWindowRequest { repoId: string; taskId: string }
const windowAccessByContentsId = new Map<number, WindowAccess>();
// One Diff window per repository: a further Diff opens as a tab there rather than as another renderer process.
// Its requests wait here until the window takes them, so none are lost while it is still loading.
const diffWindowsByRepoId = new Map<string, BrowserWindow>();
const pendingDiffRequestsByContentsId = new Map<number, DiffWindowRequest[]>();
const MAX_PENDING_DIFF_REQUESTS = 100;

interface EventStream {
  webContents: WebContents;
  windowAccess: WindowAccess;
  socket?: WebSocket;
  reconnectTimer?: ReturnType<typeof setTimeout>;
  attempts: number;
  stopped: boolean;
}

const eventStreamsByContentsId = new Map<number, EventStream>();
const updateConfig = (() => {
  if (!app.isPackaged) return undefined;
  const updateConfigPath = join(process.resourcesPath, "app-update.yml");
  try {
    return readFileSync(updateConfigPath, "utf8");
  } catch {
    return undefined;
  }
})();
const linuxUpdateManifestPublicKey = process.platform === "linux"
  ? getLinuxUpdateManifestPublicKey(updateConfig)
  : undefined;
const updateFeedConfigured = isUpdateFeedConfigured(app.isPackaged, process.platform, updateConfig);
const autoUpdater: (UpdateEventSource & { autoDownload: boolean; autoInstallOnAppQuit: boolean }) | undefined = updateFeedConfigured
  ? (await import("electron-updater")).default.autoUpdater
  : undefined;
if (autoUpdater) {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (linuxUpdateManifestPublicKey) {
    requireLinuxUpdateInfoSignature(
      autoUpdater as unknown as UpdateEventSource & { isUpdateSupported: (updateInfo: unknown) => boolean | Promise<boolean> },
      linuxUpdateManifestPublicKey,
    );
  }
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
  if (!windowAccess) {
    throw new Error("This window is not authorized to access the GitCrest API.");
  }
  if (!sidecarConnection) {
    throw new Error(coreStatus.state === "ready" ? "The GitCrest core is not running." : coreStatus.message);
  }

  return {
    baseUrl: sidecarConnection.baseUrl,
    token: windowAccess === "readOnly" ? sidecarConnection.readOnlyToken : windowAccess === "conflictResolution" ? sidecarConnection.conflictToken : sidecarConnection.token,
    windowAccess,
  };
});

ipcMain.handle("gitcrest:get-core-status", (event) => {
  assertApplicationWindow(event.sender.id);
  return coreStatus;
});

ipcMain.handle("gitcrest:restart-core", async (event) => {
  if (windowAccessByContentsId.get(event.sender.id) !== "readWrite") {
    throw new Error("Only the main window can restart the GitCrest core.");
  }
  if (coreStatus.state !== "failed") return coreStatus;
  coreRestartPolicy.reset();
  await restartCore();
  return coreStatus;
});

function publishCoreStatus(status: CoreStatus): void {
  coreStatus = status;
  for (const window of BrowserWindow.getAllWindows()) {
    if (windowAccessByContentsId.has(window.webContents.id) && !window.webContents.isDestroyed()) {
      window.webContents.send("gitcrest:core-status", status);
    }
  }
}

async function restartCore(): Promise<void> {
  if (finishingQuit) return;
  publishCoreStatus({ state: "restarting", message: "Restarting the GitCrest core..." });
  try {
    sidecarConnection = await startSidecar();
  } catch (error) {
    if (!finishingQuit) handleCoreExit(error instanceof Error ? error.message : String(error));
    return;
  }
  if (finishingQuit) return;
  coreGeneration += 1;
  // Event streams live here, so they move to the new core and its tokens without the windows subscribing again.
  for (const [contentsId, stream] of eventStreamsByContentsId) {
    if (stream.reconnectTimer) clearTimeout(stream.reconnectTimer);
    stream.reconnectTimer = undefined;
    stream.attempts = 0;
    const socket = stream.socket;
    stream.socket = undefined;
    socket?.close(1000, "core restarted");
    connectEventStream(contentsId, stream);
  }
  publishCoreStatus({ state: "ready", generation: coreGeneration });
}

function handleCoreExit(message: string): void {
  sidecarConnection = undefined;
  if (finishingQuit || coreRestartTimer) return;
  console.error(`[gitcrest-core] ${message}`);
  const delayMs = coreRestartPolicy.nextRestartDelay(Date.now());
  if (delayMs === undefined) {
    publishCoreStatus({ state: "failed", message });
    return;
  }
  publishCoreStatus({ state: "restarting", message });
  coreRestartTimer = setTimeout(() => {
    coreRestartTimer = undefined;
    void restartCore();
  }, delayMs);
}

onSidecarUnexpectedExit(handleCoreExit);

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

ipcMain.handle("gitcrest:show-item-in-folder", (event, value: unknown) => {
  if (windowAccessByContentsId.get(event.sender.id) !== "readWrite") {
    throw new Error("Only the main window can reveal files.");
  }
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096) {
    throw new Error("Invalid file path to reveal.");
  }
  shell.showItemInFolder(value);
});

// --- Opening a repository in other programs -------------------------------------------------------

function externalToolsConfigPath(): string {
  return join(app.getPath("userData"), "external-tools.json");
}

function readExternalToolsConfig(): ExternalToolsConfig {
  try {
    return parseExternalToolsConfig(JSON.parse(readFileSync(externalToolsConfigPath(), "utf8")));
  } catch {
    return DEFAULT_EXTERNAL_TOOLS;
  }
}

/** The program found on PATH, with the extensions Windows adds to a bare name. */
function findOnPath(program: string): string | undefined {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE").split(";").filter((extension) => extension.toLowerCase() === ".exe") : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const names = /\.[A-Za-z0-9]+$/.test(program) ? [program] : extensions.map((extension) => program + extension);
    for (const name of names) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const externalToolsEnvironment: ExternalToolsEnvironment = {
  platform: process.platform,
  env: process.env,
  fileExists: (path) => existsSync(path),
  findOnPath,
  // Started detached and without a shell; resolves once the program is running, or with why it was not.
  start: (program, args, options) => new Promise((resolve) => {
    try {
      const child = spawn(program, args, { cwd: options.cwd, detached: true, stdio: "ignore", shell: false });
      child.once("error", (error) => resolve(error.message));
      child.once("spawn", () => {
        child.unref();
        resolve(undefined);
      });
    } catch (error) {
      resolve(error instanceof Error ? error.message : "The program could not be started.");
    }
  }),
};

/** The folder of an open repository, asked of the core so a window can only name repositories that exist. */
async function repositoryFolder(repoId: unknown): Promise<string | undefined> {
  if (typeof repoId !== "string" || repoId.length === 0 || repoId.length > 200 || !sidecarConnection) return undefined;
  try {
    const response = await fetch(new URL(`/api/v1/repositories/${encodeURIComponent(repoId)}`, sidecarConnection.baseUrl), {
      headers: { Authorization: `Bearer ${sidecarConnection.token}`, "X-GitCrest-API-Version": "1" },
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { path?: unknown };
    return typeof body.path === "string" ? body.path : undefined;
  } catch {
    return undefined;
  }
}

function requireMainWindow(event: IpcMainInvokeEvent): void {
  if (windowAccessByContentsId.get(event.sender.id) !== "readWrite") {
    throw new Error("Only the main window can open other programs.");
  }
}

async function repositoryTarget(value: unknown): Promise<string | undefined> {
  const request = value as { repoId?: unknown; relativePath?: unknown } | null;
  if (!request || typeof request !== "object") return undefined;
  if (request.relativePath !== undefined && typeof request.relativePath !== "string") return undefined;
  const folder = await repositoryFolder(request.repoId);
  return folder ? resolveInsideRepository(folder, request.relativePath as string | undefined) : undefined;
}

const BAD_PATH: OpenResult = { ok: false, code: "badPath", message: "That path is not inside an open repository." };

ipcMain.handle("gitcrest:external-tools-get", (event) => {
  requireMainWindow(event);
  return { editor: readExternalToolsConfig().editor, detected: detectEditors(externalToolsEnvironment) };
});

ipcMain.handle("gitcrest:external-tools-set-editor", async (event, value: unknown): Promise<{ ok: true } | { ok: false; message: string }> => {
  requireMainWindow(event);
  const choice = (value ?? {}) as Partial<EditorChoice> & { program?: unknown };
  const config = parseExternalToolsConfig({ editor: choice });
  // A custom program is checked now, so a typo is reported where it was typed and not on first use.
  if (choice.kind === "custom") {
    const problem = validateCustomProgram(typeof choice.program === "string" ? choice.program : "", externalToolsEnvironment);
    if (problem) return { ok: false, message: problem };
  } else if (choice.kind !== "auto" && choice.kind !== "known") {
    return { ok: false, message: "Choose an editor." };
  }
  await mkdir(app.getPath("userData"), { recursive: true });
  await writeFile(externalToolsConfigPath(), JSON.stringify(config), "utf8");
  return { ok: true };
});

ipcMain.handle("gitcrest:open-in-editor", async (event, value: unknown): Promise<OpenResult> => {
  requireMainWindow(event);
  const target = await repositoryTarget(value);
  return target ? openInEditor(target, readExternalToolsConfig(), externalToolsEnvironment) : BAD_PATH;
});

ipcMain.handle("gitcrest:open-in-terminal", async (event, value: unknown): Promise<OpenResult> => {
  requireMainWindow(event);
  const target = await repositoryTarget(value);
  return target ? openInTerminal(target, externalToolsEnvironment) : BAD_PATH;
});

interface NotificationRequest { title: string; body: string; repoId?: string; taskId: string }

function parseNotificationRequest(value: unknown): NotificationRequest | undefined {
  const request = value as Partial<NotificationRequest> | null;
  if (!request || typeof request !== "object") return undefined;
  const { title, body, repoId, taskId } = request;
  if (typeof title !== "string" || title.length === 0 || title.length > 120) return undefined;
  if (typeof body !== "string" || body.length > 300) return undefined;
  if (typeof taskId !== "string" || taskId.length === 0 || taskId.length > 200) return undefined;
  if (repoId !== undefined && (typeof repoId !== "string" || repoId.length > 200)) return undefined;
  return { title, body, taskId, ...(repoId ? { repoId } : {}) };
}

// A notification is only raised while the window is not in front, and clicking it brings the window back.
ipcMain.handle("gitcrest:show-notification", (event, value: unknown): boolean => {
  requireMainWindow(event);
  const request = parseNotificationRequest(value);
  const window = mainWindow;
  if (!request || !window || window.isDestroyed() || window.isFocused() || !Notification.isSupported()) return false;
  const notification = new Notification({ title: request.title, body: request.body, silent: false });
  notification.on("click", () => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    window.webContents.send("gitcrest:notification-click", { repoId: request.repoId, taskId: request.taskId });
  });
  notification.show();
  return true;
});

ipcMain.handle("gitcrest:open-external-url", (event, value: unknown): boolean => {
  requireMainWindow(event);
  if (typeof value !== "string" || value.length > 2048) return false;
  openExternalHttpUrl(value);
  return true;
});

/** Language plugins live beside the app's other data; tests point this at a temporary folder. */
function languagePluginDirectory(): string {
  return process.env.GITCREST_LANGUAGE_PLUGINS_PATH || join(app.getPath("userData"), "language-plugins");
}

ipcMain.handle("gitcrest:list-language-plugins", async (event) => {
  if (!windowAccessByContentsId.has(event.sender.id)) throw new Error("This window is not authorized to read language plugins.");
  return await listLanguagePlugins(languagePluginDirectory());
});

ipcMain.handle("gitcrest:read-language-plugin-grammar", async (event, id: unknown) => {
  if (!windowAccessByContentsId.has(event.sender.id)) throw new Error("This window is not authorized to read language plugins.");
  return await readLanguagePluginGrammar(languagePluginDirectory(), id);
});

ipcMain.handle("gitcrest:open-language-plugin-folder", async (event) => {
  if (windowAccessByContentsId.get(event.sender.id) !== "readWrite") throw new Error("Only the main window can open the language plugin folder.");
  const directory = languagePluginDirectory();
  await mkdir(directory, { recursive: true });
  const failure = await shell.openPath(directory);
  if (failure) throw new Error(failure);
});

function senderWindow(event: IpcMainInvokeEvent): BrowserWindow {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !windowAccessByContentsId.has(event.sender.id)) {
    throw new Error("This window is not authorized to control its frame.");
  }
  return window;
}

ipcMain.handle("gitcrest:window-control", (event, action: unknown) => {
  const window = senderWindow(event);
  if (action === "minimize") window.minimize();
  else if (action === "toggleMaximize") {
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  } else if (action === "close") window.close();
  else throw new Error("Unknown window control.");
});

ipcMain.handle("gitcrest:is-window-maximized", (event) => senderWindow(event).isMaximized());

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
  if (!windowAccess) {
    throw new Error("This window is not authorized to access GitCrest events.");
  }
  // Without a running core the stream is only registered; restartCore connects it once the core is ready.
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
  const diffWindow = diffWindowsByRepoId.get(request.repoId);
  if (diffWindow && !diffWindow.isDestroyed()) {
    const contentsId = diffWindow.webContents.id;
    const pending = pendingDiffRequestsByContentsId.get(contentsId) ?? [];
    pending.push(request);
    pendingDiffRequestsByContentsId.set(contentsId, pending.slice(-MAX_PENDING_DIFF_REQUESTS));
    diffWindow.webContents.send("gitcrest:diff-window-requests-pending");
    // A window that is still loading shows itself when ready.
    if (diffWindow.isVisible()) {
      if (diffWindow.isMinimized()) diffWindow.restore();
      diffWindow.focus();
    }
    return;
  }
  await createWindow("readOnly", request);
});

ipcMain.handle("gitcrest:take-diff-window-requests", (event) => {
  if (windowAccessByContentsId.get(event.sender.id) !== "readOnly") {
    throw new Error("Only a Diff window can take Diff requests.");
  }
  const pending = pendingDiffRequestsByContentsId.get(event.sender.id) ?? [];
  pendingDiffRequestsByContentsId.delete(event.sender.id);
  return pending;
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

/**
 * Starts the first core. It runs beside the first window's renderer load rather than before it; the window
 * shows the starting status and connects when the core reports ready, as it does after a restart.
 */
async function startInitialCore(): Promise<void> {
  sidecarConnection = await startSidecar();
  markStartupPhase("sidecarReady");
  if (finishingQuit) return;
  coreGeneration = 1;
  publishCoreStatus({ state: "ready", generation: coreGeneration });
}

async function createWindow(windowAccess: WindowAccess = "readWrite", diffRequest?: DiffWindowRequest, conflictRequest?: ConflictWindowRequest): Promise<void> {
  // While the core starts or restarts, the window opens at once and connects when the core reports ready.
  if (!sidecarConnection && coreStatus.state === "failed") throw new Error(coreStatus.message);
  const secondaryWindow = Boolean(diffRequest || conflictRequest);

  const window = new BrowserWindow({
    width: secondaryWindow ? 1180 : 1280,
    height: secondaryWindow ? 780 : 820,
    minWidth: secondaryWindow ? 760 : 960,
    minHeight: secondaryWindow ? 520 : 640,
    // Packaged builds take the icon from the executable; development runs would otherwise show Electron's.
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), "build/icons/256x256.png") }),
    title: diffRequest ? `Diff · ${diffRequest.path}` : conflictRequest ? "Resolve conflicts · GitCrest" : "GitCrest",
    show: false,
    // Windows and Linux windows are frameless: each in-app header is the drag region and draws its own window
    // controls. macOS keeps the traffic lights over the main and conflict headers, and a native frame on Diff windows.
    ...(process.platform !== "darwin"
      ? { frame: false }
      : diffRequest
        ? {}
        : { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 14, y: 15 } }),
    webPreferences: {
      // The preload only needs contextBridge and ipcRenderer, so the renderer runs sandboxed and skips
      // starting a Node.js environment of its own.
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (windowAccess === "readWrite") {
    markStartupPhase("windowCreated");
    window.webContents.once("dom-ready", () => markStartupPhase("domContentLoaded"));
  }
  window.once("ready-to-show", () => {
    if (windowAccess === "readWrite") markStartupPhase("readyToShow");
    window.show();
  });
  // The drawn maximize button swaps to a restore icon, however the window got maximized.
  window.on("maximize", () => window.webContents.send("gitcrest:window-maximized", true));
  window.on("unmaximize", () => window.webContents.send("gitcrest:window-maximized", false));

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
  if (diffRequest) diffWindowsByRepoId.set(diffRequest.repoId, window);
  window.webContents.once("destroyed", () => {
    stopEventStream(contentsId);
    windowAccessByContentsId.delete(contentsId);
    pendingDiffRequestsByContentsId.delete(contentsId);
    if (diffRequest && diffWindowsByRepoId.get(diffRequest.repoId) === window) {
      diffWindowsByRepoId.delete(diffRequest.repoId);
    }
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
    ...(diffRequest.fromOid ? { fromOid: diffRequest.fromOid } : {}),
    ...(diffRequest.toOid ? { toOid: diffRequest.toOid } : {}),
  } : conflictRequest ? { view: "conflicts", repoId: conflictRequest.repoId, taskId: conflictRequest.taskId } : undefined;
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [key, value] of Object.entries(query || {})) rendererUrl.searchParams.set(key, value);
    await window.loadURL(rendererUrl.toString());
  } else {
    await window.loadFile(join(__dirname, "../renderer/index.html"), query ? { query } : undefined);
  }
}

markStartupPhase("mainModuleLoaded");
// A first core that cannot start still ends the app with its error, which carries the core's last output.
app.whenReady().then(() => {
  markStartupPhase("appReady");
  return Promise.all([startInitialCore(), createWindow()]);
}).catch((error: unknown) => {
  if (finishingQuit) return;
  const message = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("GitCrest could not start", message);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((error: unknown) => {
      dialog.showErrorBox("GitCrest could not open a window", error instanceof Error ? error.message : String(error));
    });
  }
});

app.on("before-quit", (event) => {
  if (finishingQuit) return;
  event.preventDefault();
  finishingQuit = true;
  if (coreRestartTimer) clearTimeout(coreRestartTimer);
  coreRestartTimer = undefined;
  void stopSidecar().finally(() => app.quit());
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
