import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createTempGitRepository(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "gitcrest-e2e-"));
  try {
    await execFileAsync("git", ["init", "--quiet", path]);
    await execFileAsync("git", ["-C", path, "config", "user.name", "GitCrest Test"]);
    await execFileAsync("git", ["-C", path, "config", "user.email", "gitcrest-test@example.invalid"]);
    await execFileAsync("git", ["-C", path, "rev-parse", "--show-toplevel"]);
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }

  return {
    path,
    cleanup: () => rm(path, { recursive: true, force: true }),
  };
}
