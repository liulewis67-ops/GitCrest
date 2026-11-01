import { afterEach, expect, it, vi } from "vitest";
import { requireConflictTaskContext, TaskCenterHandoffs } from "../../electron/main/task-center-handoff";

afterEach(() => vi.useRealTimers());
const context = { repoId: "repo-example", taskId: "task-1-1" };
it("requires a registered conflict capability and returns only its authoritative context", () => {
  for (const access of [undefined, "readOnly", "readWrite"]) expect(() => requireConflictTaskContext(access, context)).toThrow();
  expect(() => requireConflictTaskContext("conflictResolution", undefined)).toThrow();
  expect(requireConflictTaskContext("conflictResolution", context)).toEqual(context);
});
it("keeps requests until the receiving renderer acknowledges them", async () => {
  const handoffs = new TaskCenterHandoffs();
  const result = handoffs.request(10, context);
  const [target] = handoffs.take(20);
  expect(target).toMatchObject(context);
  expect(handoffs.acknowledge(30, target.requestId)).toBe(false);
  expect(handoffs.take(20)).toEqual([target]);
  expect(handoffs.acknowledge(20, target.requestId)).toBe(true);
  expect(await result).toEqual({ ok: true });
  expect(handoffs.take(20)).toEqual([]);
});
it("rebinds pending delivery after a main renderer is recreated", async () => {
  const handoffs = new TaskCenterHandoffs();
  const result = handoffs.request(10, context);
  const [target] = handoffs.take(20);
  handoffs.take(21);
  expect(handoffs.acknowledge(20, target.requestId)).toBe(false);
  handoffs.acknowledge(21, target.requestId);
  expect(await result).toEqual({ ok: true });
});
it("deduplicates one source and serves separate windows in order", async () => {
  const handoffs = new TaskCenterHandoffs();
  const first = handoffs.request(10, context);
  expect(handoffs.request(10, context)).toBe(first);
  const second = handoffs.request(11, { ...context, taskId: "task-2-2" });
  const [target] = handoffs.take(20);
  handoffs.acknowledge(20, target.requestId);
  const [next] = handoffs.take(20);
  expect(next.taskId).toBe("task-2-2");
  handoffs.acknowledge(20, next.requestId);
  expect(await first).toEqual({ ok: true });
  expect(await second).toEqual({ ok: true });
});
it("returns a retryable failure on timeout or source closure", async () => {
  vi.useFakeTimers();
  const handoffs = new TaskCenterHandoffs(100);
  const timed = handoffs.request(10, context);
  await vi.advanceTimersByTimeAsync(100);
  expect(await timed).toMatchObject({ ok: false });
  const closed = handoffs.request(10, context);
  handoffs.cancelSource(10);
  expect(await closed).toMatchObject({ ok: false });
  expect(handoffs.take(20)).toEqual([]);
});
