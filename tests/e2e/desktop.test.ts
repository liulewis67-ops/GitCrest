import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
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
        () => document.body.innerText.includes("Core connected") || document.body.innerText.includes("Connecting to engine"),
        undefined,
        { timeout: 15_000 },
      );
      const body = await window.locator("body").innerText();
      expect(body).toContain("Core connected");
      expect(body).toContain("gitcrest-core 0.1.0 (API v1)");
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

      await window.getByRole("button", { name: "Workspace", exact: true }).click();
      await window.setViewportSize({ width: 900, height: 820 });
      expect(await window.locator(".navigationPanel").isVisible()).toBe(false);
      expect(await window.locator(".mainPanel").isVisible()).toBe(true);
      expect(await window.locator(".commitSection").isVisible()).toBe(false);
      await window.setViewportSize({ width: 1280, height: 820 });

      if (process.env.GITCREST_CAPTURE_E2E === "1") {
        const evidencePath = resolve("doc/evidence/S0.4");
        await mkdir(evidencePath, { recursive: true });
        await window.getByRole("button", { name: "Welcome", exact: true }).click();
        await window.screenshot({ path: resolve(evidencePath, "welcome.png") });
        const themeButton = window.getByRole("button", { name: /Color theme:/ });
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if ((await themeButton.getAttribute("aria-label"))?.includes("dark")) break;
          await themeButton.click();
        }
        await window.screenshot({ path: resolve(evidencePath, "welcome-dark.png") });
        await window.getByRole("button", { name: "Workspace", exact: true }).click();
        await window.screenshot({ path: resolve(evidencePath, "workspace-dark.png") });
        await themeButton.click();
        await window.screenshot({ path: resolve(evidencePath, "workspace-light.png") });
      }
    } finally {
      await app?.close();
      app = undefined;
      await fixture.cleanup();
    }
  });
});
