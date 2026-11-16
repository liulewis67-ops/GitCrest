import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), terminate: vi.fn() }));
vi.mock("../../electron/main/sidecar-termination", () => ({ terminateSidecar: mocks.terminate }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("electron", () => ({ app: {
  isPackaged: false, getAppPath: () => "/application", getPath: () => "/data",
} }));

import { onSidecarIdleRecovery, onSidecarUnexpectedExit, startSidecar, stopSidecar } from "../../electron/main/sidecar";

function processFixture() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    exitCode: null, signalCode: null,
  });
}

it("shares shutdown and holds a requested restart until the previous core exits", async () => {
  const first = processFixture();
  const second = processFixture();
  mocks.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  const initial = startSidecar();
  first.stdout.write('{"event":"ready","host":"127.0.0.1","port":10101}\n');
  await initial;
  const stop = stopSidecar();
  expect(stopSidecar()).toBe(stop);
  const restart = startSidecar();
  await Promise.resolve();
  expect(mocks.spawn).toHaveBeenCalledTimes(1);
  expect(first.stdin.writableEnded).toBe(true);
  first.emit("exit", 0, null);
  await stop;
  await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(2));
  second.stdout.write('{"event":"ready","host":"127.0.0.1","port":10102}\n');
  expect((await restart).baseUrl).toBe("http://127.0.0.1:10102");
  const finalStop = stopSidecar();
  second.emit("exit", 0, null);
  await finalStop;
  expect(first.kill).not.toHaveBeenCalled();
  expect(second.kill).not.toHaveBeenCalled();
});

it("notifies a startup timeout through stdin and waits for exit before rejecting", async () => {
  vi.useFakeTimers();
  const core = processFixture();
  mocks.spawn.mockReturnValueOnce(core);
  try {
    let settled = false;
    const startup = startSidecar().then(
      () => { settled = true; return "unexpected ready"; },
      (error: Error) => { settled = true; return error.message; },
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(core.stdin.writableEnded).toBe(true);
    expect(core.kill).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    core.stdout.write('{"event":"ready","host":"127.0.0.1","port":10103}\n');
    await Promise.resolve();
    expect(settled).toBe(false);
    core.emit("exit", 0, null);
    expect(await startup).toContain("did not become ready within 10 seconds");
    expect(core.kill).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("ignores late readiness while an explicit close interrupts startup", async () => {
  const core = processFixture();
  mocks.spawn.mockReturnValueOnce(core);
  let ready = false;
  const starting = startSidecar().then(() => { ready = true; }, () => {});
  const closing = stopSidecar();
  core.stdout.write('{"event":"ready","host":"127.0.0.1","port":10104}\n');
  await Promise.resolve();
  expect(ready).toBe(false);
  core.emit("exit", 0, null);
  core.emit("close", 0, null);
  await Promise.all([closing, starting]);
  expect(ready).toBe(false);
});

it("reports an idle recovery acknowledgment before an exit even when stdout arrives late", async () => {
  const core = processFixture();
  mocks.spawn.mockReturnValueOnce(core);
  const events: string[] = [];
  onSidecarIdleRecovery(() => events.push("accepted"));
  onSidecarUnexpectedExit((_message, clean) => events.push(clean ? "clean" : "unclean"));
  const starting = startSidecar();
  core.stdout.write('{"event":"ready","host":"127.0.0.1","port":10106}\n');
  await starting;
  core.emit("exit", 0, null);
  core.stdout.write('{"event":"idleRecoveryAccepted"}\n');
  core.emit("close", 0, null);
  expect(events).toEqual(["accepted", "clean"]);
});

it("waits for both forced tree termination and core exit after the deadline", async () => {
  vi.useFakeTimers();
  const core = processFixture();
  mocks.spawn.mockReturnValueOnce(core);
  let completeTermination!: () => void;
  mocks.terminate.mockReturnValueOnce(new Promise<void>((resolve) => { completeTermination = resolve; }));
  try {
    const starting = startSidecar();
    core.stdout.write('{"event":"ready","host":"127.0.0.1","port":10105}\n');
    await starting;
    let closed = false;
    const closing = stopSidecar().then(() => { closed = true; });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.terminate).toHaveBeenCalledWith(core);
    expect(closed).toBe(false);
    core.emit("exit", 1, null);
    await Promise.resolve();
    expect(closed).toBe(false);
    completeTermination();
    await closing;
    expect(closed).toBe(true);
  } finally { vi.useRealTimers(); }
});
