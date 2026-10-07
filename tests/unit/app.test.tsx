// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { components } from "../../src/api/schema";
import App from "../../src/App";

const resyncEvent: components["schemas"]["EventEnvelope"] = {
  eventId: "event-1",
  protocolVersion: 1,
  type: "connection.resyncRequired",
  occurredAtMs: 1_791_386_400_000,
  payload: {},
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("connects to the sidecar and reloads the repository list after event resync", async () => {
    let onEvent: ((event: components["schemas"]["EventEnvelope"]) => void) | undefined;
    const subscribeToEvents = vi.fn(async (listener: typeof onEvent) => {
      onEvent = listener;
      return vi.fn();
    });
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents,
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "gitcrest-core",
        version: "0.1.0",
        apiVersion: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", {
        status: 200,
        headers: { "X-GitCrest-API-Version": "1" },
      }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByText("Core connected")).toBeDefined();
    expect(screen.getByText("gitcrest-core 0.1.0 (API v1)")).toBeDefined();
    await waitFor(() => expect(subscribeToEvents).toHaveBeenCalledOnce());

    onEvent?.(resyncEvent);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(String(fetcher.mock.calls[1][0])).toBe("http://127.0.0.1:43210/api/v1/repositories");
  });

  it("opens a keyboard-accessible command palette with reasons for unavailable actions", async () => {
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      name: "gitcrest-core", version: "0.1.0", apiVersion: 1,
    }), { status: 200 })));

    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeDefined();
    const unavailableCommand = within(dialog).getByRole("button", { name: /Open local repository/ }) as HTMLButtonElement;
    expect(unavailableCommand.disabled).toBe(true);
    expect(screen.getByText("Repository picker arrives with S1.1")).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  });

  it("cycles themes and exposes keyboard-adjustable panel separators", async () => {
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      name: "gitcrest-core", version: "0.1.0", apiVersion: 1,
    }), { status: 200 })));

    render(<App />);
    const themeButton = screen.getByRole("button", { name: /Color theme/ });
    fireEvent.click(themeButton);
    await waitFor(() => expect(["light", "dark"]).toContain(document.documentElement.dataset.theme));

    fireEvent.click(screen.getByRole("button", { name: "Workspace" }));
    const separator = screen.getByRole("separator", { name: "Resize repository navigation" });
    const originalWidth = Number(separator.getAttribute("aria-valuenow"));
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(Number(separator.getAttribute("aria-valuenow"))).toBe(originalWidth + 16);
  });
});
