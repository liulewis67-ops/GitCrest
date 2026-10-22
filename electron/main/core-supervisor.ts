/**
 * Decides whether a core that exited unexpectedly is started again. A core that keeps failing is
 * left stopped once it has been restarted `maxRestarts` times within `windowMs`, so a broken
 * install or database does not spin forever; the user can still ask for a restart.
 */
export class CoreRestartPolicy {
  private readonly restartTimes: number[] = [];

  constructor(
    private readonly maxRestarts = 3,
    private readonly windowMs = 60_000,
    private readonly baseDelayMs = 500,
  ) {}

  /** Records one unexpected exit. Returns the delay before the next start, or undefined to stop. */
  nextRestartDelay(now: number): number | undefined {
    while (this.restartTimes.length > 0 && now - this.restartTimes[0] > this.windowMs) this.restartTimes.shift();
    if (this.restartTimes.length >= this.maxRestarts) return undefined;
    this.restartTimes.push(now);
    return this.baseDelayMs * 2 ** (this.restartTimes.length - 1);
  }

  /** A restart the user asked for starts a fresh budget. */
  reset(): void {
    this.restartTimes.length = 0;
  }
}

/** Keeps the last lines a process wrote, so a startup failure can say why instead of only its exit code. */
export class OutputTail {
  private lines: string[] = [];
  private partial = "";

  constructor(private readonly maxLines = 12, private readonly maxLineLength = 400) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n/);
    this.partial = parts.pop() ?? "";
    for (const line of parts) this.append(line);
    if (this.partial.length > this.maxLineLength) {
      this.append(this.partial);
      this.partial = "";
    }
  }

  text(): string {
    return [...this.lines, ...(this.partial.trim() ? [this.partial.trim()] : [])].join("\n");
  }

  private append(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.lines.push(trimmed.length > this.maxLineLength ? `${trimmed.slice(0, this.maxLineLength)}…` : trimmed);
    if (this.lines.length > this.maxLines) this.lines.shift();
  }
}

/** Appends the core's last output to an error message when there is any. */
export function withCoreOutput(message: string, output: string): string {
  return output ? `${message}\n\n${output}` : message;
}
