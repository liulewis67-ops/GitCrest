// @vitest-environment node
import { expect, it } from "vitest";
import { CoreRestartPolicy, OutputTail, withCoreOutput } from "../../electron/main/core-supervisor";

it("restarts a crashed core with growing delays and stops after repeated crashes", () => {
  const policy = new CoreRestartPolicy(3, 60_000, 500);

  expect(policy.nextRestartDelay(0)).toBe(500);
  expect(policy.nextRestartDelay(1_000)).toBe(1_000);
  expect(policy.nextRestartDelay(2_000)).toBe(2_000);
  expect(policy.nextRestartDelay(3_000)).toBeUndefined();
});

it("forgets crashes older than its window and starts over after a requested restart", () => {
  const policy = new CoreRestartPolicy(2, 60_000, 500);
  policy.nextRestartDelay(0);
  policy.nextRestartDelay(1_000);
  expect(policy.nextRestartDelay(2_000)).toBeUndefined();

  // Only the crash at 0 has left the window.
  expect(policy.nextRestartDelay(60_500)).toBe(1_000);
  expect(policy.nextRestartDelay(60_600)).toBeUndefined();

  policy.reset();
  expect(policy.nextRestartDelay(60_700)).toBe(500);
});

it("keeps the core's last output lines for a startup error", () => {
  const tail = new OutputTail(2, 20);
  tail.push("first line\nsecond ");
  tail.push("line\r\nthird line\n\npartial");

  expect(tail.text()).toBe("second line\nthird line\npartial");
  expect(withCoreOutput("Rust sidecar exited before ready: code=1", tail.text()))
    .toBe("Rust sidecar exited before ready: code=1\n\nsecond line\nthird line\npartial");
  expect(withCoreOutput("No output", new OutputTail().text())).toBe("No output");
});

it("shortens very long output lines", () => {
  const tail = new OutputTail(4, 10);
  tail.push(`${"x".repeat(25)}\n`);

  expect(tail.text()).toBe(`${"x".repeat(10)}…`);
});
