// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { CoreHealthMonitor } from "../../electron/main/core-health";

afterEach(() => vi.useRealTimers());

it("requires consecutive failures and reports recovery for the same core", async () => {
  vi.useFakeTimers();
  const report = vi.fn();
  const request = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockRejectedValueOnce(new Error("connection unavailable"))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const monitor = new CoreHealthMonitor(report, request);
  monitor.start("http://127.0.0.1:4567", 1);
  await vi.advanceTimersByTimeAsync(75_000);
  expect(report.mock.calls.map(([result]) => [result.generation, result.failures, result.recovered])).toEqual([
    [1, 1, false], [1, 1, false], [1, 2, false], [1, 3, false], [1, 0, true],
  ]);
  monitor.stop();
});

it("aborts timed-out probes and ignores replies from a replaced core", async () => {
  vi.useFakeTimers();
  const report = vi.fn();
  const request = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener("abort", () => reject(options.signal?.reason));
  }));
  const monitor = new CoreHealthMonitor(report, request);
  monitor.start("http://127.0.0.1:4567", 1);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ generation: 1, failures: 1 }));

  await vi.advanceTimersByTimeAsync(15_000);
  monitor.start("http://127.0.0.1:4568", 2, true);
  request.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(report).toHaveBeenCalledTimes(2);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ generation: 2, failures: 0, recovered: true }));
  monitor.stop();
});
