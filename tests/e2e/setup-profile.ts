import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { afterAll } from "vitest";

/**
 * Every Electron launch without its own `--user-data-dir` would share the default profile with the other tests
 * (local storage, window state, caches, profile locks). Give each such launch a fresh profile instead, so one
 * test can neither leak state into the next nor wait on a profile the previous instance is still releasing.
 */
const profiles: string[] = [];
const launch = _electron.launch.bind(_electron);

/**
 * Right after a reload the app has to reconnect to its core, and the recent-repository rows stay disabled until it
 * has (`disabled={openingRepository || !connected}`). The first load waits up to 40 seconds for "Core connected", but a
 * test that clicked a row straight after `reload()` only waited the default 30, so a slow reconnect read as a flake.
 * Make the main window's `reload()` wait for the same signal. The titlebar's connection badge carries a `connected`
 * class whatever the language (some tests reload in Chinese, where the text differs). A window without the badge is
 * left alone after the wait runs out.
 */
async function waitForCoreConnected(page: Page) {
  await page.locator(".connectionBadge.connected").first().waitFor({ state: "attached", timeout: 40_000 }).catch(() => undefined);
}

function reloadThenWaitForTheCore(app: ElectronApplication): ElectronApplication {
  const firstWindow = app.firstWindow.bind(app);
  const patched = new WeakSet<Page>();
  app.firstWindow = (async (...args: Parameters<typeof firstWindow>) => {
    const page = await firstWindow(...args);
    if (!patched.has(page)) {
      patched.add(page);
      const reload = page.reload.bind(page);
      page.reload = (async (...reloadArgs: Parameters<typeof reload>) => {
        const response = await reload(...reloadArgs);
        await waitForCoreConnected(page);
        return response;
      }) as typeof page.reload;
    }
    return page;
  }) as typeof app.firstWindow;
  return app;
}

Object.defineProperty(_electron, "launch", {
  configurable: true,
  writable: true,
  value: (async (options: Parameters<typeof launch>[0] = {}) => {
    const args = options.args ?? [];
    if (args.some((argument) => argument.startsWith("--user-data-dir="))) return reloadThenWaitForTheCore(await launch(options));
    const profile = mkdtempSync(join(tmpdir(), "gitcrest-e2e-profile-"));
    profiles.push(profile);
    return reloadThenWaitForTheCore(await launch({ ...options, args: [...args, `--user-data-dir=${profile}`] }));
  }) as typeof launch,
});

afterAll(() => {
  for (const profile of profiles) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
