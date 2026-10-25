// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestBridge } from "../../src/api/bridge";
import type { CoreStatus } from "../../src/api/core-status";
import { useCoreConnection } from "../../src/app/use-core-connection";

afterEach(() => {
  cleanup();
  delete window.gitcrest;
  vi.unstubAllGlobals();
});

function versionResponse() {
  return new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 });
}

function installBridge() {
  let coreStatusListener: ((status: CoreStatus) => void) | undefined;
  const connections = [
    { baseUrl: "http://127.0.0.1:41001", token: "first", windowAccess: "readWrite" as const },
    { baseUrl: "http://127.0.0.1:41002", token: "second", windowAccess: "readWrite" as const },
  ];
  const bridge: GitCrestBridge = {
    getSidecarConnection: vi.fn(async () => connections.shift()!),
    chooseRepository: vi.fn(),
    chooseCloneParent: vi.fn(),
    openDiffWindow: vi.fn(),
    openConflictWindow: vi.fn(),
    subscribeToEvents: vi.fn(async () => () => undefined),
    getCoreStatus: vi.fn(async () => ({ state: "ready", generation: 1 }) as CoreStatus),
    restartCore: vi.fn(),
    subscribeToCoreStatus: (listener) => {
      coreStatusListener = listener;
      return () => { coreStatusListener = undefined; };
    },
  };
  window.gitcrest = bridge;
  return { bridge, publish: (status: CoreStatus) => coreStatusListener?.(status) };
}

it("holds requests while the core restarts and connects to the restarted core without restoring the workspace again", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => versionResponse()));
  const { bridge, publish } = installBridge();
  const onConnected = vi.fn(async () => undefined);
  const { result } = renderHook(() => useCoreConnection({ onConnected, onEvent: vi.fn() }));

  await waitFor(() => expect(result.current.connectionState).toBe("connected"));
  expect(onConnected).toHaveBeenLastCalledWith(expect.anything(), false);
  const firstApi = result.current.apiRef.current;

  act(() => publish({ state: "restarting", message: "The GitCrest core stopped unexpectedly (code=1 signal=null)." }));
  expect(result.current.connectionState).toBe("connecting");
  expect(result.current.status).toContain("stopped unexpectedly");
  expect(result.current.apiRef.current).toBeUndefined();

  act(() => publish({ state: "ready", generation: 2 }));
  await waitFor(() => expect(result.current.connectionState).toBe("connected"));
  expect(onConnected).toHaveBeenLastCalledWith(expect.anything(), true);
  expect(result.current.apiRef.current).not.toBe(firstApi);
  expect(bridge.getSidecarConnection).toHaveBeenCalledTimes(2);
  // The main process moves the one event subscription to the new core.
  expect(bridge.subscribeToEvents).toHaveBeenCalledTimes(1);
});

it("connects a window that loaded before the first core was ready and restores the workspace", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => versionResponse()));
  const { bridge, publish } = installBridge();
  vi.mocked(bridge.getSidecarConnection).mockRejectedValueOnce(new Error("Starting local GitCrest core..."));
  vi.mocked(bridge.getCoreStatus!).mockResolvedValueOnce({ state: "restarting", message: "Starting local GitCrest core..." });
  const onConnected = vi.fn(async () => undefined);
  const { result } = renderHook(() => useCoreConnection({ onConnected, onEvent: vi.fn() }));

  await waitFor(() => expect(bridge.getCoreStatus).toHaveBeenCalled());
  expect(result.current.connectionState).toBe("connecting");
  expect(result.current.status).toBe("Starting local GitCrest core...");
  expect(onConnected).not.toHaveBeenCalled();

  act(() => publish({ state: "ready", generation: 1 }));
  await waitFor(() => expect(result.current.connectionState).toBe("connected"));
  expect(onConnected).toHaveBeenCalledTimes(1);
  expect(onConnected).toHaveBeenLastCalledWith(expect.anything(), false);
});

it("shows a core that could not be restarted as failed", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => versionResponse()));
  const { publish } = installBridge();
  const { result } = renderHook(() => useCoreConnection({ onConnected: vi.fn(async () => undefined), onEvent: vi.fn() }));
  await waitFor(() => expect(result.current.connectionState).toBe("connected"));

  act(() => publish({ state: "failed", message: "Rust sidecar exited before ready: code=1" }));

  expect(result.current.connectionState).toBe("failed");
  expect(result.current.status).toBe("Rust sidecar exited before ready: code=1");
});

it("recovers from a reported connection problem once the core can be read again", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => versionResponse()));
  installBridge();
  const { result } = renderHook(() => useCoreConnection({ onConnected: vi.fn(async () => undefined), onEvent: vi.fn() }));
  await waitFor(() => expect(result.current.connectionState).toBe("connected"));

  act(() => result.current.setConnectionProblem("Repository list could not be read."));
  expect(result.current.connectionState).toBe("failed");

  act(() => result.current.setConnectionProblem(undefined));
  expect(result.current.connectionState).toBe("connected");
});
