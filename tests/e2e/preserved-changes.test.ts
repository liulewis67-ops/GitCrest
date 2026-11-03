import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { GitCrestApiClient } from "../../src/api/client";
import { withPreservedChanges } from "../../src/features/shelves/model/with-preserved-changes";
import { createTempGitRepository } from "../fixtures/temp-repo";

const exec = promisify(execFile);

it("retains file contents and the index across repeated branch switches and pulls", async () => {
  const fixture = await createTempGitRepository();
  const appData = await mkdtemp(resolve(tmpdir(), "gitcrest-preservation-"));
  const git = async (...args: string[]) => (await exec("git", ["-C", fixture.path, ...args])).stdout;
  let core: ReturnType<typeof spawn> | undefined;
  try {
    await git("config", "core.autocrlf", "false");
    await writeFile(resolve(fixture.path, "both.txt"), "base\n");
    await writeFile(resolve(fixture.path, "deleted.txt"), "keep in backup\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    const main = (await git("branch", "--show-current")).trim();
    await git("branch", "other");
    const remote = resolve(appData, "origin.git");
    await exec("git", ["init", "--bare", "--quiet", remote]);
    await git("remote", "add", "origin", remote);
    await git("push", "-qu", "origin", main);
    // The upstream advances in another clone so every pull must integrate a commit.
    const upstream = resolve(appData, "upstream");
    await exec("git", ["clone", "-q", "--branch", main, remote, upstream]);
    const upstreamGit = async (...args: string[]) => exec("git", ["-C", upstream, ...args]);
    await upstreamGit("config", "user.name", "Preservation Test");
    await upstreamGit("config", "user.email", "preservation@example.invalid");

    await writeFile(resolve(fixture.path, "both.txt"), "staged edit\n");
    await git("add", "both.txt");
    await writeFile(resolve(fixture.path, "both.txt"), "staged edit\nunstaged edit\n");
    await writeFile(resolve(fixture.path, "new.txt"), "untracked edit\n");
    await rm(resolve(fixture.path, "deleted.txt"));
    const before = {
      index: await git("diff", "--cached", "--binary"),
      working: await git("diff", "--binary"),
      status: await git("status", "--porcelain"),
    };

    const token = crypto.randomUUID();
    core = spawn(resolve("crates/gitcrest-core/target/debug", process.platform === "win32" ? "gitcrest-core.exe" : "gitcrest-core"), [], {
      windowsHide: true,
      env: { ...process.env, GITCREST_HOST: "127.0.0.1", GITCREST_PORT: "0", GITCREST_AUTH_TOKEN: token, GITCREST_DATABASE_PATH: resolve(appData, "test.sqlite") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const child = core;
    const lines = createInterface({ input: child.stdout! });
    const baseUrl = await new Promise<string>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("Core startup timed out")), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Core exited: ${code}`)); });
      lines.on("line", (line) => {
        const message = JSON.parse(line);
        if (message.event === "ready") {
          clearTimeout(timer);
          resolveReady(`http://${message.host}:${message.port}`);
        }
      });
    });
    const api = new GitCrestApiClient(baseUrl, token);
    const repository = await api.openRepository(fixture.path);
    const repoId = repository.repoId;
    const preserve = (run: Parameters<typeof withPreservedChanges>[2]) => withPreservedChanges(api, repoId, run, () => {});
    const verify = async () => {
      expect(await git("diff", "--cached", "--binary")).toBe(before.index);
      expect(await git("diff", "--binary")).toBe(before.working);
      expect(await git("status", "--porcelain")).toBe(before.status);
      expect(await readFile(resolve(fixture.path, "both.txt"), "utf8")).toBe("staged edit\nunstaged edit\n");
      expect(await readFile(resolve(fixture.path, "new.txt"), "utf8")).toBe("untracked edit\n");
      expect(await api.listRepositoryShelves(repoId)).toEqual([]);
    };
    for (let round = 0; round < 3; round++) {
      for (const branch of ["other", main]) {
        await preserve(() => api.switchRepositoryBranch(repoId, branch));
        expect((await git("branch", "--show-current")).trim()).toBe(branch);
        await verify();
      }
      await writeFile(resolve(upstream, "remote.txt"), `remote change ${round}\n`);
      await upstreamGit("add", ".");
      await upstreamGit("commit", "-qm", `upstream ${round}`);
      await upstreamGit("push", "-q");
      await git("fetch", "-q", "origin");
      const preview = await api.preflightRepositoryPull(repoId);
      await preserve(() => api.pullRepository(repoId, {
        expectedLocalOid: preview.localOid, expectedTrackingOid: preview.trackingOid, strategy: "merge",
      }));
      expect(await readFile(resolve(fixture.path, "remote.txt"), "utf8")).toBe(`remote change ${round}\n`);
      await verify();
    }
  } finally {
    if (core && core.exitCode === null) {
      const closed = once(core, "close");
      core.kill();
      await closed;
    }
    await fixture.cleanup();
    await rm(appData, { recursive: true, force: true });
  }
}, 180_000);
