import { expect, it } from "vitest";
import { resetReviewViewport, setReviewWindowSize, withReviewApp, withReviewWindowSize } from "../../scripts/review-window.mjs";

it("repairs emulation left by a detached review client without losing page state or zoom", async () => {
  await withReviewApp(async (application, page) => {
    await page.evaluate(() => { localStorage.setItem("review-window-sentinel", "preserved"); window.gitcrest?.setZoomFactor?.(0.9); });
    await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBe(0.9);
    const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, url: location.href }));
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setDeviceMetricsOverride", { width: 960, height: 700, deviceScaleFactor: 1, mobile: false });
    await expect.poll(() => page.evaluate(() => Math.abs(innerWidth * 0.9 - 960))).toBeLessThan(1);
    await session.detach();
    await resetReviewViewport(page);
    await expect.poll(() => page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, url: location.href })), { timeout: 3000 }).toEqual(original);
    expect(await page.evaluate(() => localStorage.getItem("review-window-sentinel"))).toBe("preserved");
    const nativeHandle = await application.browserWindow(page);
    await nativeHandle.evaluate((nativeWindow) => nativeWindow.setContentSize(1100, 740));
    await expect.poll(() => page.evaluate(() => Math.abs(innerWidth * 0.9 - 1100) < 1 && Math.abs(innerHeight * 0.9 - 740) < 1)).toBe(true);
    await nativeHandle.dispose();
  });
}, 60_000);

it("sizes a frameless secondary window using its rendered viewport", async () => {
  await withReviewApp(async (application, page) => {
    const opened = application.waitForEvent("window");
    await application.evaluate(async ({ BrowserWindow }, url) => {
      const secondary = new BrowserWindow({ x: 176, y: 16, width: 1180, height: 780, frame: false });
      await secondary.loadURL(url);
    }, page.url());
    const secondary = await opened;
    await secondary.waitForLoadState();
    for (const size of [{ width: 1280, height: 816 }, { width: 960, height: 700 }]) {
      await setReviewWindowSize(application, secondary, size);
      expect(await secondary.evaluate(() => ({ width: innerWidth, height: innerHeight }))).toEqual(size);
    }
    await secondary.close();
  });
}, 60_000);

it("previews at the native window size and restores the full window even after a failed capture", async () => {
  await withReviewApp(async (application, page) => {
    const nativeHandle = await application.browserWindow(page);
    const original = await nativeHandle.evaluate((nativeWindow) => nativeWindow.getBounds());
    const minimum = await nativeHandle.evaluate((nativeWindow) => nativeWindow.getMinimumSize());
    const originalContent = await nativeHandle.evaluate((nativeWindow) => nativeWindow.getContentSize());
    const originalViewport = await page.evaluate(() => [innerWidth, innerHeight]);
    await expect(withReviewWindowSize(application, page, { width: 960, height: 700 }, async () => {
      expect(await nativeHandle.evaluate((nativeWindow) => nativeWindow.getMinimumSize())).toEqual(minimum);
      expect(await nativeHandle.evaluate((nativeWindow) => nativeWindow.getContentSize())).toEqual([960, 700]);
      expect(await page.evaluate(() => [innerWidth, innerHeight])).toEqual([960, 700]);
      expect(await page.locator(".appShell").evaluate((node) => [node.getBoundingClientRect().width, node.getBoundingClientRect().height])).toEqual([960, 700]);
      throw new Error("capture failed");
    })).rejects.toThrow("capture failed");
    await expect.poll(() => nativeHandle.evaluate((nativeWindow) => nativeWindow.getBounds())).toEqual(original);
    expect(await nativeHandle.evaluate((nativeWindow) => nativeWindow.getMinimumSize())).toEqual(minimum);
    expect(await nativeHandle.evaluate((nativeWindow) => nativeWindow.getContentSize())).toEqual(originalContent);
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(originalViewport);
    await nativeHandle.dispose();
  });
}, 60_000);
