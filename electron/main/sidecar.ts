import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";

export interface SidecarConnection {
  baseUrl: string;
  token: string;
  readOnlyToken: string;
}

interface ReadyMessage {
  event: "ready";
  host: string;
  port: number;
}

let child: ChildProcessWithoutNullStreams | undefined;
let connection: SidecarConnection | undefined;
const STARTUP_TIMEOUT_MS = 10_000;

function resolveSidecarPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "bin", "gitcrest-core.exe");
  }

  return resolve(app.getAppPath(), "crates", "gitcrest-core", "target", "debug", "gitcrest-core.exe");
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

export async function startSidecar(): Promise<SidecarConnection> {
  if (connection) {
    return connection;
  }

  const sidecarPath = resolveSidecarPath();
  if (!existsSync(sidecarPath)) {
    throw new Error(`Rust sidecar not found at ${sidecarPath}. Run "pnpm core:build" first.`);
  }

  const token = randomBytes(32).toString("base64url");
  const readOnlyToken = randomBytes(32).toString("base64url");
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  const corsOrigin = rendererUrl ? new URL(rendererUrl).origin : "";

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdoutBuffer = "";
    const startupTimeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child?.kill();
      child = undefined;
      reject(new Error(`Rust sidecar did not become ready within ${STARTUP_TIMEOUT_MS / 1000} seconds.`));
    }, STARTUP_TIMEOUT_MS);

    const finish = (error?: Error, ready?: ReadyMessage): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(startupTimeout);
      if (error) {
        reject(error);
        return;
      }
      if (!ready) {
        reject(new Error("Rust sidecar exited without a valid ready message."));
        return;
      }
      connection = { baseUrl: `http://${ready.host}:${ready.port}`, token, readOnlyToken };
      resolvePromise(connection);
    };

    child = spawn(sidecarPath, [], {
      env: {
        ...process.env,
        GITCREST_HOST: "127.0.0.1",
          GITCREST_PORT: "0",
          GITCREST_DATABASE_PATH: process.env.GITCREST_DATABASE_PATH || join(app.getPath("userData"), "gitcrest.sqlite"),
        GITCREST_AUTH_TOKEN: token,
        GITCREST_READONLY_TOKEN: readOnlyToken,
        GITCREST_CORS_ORIGIN: corsOrigin,
      },
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const ready = parseReadyLine(line.trim());
        if (ready) {
          finish(undefined, ready);
          break;
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[gitcrest-core] ${chunk.toString("utf8").trim()}`);
    });

    child.on("error", (error) => {
      finish(new Error(`Could not start Rust sidecar: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      child = undefined;
      connection = undefined;
      finish(new Error(`Rust sidecar exited before ready: code=${code ?? "null"} signal=${signal ?? "null"}`));
    });
  });
}

export function stopSidecar(): void {
  if (!child) {
    return;
  }

  child.kill();
  child = undefined;
  connection = undefined;
}
