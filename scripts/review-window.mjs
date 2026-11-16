import { _electron as electron, chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Release review emulation without reloading or changing the user's zoom or renderer state. */
export async function resetReviewViewport(page) {
  const session = await page.context().newCDPSession(page);
  try {
    // Emulation belongs to its CDP session. A fresh session's clear alone cannot undo
    // an override orphaned by another client. Claim it with native/default metrics first.
    await session.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 0, mobile: false });
    await session.send("Emulation.clearDeviceMetricsOverride");
    // Let the native resize reach layout before callers snapshot the restored dimensions.
    await page.evaluate(() => new Promise((resolve) => {
      const deadline = setTimeout(resolve, 100);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(deadline); resolve(); }));
    }));
  } finally {
    await session.detach();
  }
}

/** Resize the actual Electron content area, so the visible desktop window and CSS viewport agree. */
export async function setReviewWindowSize(application, page, { width, height }) {
  await resetReviewViewport(page);
  const window = await application.browserWindow(page);
  let minimumSize;
  try {
    minimumSize = await window.evaluate((nativeWindow, size) => {
      const zoom = nativeWindow.webContents.getZoomFactor();
      const target = [Math.round(size.width * zoom), Math.round(size.height * zoom)];
      const minimum = nativeWindow.getMinimumSize();
      // At fractional Windows scaling, the native minimum can clamp a request for that
      // exact CSS size above the target. Make room for rounding during this resize only.
      const adjustedMinimum = minimum.map((value, index) =>
        process.platform === "win32" && target[index] === value ? Math.max(0, value - 2) : value);
      if (adjustedMinimum.some((value, index) => value !== minimum[index])) {
        nativeWindow.setMinimumSize(...adjustedMinimum);
        return minimum;
      }
      return undefined;
    }, { width, height });
    await window.evaluate((nativeWindow, size) => {
      const zoom = nativeWindow.webContents.getZoomFactor();
      nativeWindow.setContentSize(Math.round(size.width * zoom), Math.round(size.height * zoom));
    }, { width, height });
    // Windows can round frameless secondary-window content bounds differently at
    // fractional display scaling. Correct against the actual CSS viewport.
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      if (actual.width === width && actual.height === height) break;
      await window.evaluate((nativeWindow, delta) => {
        const bounds = nativeWindow.getBounds();
        const zoom = nativeWindow.webContents.getZoomFactor();
        nativeWindow.setBounds({ ...bounds, width: bounds.width + Math.round(delta.width * zoom), height: bounds.height + Math.round(delta.height * zoom) });
      }, { width: width - actual.width, height: height - actual.height });
    }
    try {
      await page.waitForFunction(({ width, height }) => Math.abs(innerWidth - width) <= 1 && Math.abs(innerHeight - height) <= 1, { width, height });
    } catch (error) {
      const native = await window.evaluate((nativeWindow) => ({ bounds: nativeWindow.getBounds(), content: nativeWindow.getContentSize(), zoom: nativeWindow.webContents.getZoomFactor(), maximized: nativeWindow.isMaximized() }));
      const viewport = await page.evaluate(() => [innerWidth, innerHeight]);
      throw new Error(`Review resize to ${width}x${height} failed: ${JSON.stringify({ native, viewport })}`, { cause: error });
    }
  } finally {
    try {
      if (minimumSize) {
        await window.evaluate((nativeWindow, minimum) => nativeWindow.setMinimumSize(...minimum), minimumSize);
      }
    } finally {
      await window.dispose();
    }
  }
}

/** Native-size previews always return the window to its prior bounds, including when a check throws. */
export async function withReviewWindowSize(application, page, size, action) {
  const window = await application.browserWindow(page);
  try {
    const original = await window.evaluate((nativeWindow) => ({
      bounds: nativeWindow.getBounds(),
      content: nativeWindow.getContentSize(),
    }));
    try {
      await setReviewWindowSize(application, page, size);
      return await action();
    } finally {
      try {
        await resetReviewViewport(page);
      } finally {
        await window.evaluate((nativeWindow, original) => {
          nativeWindow.setBounds(original.bounds);
          // Native bounds alone can restore a different content height at fractional scaling.
          if (nativeWindow.getContentSize().some((value, index) => value !== original.content[index])) {
            nativeWindow.setContentSize(...original.content);
          }
        }, original);
      }
    }
  } finally {
    await window.dispose();
  }
}

/** Review captures use their own profile/database and close only the app they created. */
export async function withReviewApp(action) {
  const root = await mkdtemp(join(tmpdir(), "gitcrest-review-app-"));
  let application;
  try {
    application = await electron.launch({
      args: [".", "--lang=en-US", "--disable-gpu", `--user-data-dir=${join(root, "profile")}`],
      env: { ...process.env, ELECTRON_RENDERER_URL: "", GITCREST_DATABASE_PATH: join(root, "review.sqlite") },
    });
    const page = await application.firstWindow();
    await page.locator(".connectionBadge.connected").waitFor({ timeout: 40_000 });
    return await action(application, page);
  } finally {
    try { await application?.close(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
  }
}

/** Repair an already-running debug app without closing it or changing its route/data. */
export async function repairReviewWindows(endpoint) {
  const browser = await chromium.connectOverCDP(endpoint);
  let count = 0;
  try {
    for (const page of browser.contexts().flatMap((context) => context.pages())) {
      if (!await page.evaluate(() => Boolean(window.gitcrest?.getSidecarConnection)).catch(() => false)) continue;
      await resetReviewViewport(page);
      count++;
    }
    if (!count) throw new Error("No GitCrest renderer found at the supplied CDP endpoint.");
    return count;
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv.includes("--reset")) throw new Error("Usage: node scripts/review-window.mjs --reset [--cdp http://127.0.0.1:9222]");
  const index = process.argv.indexOf("--cdp");
  const count = await repairReviewWindows(index < 0 ? "http://127.0.0.1:9222" : process.argv[index + 1]);
  console.log(`Restored native viewport sizing for ${count} GitCrest window(s).`);
}
