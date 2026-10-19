// Local debugging launcher for the Electron front end and the Rust core.
//
//   pnpm debug                 build the core (debug), then run Electron with inspectors attached
//   pnpm debug -- --break      same, but pause the Electron main process on its first line
//   pnpm debug:core            build and run only the core on a fixed port, for API or Rust debugging
//
// Options: --skip-core-build, --core-port <n> (core-only, default 47800).
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = join(root, "crates", "gitcrest-core", "Cargo.toml");
const coreExecutable = join(root, "crates", "gitcrest-core", "target", "debug", process.platform === "win32" ? "gitcrest-core.exe" : "gitcrest-core");
const electronVite = join(root, "node_modules", "electron-vite", "bin", "electron-vite.js");

const MAIN_INSPECT_PORT = 9229;
const RENDERER_DEBUG_PORT = 9222;
const RENDERER_ORIGIN = "http://localhost:5173";

const args = process.argv.slice(2);
const coreOnly = args.includes("--core-only");
const skipCoreBuild = args.includes("--skip-core-build");
const breakOnStart = args.includes("--break");
const corePortIndex = args.indexOf("--core-port");
const corePort = corePortIndex >= 0 ? Number(args[corePortIndex + 1]) : 47800;
if (!Number.isInteger(corePort) || corePort <= 0 || corePort > 65_535) {
  fail(`--core-port needs a port number, got "${args[corePortIndex + 1] ?? ""}".`);
}

const debugEnv = { ...process.env, RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "1" };
// Ctrl+C reaches the children through the shared terminal; wait for them to shut down cleanly.
process.on("SIGINT", () => {});

if (!skipCoreBuild) {
  log("Building gitcrest-core (debug)…");
  const code = await run("cargo", ["build", "--manifest-path", manifestPath], debugEnv);
  if (code !== 0) fail(`cargo build failed with exit code ${code}.`);
}
if (!existsSync(coreExecutable)) fail(`No core binary at ${coreExecutable}. Run without --skip-core-build.`);

if (coreOnly) {
  const databaseDirectory = join(tmpdir(), "gitcrest-debug");
  await mkdir(databaseDirectory, { recursive: true });
  const databasePath = process.env.GITCREST_DATABASE_PATH ?? join(databaseDirectory, "gitcrest.sqlite");
  const token = "debug-token";
  log([
    "Starting gitcrest-core alone. Press Ctrl+C to stop.",
    `  API        http://127.0.0.1:${corePort}`,
    `  Token      ${token}   (read-write; local debugging only)`,
    `  Database   ${databasePath}`,
    `  Try        curl -H "Authorization: Bearer ${token}" http://127.0.0.1:${corePort}/api/version`,
    "  Debugger   attach to the gitcrest-core process (see .vscode/launch.json)",
  ].join("\n"));
  // The core shuts down when its stdin closes, so give it a pipe owned by this launcher: it stops with us.
  const code = await run(coreExecutable, [], {
    ...debugEnv,
    GITCREST_HOST: "127.0.0.1",
    GITCREST_PORT: String(corePort),
    GITCREST_DATABASE_PATH: databasePath,
    GITCREST_AUTH_TOKEN: token,
    GITCREST_READONLY_TOKEN: `${token}-readonly`,
    GITCREST_CONFLICT_TOKEN: `${token}-conflict`,
    GITCREST_CORS_ORIGIN: RENDERER_ORIGIN,
  }, ["pipe", "inherit", "inherit"]);
  process.exit(code);
}

log([
  "Starting GitCrest with debuggers enabled. Press Ctrl+C to stop.",
  `  Main process   Node inspector on 127.0.0.1:${MAIN_INSPECT_PORT}${breakOnStart ? " (paused on first line)" : ""}`,
  `  Renderer       DevTools targets at http://localhost:${RENDERER_DEBUG_PORT}`,
  "  Core           output is prefixed with [gitcrest-core]; Rust changes need a restart",
  "  Attach         VS Code: Run and Debug > \"Attach: Electron main + renderer\"",
].join("\n"));
const code = await run(process.execPath, [
  electronVite,
  "dev",
  "--watch",
  "--sourcemap",
  `--${breakOnStart ? "inspectBrk" : "inspect"}=${MAIN_INSPECT_PORT}`,
  `--remoteDebuggingPort=${RENDERER_DEBUG_PORT}`,
], debugEnv);
process.exit(code);

function run(command, commandArgs, env, stdio = "inherit") {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, { cwd: root, env, stdio });
    child.on("error", (error) => fail(`Could not start ${command}: ${error.message}`));
    child.on("exit", (exitCode, signal) => resolvePromise(exitCode ?? (signal ? 1 : 0)));
  });
}

function log(message) {
  console.log(`\n[debug] ${message.replaceAll("\n", "\n[debug] ")}\n`);
}

function fail(message) {
  console.error(`[debug] ${message}`);
  process.exit(1);
}
