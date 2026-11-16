import type { UpdateStatus } from "../../src/api/update-status";

export type { UpdateStatus } from "../../src/api/update-status";

type UpdateInfo = { version?: unknown };
type DownloadProgress = { percent?: unknown };

export interface UpdateEventSource {
  on(event: string, listener: (payload?: unknown) => void): this;
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export class UpdateController {
  private status: UpdateStatus;
  private checkPending = false;
  private readonly updater?: UpdateEventSource;

  constructor(
    private readonly configured: boolean,
    updater: UpdateEventSource | undefined,
    private readonly onStatus: (status: UpdateStatus) => void,
  ) {
    this.status = configured ? { state: "idle" } : { state: "notConfigured" };
    if (!configured) return;
    if (!updater) throw new Error("A configured update feed requires an updater runtime.");
    this.updater = updater;

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
    if (!this.configured || !this.updater || this.checkPending || this.status.state === "downloading" || this.status.state === "downloaded") {
      return this.status;
    }
    this.checkPending = true;
    this.publish({ state: "checking" });
    try {
      const result = await this.updater.checkForUpdates();
      if (result === null) this.publish({ state: "idle" });
      else await result.downloadPromise;
    } catch {
      this.publish({ state: "error", message: "The update check failed. Try again later." });
    } finally {
      this.checkPending = false;
    }
    return this.status;
  }

  installDownloadedUpdate(): boolean {
    if (!this.configured || !this.updater || this.status.state !== "downloaded") return false;
    this.updater.quitAndInstall(true, true);
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
