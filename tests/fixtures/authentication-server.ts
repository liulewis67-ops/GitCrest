import { execFile, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AuthenticationFailureServer {
  certificatePath: string;
  host: string;
  remoteUrl: string;
  authenticatedRequestCount: () => number;
  waitForAuthenticatedRequest: () => Promise<void>;
  releaseAuthenticatedRequests: () => void;
  close: () => Promise<void>;
}

export interface AuthenticationServerOptions {
  projectRoot?: string;
  username?: string;
  token?: string;
  holdAuthenticatedRequests?: boolean;
}

export async function createAuthenticationFailureServer(
  directory: string,
  options: AuthenticationServerOptions = {},
): Promise<AuthenticationFailureServer> {
  const keyPath = resolve(directory, "localhost-key.pem");
  const certificatePath = resolve(directory, "localhost-cert.pem");
  const gitExecPath = (await execFileAsync("git", ["--exec-path"])).stdout.trim();
  const opensslPath = resolve(gitExecPath, "..", "..", "bin", "openssl.exe");
  const gitHttpBackendPath = resolve(gitExecPath, "git-http-backend.exe");
  await execFileAsync(opensslPath, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certificatePath, "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ]);

  let port = 0;
  let authenticatedRequests = 0;
  let announceAuthenticatedRequest: (() => void) | undefined;
  const authenticatedRequestReceived = new Promise<void>((resolveRequest) => {
    announceAuthenticatedRequest = resolveRequest;
  });
  let releaseHeldRequests: (() => void) | undefined;
  const authenticatedRequestsReleased = new Promise<void>((resolveRequests) => {
    releaseHeldRequests = resolveRequests;
  });
  const server = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, async (request, response) => {
    const expectedAuthorization = options.username && options.token
      ? `Basic ${Buffer.from(`${options.username}:${options.token}`).toString("base64")}`
      : undefined;
    if (!options.projectRoot || !expectedAuthorization || request.headers.authorization !== expectedAuthorization) {
      response.writeHead(401, {
        "Content-Type": "text/plain",
        "WWW-Authenticate": 'Basic realm="GitCrest E2E"',
      });
      response.end("authentication required\n");
      return;
    }

    authenticatedRequests += 1;
    announceAuthenticatedRequest?.();
    if (options.holdAuthenticatedRequests) {
      await authenticatedRequestsReleased;
      if (response.destroyed) return;
    }
    proxyGitHttpBackend(request, response, {
      executablePath: gitHttpBackendPath,
      executableDirectory: gitExecPath,
      projectRoot: options.projectRoot,
      port,
    });
  });

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
  } catch (error) {
    server.close();
    throw error;
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    throw new Error("Authentication fixture did not bind a TCP port");
  }
  port = address.port;

  const host = `127.0.0.1:${port}`;
  return {
    certificatePath,
    host,
    remoteUrl: `https://${host}/repository.git`,
    authenticatedRequestCount: () => authenticatedRequests,
    waitForAuthenticatedRequest: () => authenticatedRequestReceived,
    releaseAuthenticatedRequests: () => releaseHeldRequests?.(),
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}

function proxyGitHttpBackend(
  request: IncomingMessage,
  response: ServerResponse,
  options: { executablePath: string; executableDirectory: string; projectRoot: string; port: number },
) {
  const requestUrl = new URL(request.url || "/", "https://127.0.0.1");
  const child = spawn(options.executablePath, [], {
    env: {
      ...process.env,
      GIT_EXEC_PATH: options.executableDirectory,
      GIT_PROJECT_ROOT: options.projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: decodeURIComponent(requestUrl.pathname),
      QUERY_STRING: requestUrl.search.slice(1),
      REQUEST_METHOD: request.method || "GET",
      CONTENT_TYPE: String(request.headers["content-type"] || ""),
      CONTENT_LENGTH: String(request.headers["content-length"] || "0"),
      GIT_PROTOCOL: String(request.headers["git-protocol"] || ""),
      REMOTE_USER: "gitcrest-e2e",
      REMOTE_ADDR: "127.0.0.1",
      SERVER_PROTOCOL: `HTTP/${request.httpVersion}`,
      SERVER_NAME: "127.0.0.1",
      SERVER_PORT: String(options.port),
      HTTPS: "on",
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const output: Buffer[] = [];
  let outputBytes = 0;
  let settled = false;
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 64 * 1024 * 1024) {
      settled = true;
      child.kill();
      response.writeHead(502);
      response.end("Git HTTP response exceeded the fixture limit");
      return;
    }
    output.push(chunk);
  });
  child.once("error", () => {
    if (settled) return;
    settled = true;
    response.writeHead(502);
    response.end("Git HTTP backend could not start");
  });
  child.once("close", (code) => {
    if (settled) return;
    settled = true;
    if (code !== 0) {
      response.writeHead(502);
      response.end("Git HTTP backend failed");
      return;
    }
    const result = Buffer.concat(output);
    const crlfSeparator = result.indexOf("\r\n\r\n");
    const separator = crlfSeparator >= 0 ? crlfSeparator : result.indexOf("\n\n");
    const separatorLength = crlfSeparator >= 0 ? 4 : 2;
    if (separator < 0) {
      response.writeHead(502);
      response.end("Git HTTP backend returned an invalid response");
      return;
    }
    const headers = result.subarray(0, separator).toString("latin1").split(/\r?\n/);
    let status = 200;
    const responseHeaders: Record<string, string> = {};
    for (const line of headers) {
      const colon = line.indexOf(":");
      if (colon < 1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
      else if (["content-type", "cache-control", "pragma", "expires", "last-modified"].includes(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    }
    response.writeHead(status, responseHeaders);
    response.end(result.subarray(separator + separatorLength));
  });
  request.pipe(child.stdin!);
}
