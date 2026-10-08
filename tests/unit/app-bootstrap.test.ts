import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapApp } from "../../src/app/bootstrap";
import type { GitCrestBridge } from "../../src/api/bridge";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootstrapApp", () => {
  it("assembles the authenticated API client after the version handshake", async () => {
    const response = new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const bridge: GitCrestBridge = {
      getSidecarConnection: vi.fn().mockResolvedValue({
        baseUrl: "http://127.0.0.1:43210",
        token: "session-token",
        windowAccess: "readWrite",
      }),
      chooseRepository: vi.fn(),
      chooseCloneParent: vi.fn(),
      openDiffWindow: vi.fn(),
      openConflictWindow: vi.fn(),
      subscribeToEvents: vi.fn().mockResolvedValue(vi.fn()),
    };
    vi.stubGlobal("fetch", fetcher);

    const result = await bootstrapApp(bridge);

    expect(result.version).toEqual({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("http://127.0.0.1:43210/api/version");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer session-token");
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("X-GitCrest-API-Version")).toBe(false);
    expect(result.api).toBeDefined();
    expect(result.subscribeToEvents).toBeTypeOf("function");
  });
});
