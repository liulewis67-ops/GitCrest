export interface CoreHealthResult {
  generation: number;
  elapsedMs: number;
  failures: number;
  recovered: boolean;
}

const INTERVAL_MS = 15_000;
const TIMEOUT_MS = 2_000;
export const CORE_UNRESPONSIVE_THRESHOLD = 3;

export class CoreHealthMonitor {
  private stopMonitoring?: () => void;

  constructor(
    private readonly report: (result: CoreHealthResult) => void,
    private readonly request: typeof fetch = fetch,
  ) {}

  start(baseUrl: string, generation: number, previouslyUnresponsive = false): void {
    this.stop();
    const endpoint = new URL("/health", baseUrl);
    let failures = 0;
    let unresponsive = previouslyUnresponsive;
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    let active: AbortController | undefined;

    const probe = async (): Promise<void> => {
      const controller = new AbortController();
      active = controller;
      const started = performance.now();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let healthy = false;
      try {
        const response = await this.request(endpoint, { signal: controller.signal, redirect: "error", cache: "no-store" });
        healthy = response.status === 204 && !controller.signal.aborted;
        if (response.body) void response.body.cancel().catch(() => undefined);
      } catch {
        // The elapsed time and failure count are enough for local diagnostics.
      } finally {
        clearTimeout(timeout);
        active = undefined;
      }
      if (stopped) return;

      const recovered = healthy && unresponsive;
      failures = healthy ? 0 : failures + 1;
      unresponsive = !healthy && (unresponsive || failures >= CORE_UNRESPONSIVE_THRESHOLD);
      timer = setTimeout(() => void probe(), INTERVAL_MS);
      if (!healthy || recovered) {
        this.report({ generation, elapsedMs: Math.round(performance.now() - started), failures, recovered });
      }
    };

    timer = setTimeout(() => void probe(), 0);
    this.stopMonitoring = () => {
      stopped = true;
      clearTimeout(timer);
      active?.abort();
    };
  }

  stop(): void {
    this.stopMonitoring?.();
    this.stopMonitoring = undefined;
  }
}
