import type { UpdateStatus } from "../../src/api/update-status";

export type { UpdateStatus } from "../../src/api/update-status";

type UpdateInfo = { version?: unknown };
type DownloadProgress = { percent?: unknown };

export interface UpdateEventSource {
  on(event: string, listener: (payload?: unknown) => void): this;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export class UpdateController {
  private status: UpdateStatus;
  private checkPending = false;

  constructor(
    private readonly configured: boolean,
    private readonly updater: UpdateEventSource,
    private readonly onStatus: (status: UpdateStatus) => void,
  ) {
    this.status = configured ? { state: "idle" } : { state: "notConfigured" };
    if (!configured) return;

    updater.on("checking-for-update", () => this.publish({ state: "checking" }));
    updater.on("update-available", (value) => this.publish({ state: "available", version: readVersion(value) }));
    updater.on("update-not-available", () => this.publish({ state: "notAvailable" }));
    updater.on("download-progress", (value) => this.publish({
      state: "downloading",
      version: this.status.state === "available" || this.status.state === "downloading" ? this.status.version : undefined,
      percent: readPercent(value),
    }));
    updater.on("update-downloaded", (value) => this.publish({ state: "downloaded", version: readVersion(value) }));
    updater.on("error", () => this.publish({ state: "error", message: "The update check failed. Try again later." }));
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  async checkForUpdates(): Promise<UpdateStatus> {
    if (!this.configured || this.checkPending || this.status.state === "downloading" || this.status.state === "downloaded") {
      return this.status;
    }
    this.checkPending = true;
    this.publish({ state: "checking" });
    try {
      await this.updater.checkForUpdates();
    } catch {
      this.publish({ state: "error", message: "The update check failed. Try again later." });
    } finally {
      this.checkPending = false;
    }
    return this.status;
  }

  installDownloadedUpdate(): boolean {
    if (!this.configured || this.status.state !== "downloaded") return false;
    this.updater.quitAndInstall(false, true);
    return true;
  }

  private publish(status: UpdateStatus): void {
    this.status = status;
    this.onStatus(status);
  }
}

function readVersion(value: unknown): string {
  if (value && typeof value === "object" && "version" in value && typeof (value as UpdateInfo).version === "string") {
    return (value as { version: string }).version;
  }
  return "unknown";
}

function readPercent(value: unknown): number {
  if (!value || typeof value !== "object" || !("percent" in value)) return 0;
  const percent = Number((value as DownloadProgress).percent);
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, percent));
}
