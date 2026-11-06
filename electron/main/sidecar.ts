import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { OutputTail, withCoreOutput } from "./core-supervisor";
import { resolveSidecarPath } from "./sidecar-path";
import { terminateSidecar } from "./sidecar-termination";

export interface SidecarConnection {
  baseUrl: string;
  token: string;
  readOnlyToken: string;
  conflictToken: string;
}

interface ReadyMessage {
  event: "ready";
  host: string;
  port: number;
}

let child: ChildProcessWithoutNullStreams | undefined;
let connection: SidecarConnection | undefined;
let startup: Promise<SidecarConnection> | undefined;
let stopping: Promise<void> | undefined;
let unexpectedExitListener: ((message: string) => void) | undefined;
const STARTUP_TIMEOUT_MS = 10_000;

/** Called when a core that had become ready exits without stopSidecar asking it to. */
export function onSidecarUnexpectedExit(listener: (message: string) => void): void {
  unexpectedExitListener = listener;
}

function parseReadyLine(line: string): ReadyMessage | undefined {
  try {
    const message = JSON.parse(line) as Partial<ReadyMessage>;
    if (
      message.event === "ready" &&
      message.host === "127.0.0.1" &&
      typeof message.port === "number" &&
      Number.isInteger(message.port) &&
      message.port > 0 &&
      message.port <= 65_535
    ) {
      return message as ReadyMessage;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

export function startSidecar(): Promise<SidecarConnection> {
  // A restart must not overlap the old core's graceful shutdown and writes.
  if (stopping) return stopping.then(() => startSidecar());
  if (connection) return Promise.resolve(connection);
  // Windows opened while the core is still starting share that start instead of spawning a second core.
  if (!startup) {
    startup = spawnSidecar().finally(() => {
      startup = undefined;
    });
  }
  return startup;
}

async function spawnSidecar(): Promise<SidecarConnection> {
  const sidecarPath = resolveSidecarPath(process.platform, app.isPackaged, process.resourcesPath, app.getAppPath());
  if (!existsSync(sidecarPath)) {
    throw new Error(`Rust sidecar not found at ${sidecarPath}. Run "pnpm core:build" first.`);
  }

  const token = randomBytes(32).toString("base64url");
  const readOnlyToken = randomBytes(32).toString("base64url");
  const conflictToken = randomBytes(32).toString("base64url");
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const corsOrigin = rendererUrl ? new URL(rendererUrl).origin : "";

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    let ready = false;
    let stdoutBuffer = "";
    const stderrTail = new OutputTail();
    const spawned = spawn(sidecarPath, [], {
      env: {
        ...process.env,
        GITCREST_HOST: "127.0.0.1",
        GITCREST_PORT: "0",
        GITCREST_DATABASE_PATH: process.env.GITCREST_DATABASE_PATH || join(app.getPath("userData"), "gitcrest.sqlite"),
        GITCREST_AUTH_TOKEN: token,
        GITCREST_READONLY_TOKEN: readOnlyToken,
        GITCREST_CONFLICT_TOKEN: conflictToken,
        GITCREST_CORS_ORIGIN: corsOrigin,
      },
      windowsHide: true,
    });
    child = spawned;

    const startupTimeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      // Startup recovery may still own Git children or directory writes. Give
      // it the same EOF notification and shutdown wait as a normal app close.
      void stopSidecar().then(() => {
        reject(new Error(withCoreOutput(`Rust sidecar did not become ready within ${STARTUP_TIMEOUT_MS / 1000} seconds.`, stderrTail.text())));
      });
    }, STARTUP_TIMEOUT_MS);

    const finish = (error?: Error, message?: ReadyMessage): void => {
      if (settled) {
        return;
      }
      if (message && child !== spawned) return;
      settled = true;
      clearTimeout(startupTimeout);
      if (error) {
        reject(error);
        return;
      }
      if (!message) {
        reject(new Error("Rust sidecar exited without a valid ready message."));
        return;
      }
      ready = true;
      connection = { baseUrl: `http://${message.host}:${message.port}`, token, readOnlyToken, conflictToken };
      resolvePromise(connection);
    };

    spawned.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const message = parseReadyLine(line.trim());
        if (message) {
          finish(undefined, message);
          break;
        }
      }
    });

    spawned.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderrTail.push(text);
      console.error(`[gitcrest-core] ${text.trim()}`);
    });

    spawned.on("error", (error) => {
      if (child === spawned) child = undefined;
      finish(new Error(`Could not start Rust sidecar: ${error.message}`));
    });

    spawned.on("exit", (code, signal) => {
      // A core that stopSidecar detached, or that a later start replaced, is no longer this module's core.
      const current = child === spawned;
      if (current) {
        child = undefined;
        connection = undefined;
      }
      const exitDescription = `code=${code ?? "null"} signal=${signal ?? "null"}`;
      finish(new Error(withCoreOutput(`Rust sidecar exited before ready: ${exitDescription}`, stderrTail.text())));
      if (ready && current) {
        unexpectedExitListener?.(withCoreOutput(`The GitCrest core stopped unexpectedly (${exitDescription}).`, stderrTail.text()));
      }
    });
  });
}

export function stopSidecar(): Promise<void> {
  if (stopping) return stopping;
  const stoppingChild = child;
  child = undefined;
  connection = undefined;
  if (!stoppingChild) return Promise.resolve();

  stopping = new Promise<void>((resolve) => {
    let finished = false;
    let exited = false;
    let terminating = false;
    const finish = (): void => {
      if (finished || !exited || terminating) return;
      finished = true;
      clearTimeout(forceKill);
      stoppingChild.removeListener("exit", onExit);
      stoppingChild.removeListener("error", onError);
      resolve();
    };
    const onExit = (): void => { exited = true; finish(); };
    const onError = (): void => {
      // An error on an already-spawned process is not proof that it exited.
      if (stoppingChild.pid === undefined) onExit();
    };
    const forceKill = setTimeout(() => {
      terminating = true;
      void terminateSidecar(stoppingChild).then(() => {
        terminating = false;
        finish();
      }, (error: unknown) => {
        // Keep the shutdown/restart barrier if tree termination is unverified.
        console.error("Could not terminate the Rust sidecar process tree", error);
      });
    }, 15_000);
    stoppingChild.once("exit", onExit);
    stoppingChild.on("error", onError);
    stoppingChild.stdin.once("error", () => {});
    stoppingChild.stdin.end();
  }).finally(() => {
    stopping = undefined;
  });
  return stopping;
}
