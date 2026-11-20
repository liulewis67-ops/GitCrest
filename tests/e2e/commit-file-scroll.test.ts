import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication } from "playwright";
import { expect, it } from "vitest";

const run = promisify(execFile);

it("keeps scrolled commit files covered up to the sticky group header's top edge", async () => {
  const root = await mkdtemp(join(tmpdir(), "gitcrest-commit-scroll-"));
  const repository = join(root, "repository");
  let app: ElectronApplication | undefined;
  try {
    await mkdir(repository);
    const git = (...args: string[]) => run("git", ["-C", repository, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]);
    await git("init", "--quiet");
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(repository, `file-${index}.txt`), "before\n")));
    await git("add", ".");
    await git("commit", "--quiet", "-m", "seed");
    await Promise.all(Array.from({ length: 40 }, (_, index) => writeFile(join(repository, `file-${index}.txt`), "after\n")));
    app = await electron.launch({ args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(root, "profile")}`], env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(root, "gitcrest.sqlite") } });
    const page = await app.firstWindow();
    await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    await page.evaluate(() => localStorage.setItem("gitcrest-locale", "en"));
    await page.reload();
    await app.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, repository);
    await page.getByRole("button", { name: /^Open local repository/ }).click();
    await page.locator(".changeTreeRow").nth(39).waitFor({ state: "attached" });
    for (const theme of ["light", "dark"]) {
      await page.evaluate((mode) => localStorage.setItem("gitcrest-appearance-v1", JSON.stringify({ mode })), theme);
      await page.reload();
      const tree = page.locator(".changeTree");
      await page.locator(".changeTreeRow").nth(39).waitFor({ state: "attached" });
      for (const scrollTop of [95, 214, 415]) {
        await tree.evaluate((node, top) => { node.scrollTop = top; }, scrollTop);
        const metrics = await tree.evaluate((node) => {
          const tree = node.getBoundingClientRect();
          const header = node.querySelector<HTMLElement>(".changeTreeGroupRow")!;
          const box = header.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const topHit = document.elementFromPoint(x, tree.top + 1);
          return { scrollTop: node.scrollTop, gap: box.top - tree.top, topCovered: !!topHit && header.contains(topHit) };
        });
        await page.screenshot({ path: join(tmpdir(), `gitcrest-commit-scroll-${theme}.png`) });
        expect(Math.abs(metrics.scrollTop - scrollTop)).toBeLessThan(1);
        expect(metrics.gap, `${theme} at ${scrollTop}: file rows must not peek above the sticky header`).toBeLessThanOrEqual(0.5);
        expect(metrics.topCovered).toBe(true);
      }
    }
  } finally {
    await app?.close();
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("gitcrest-commit-scroll-")) throw new Error("Unexpected scroll test directory");
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90_000);
