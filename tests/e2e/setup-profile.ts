import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron } from "playwright";
import { afterAll } from "vitest";

/**
 * Every Electron launch without its own `--user-data-dir` would share the default profile with the other tests
 * (local storage, window state, caches, profile locks). Give each such launch a fresh profile instead, so one
 * test can neither leak state into the next nor wait on a profile the previous instance is still releasing.
 */
const profiles: string[] = [];
const launch = _electron.launch.bind(_electron);

Object.defineProperty(_electron, "launch", {
  configurable: true,
  writable: true,
  value: ((options: Parameters<typeof launch>[0] = {}) => {
    const args = options.args ?? [];
    if (args.some((argument) => argument.startsWith("--user-data-dir="))) return launch(options);
    const profile = mkdtempSync(join(tmpdir(), "gitcrest-e2e-profile-"));
    profiles.push(profile);
    return launch({ ...options, args: [...args, `--user-data-dir=${profile}`] });
  }) as typeof launch,
});

afterAll(() => {
  for (const profile of profiles) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
