import { execFile } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AuthenticationFailureServer {
  certificatePath: string;
  host: string;
  remoteUrl: string;
  close: () => Promise<void>;
}

export async function createAuthenticationFailureServer(directory: string): Promise<AuthenticationFailureServer> {
  const keyPath = resolve(directory, "localhost-key.pem");
  const certificatePath = resolve(directory, "localhost-cert.pem");
  const gitExecPath = (await execFileAsync("git", ["--exec-path"])).stdout.trim();
  const opensslPath = resolve(gitExecPath, "..", "..", "bin", "openssl.exe");
  await execFileAsync(opensslPath, [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath,
    "-out", certificatePath, "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1",
  ]);

  const server = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (_request, response) => {
    response.writeHead(401, {
      "Content-Type": "text/plain",
      "WWW-Authenticate": 'Basic realm="GitCrest E2E"',
    });
    response.end("authentication required\n");
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

  const host = `127.0.0.1:${address.port}`;
  return {
    certificatePath,
    host,
    remoteUrl: `https://${host}/repository.git`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose());
    }),
  };
}
