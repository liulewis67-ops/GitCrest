import { _electron as electron, type ElectronApplication } from "playwright";
import { afterEach, describe, expect, it } from "vitest";
import { createTempGitRepository } from "../fixtures/temp-repo";

describe("desktop startup E2E", () => {
  let app: ElectronApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("starts Electron and the authenticated sidecar with a disposable Git fixture", async () => {
    const fixture = await createTempGitRepository();
    try {
      expect(fixture.path).toContain("gitcrest-e2e-");

      app = await electron.launch({
        args: ["."],
        env: { ...process.env, ELECTRON_RENDERER_URL: "" },
      });
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded", { timeout: 10_000 });
      await window.waitForFunction(
        () => !document.body.innerText.includes("Starting local GitCrest core..."),
        undefined,
        { timeout: 15_000 },
      );
      const body = await window.locator("body").innerText();
      expect(body).toContain("Connected to local Rust core");
      expect(body).toContain("gitcrest-core 0.1.0 (API v1)");
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
    }
  });
});
