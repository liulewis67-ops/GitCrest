import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { app } from "electron";

export interface SidecarConnection {
  baseUrl: string;
  token: string;
}

interface ReadyMessage {
  event: "ready";
  host: string;
  port: number;
}

let child: ChildProcessWithoutNullStreams | undefined;
let connection: SidecarConnection | undefined;

function resolveSidecarPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "bin", "gitcrest-core.exe");
  }

  return resolve(process.cwd(), "crates", "gitcrest-core", "target", "debug", "gitcrest-core.exe");
}

function parseReadyLine(line: string): ReadyMessage | undefined {
  try {
    const message = JSON.parse(line) as Partial<ReadyMessage>;
    if (message.event === "ready" && typeof message.host === "string" && typeof message.port === "number") {
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

  return await new Promise((resolvePromise, reject) => {
    let settled = false;
    let stdoutBuffer = "";

    child = spawn(sidecarPath, [], {
      env: {
        ...process.env,
        GITCREST_HOST: "127.0.0.1",
        GITCREST_PORT: "0",
        GITCREST_AUTH_TOKEN: token,
      },
      windowsHide: true,
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        const ready = parseReadyLine(line.trim());
        if (!ready || settled) {
          continue;
        }

        settled = true;
        connection = {
          baseUrl: `http://${ready.host}:${ready.port}`,
          token,
        };
        resolvePromise(connection);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[gitcrest-core] ${chunk.toString("utf8").trim()}`);
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("exit", (code, signal) => {
      child = undefined;
      connection = undefined;
      if (!settled) {
        settled = true;
        reject(new Error(`Rust sidecar exited before ready: code=${code ?? "null"} signal=${signal ?? "null"}`));
      }
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
