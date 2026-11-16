// @vitest-environment node
import { expect, it, vi } from "vitest";
import { UpdateController, type UpdateEventSource } from "../../electron/main/update-controller";

function makeUpdater() {
  const listeners = new Map<string, (payload?: unknown) => void>();
  const updater: UpdateEventSource = {
    on(event, listener) { listeners.set(event, listener); return this; },
    checkForUpdates: vi.fn().mockResolvedValue({}),
    quitAndInstall: vi.fn(),
  };
  return { updater, emit: (event: string, payload?: unknown) => listeners.get(event)?.(payload) };
}

it("does not check or install when a packaged build has no update feed", async () => {
  const { updater } = makeUpdater();
  const controller = new UpdateController(false, updater, vi.fn());

  expect(controller.getStatus()).toEqual({ state: "notConfigured" });
  await expect(controller.checkForUpdates()).resolves.toEqual({ state: "notConfigured" });
  expect(controller.installDownloadedUpdate()).toBe(false);
  expect(updater.checkForUpdates).not.toHaveBeenCalled();
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});

it("publishes update availability and progress, then installs only a downloaded update", async () => {
  const { updater, emit } = makeUpdater();
  const onStatus = vi.fn();
  const controller = new UpdateController(true, updater, onStatus);

  await controller.checkForUpdates();
  expect(controller.getStatus()).toEqual({ state: "checking" });
  emit("update-available", { version: "0.2.0" });
  emit("download-progress", { percent: 42.5 });
  expect(controller.getStatus()).toEqual({ state: "downloading", version: "0.2.0", percent: 42.5 });
  expect(controller.installDownloadedUpdate()).toBe(false);

  emit("update-downloaded", { version: "0.2.0" });
  expect(controller.getStatus()).toEqual({ state: "downloaded", version: "0.2.0" });
  expect(controller.installDownloadedUpdate()).toBe(true);
  expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(onStatus).toHaveBeenCalledWith({ state: "downloaded", version: "0.2.0" });
});

it("returns to idle if the updater is inactive, as in an unpacked AppImage", async () => {
  const { updater } = makeUpdater();
  vi.mocked(updater.checkForUpdates).mockResolvedValue(null);
  const controller = new UpdateController(true, updater, vi.fn());

  await expect(controller.checkForUpdates()).resolves.toEqual({ state: "idle" });
});

it("reports a rejected background download and allows another check", async () => {
  const { updater } = makeUpdater();
  vi.mocked(updater.checkForUpdates).mockImplementationOnce(async () => ({
    downloadPromise: Promise.reject(new Error("Download interrupted")),
  }));
  const controller = new UpdateController(true, updater, vi.fn());

  await expect(controller.checkForUpdates()).resolves.toMatchObject({ state: "error" });
  await controller.checkForUpdates();
  expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
});

it("does not expose updater error details that may contain feed credentials", async () => {
  const { updater, emit } = makeUpdater();
  const controller = new UpdateController(true, updater, vi.fn());

  emit("error", new Error("https://updates.example.test?token=secret"));
  expect(controller.getStatus()).toEqual({ state: "error", message: "The update check failed. Try again later." });
});

it("refuses installation after the updater reports a signature verification failure", async () => {
  const { updater, emit } = makeUpdater();
  const controller = new UpdateController(true, updater, vi.fn());

  emit("update-available", { version: "0.2.0" });
  emit("error", new Error("ERR_UPDATER_INVALID_SIGNATURE"));

  expect(controller.getStatus()).toEqual({ state: "error", message: "The update check failed. Try again later." });
  expect(controller.installDownloadedUpdate()).toBe(false);
  expect(updater.quitAndInstall).not.toHaveBeenCalled();
});
