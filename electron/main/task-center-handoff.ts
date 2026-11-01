export interface TaskCenterTarget { requestId: string; repoId: string; taskId: string }
export type HandoffResult = { ok: true } | { ok: false; reason: string };

export function requireConflictTaskContext(access: string | undefined, context: { repoId: string; taskId: string } | undefined) {
  if (access !== "conflictResolution" || !context) throw new Error("Only a registered conflict window may return to its task.");
  return { repoId: context.repoId, taskId: context.taskId };
}

/** Requests survive renderer startup; only the renderer that took one may acknowledge it. */
export class TaskCenterHandoffs {
  private sequence = 0;
  private requests = new Map<string, { target: TaskCenterTarget; source: number; destination?: number; result: Promise<HandoffResult>; finish: (result: HandoffResult) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor(private timeoutMs = 15_000, private onPending: () => void = () => {}) {}

  request(source: number, context: { repoId: string; taskId: string }): Promise<HandoffResult> {
    const existing = [...this.requests.values()].find((request) => request.source === source);
    if (existing) return existing.result;
    const requestId = `handoff-${++this.sequence}`;
    let finish!: (result: HandoffResult) => void;
    const result = new Promise<HandoffResult>((resolve) => { finish = resolve; });
    const timer = setTimeout(() => this.finish(requestId, { ok: false, reason: "Task Center did not acknowledge the request." }), this.timeoutMs);
    this.requests.set(requestId, { target: { requestId, ...context }, source, result, finish, timer });
    return result;
  }

  take(destination: number): TaskCenterTarget[] {
    return [...this.requests.values()].slice(0, 1).map((request) => { request.destination = destination; return request.target; });
  }

  acknowledge(destination: number, requestId: string): boolean {
    if (this.requests.get(requestId)?.destination !== destination) return false;
    this.finish(requestId, { ok: true });
    return true;
  }

  cancelSource(source: number) {
    for (const [id, request] of this.requests) if (request.source === source) this.finish(id, { ok: false, reason: "Conflict window closed." });
  }

  failAll(reason: string) {
    for (const id of this.requests.keys()) this.finish(id, { ok: false, reason });
  }

  private finish(id: string, result: HandoffResult) {
    const request = this.requests.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.requests.delete(id);
    request.finish(result);
    if (this.requests.size > 0) this.onPending();
  }
}
