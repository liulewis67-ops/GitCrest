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
        chooseRepository: vi.fn(),
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
      }))
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
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(String(fetcher.mock.calls[2][0])).toBe("http://127.0.0.1:43210/api/v1/repositories");
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
        chooseRepository: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "gitcrest-core", version: "0.1.0", apiVersion: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } })));

    render(<App />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(dialog).toBeDefined();
    const openCommand = within(dialog).getByRole("button", { name: /Open local repository/ }) as HTMLButtonElement;
    expect(openCommand.disabled).toBe(false);
    expect(within(dialog).getByRole("button", { name: /Clone repository/ })).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull());
  });

  it("opens the selected local repository and shows its workspace context", async () => {
    const repository = {
      repoId: "repo_fixture",
      path: "C:/fixture",
      head: null,
      branch: "main",
      detached: false,
      state: "normal",
    };
    const chooseRepository = vi.fn().mockResolvedValue("C:/fixture");
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({
          baseUrl: "http://127.0.0.1:43210",
          token: "test-session-token",
          windowAccess: "readWrite",
        }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository,
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(repository), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    await screen.findByText("Core connected");
    fireEvent.click(screen.getByRole("button", { name: "Open a repository" }));

    expect(await screen.findByText("C:/fixture", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(chooseRepository).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ path: "C:/fixture" });
    expect(screen.getByText("main", { selector: ".navEmpty" })).toBeDefined();
  });

  it("shows persisted repositories in Welcome and lets the user favorite or forget them", async () => {
    const repository = {
      repoId: "repo_fixture", path: "C:/project", head: null, branch: "main", detached: false,
      state: "normal", isFavorite: false, lastAccessedAt: 10, availability: "available",
    };
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([repository]), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...repository, isFavorite: true }), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(null, { status: 204, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Recent repositories" })).toBeDefined();
    expect(await screen.findByText("C:/project")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Favorite project" }));
    expect(await screen.findByRole("button", { name: "Remove project from favorites" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Remove project from recent repositories" }));
    await waitFor(() => expect(screen.queryByText("C:/project")).toBeNull());
    expect(String(fetcher.mock.calls[2][0])).toBe("http://127.0.0.1:43210/api/v1/repositories/repo_fixture/favorite");
    expect(fetcher.mock.calls[3][1]?.method).toBe("DELETE");
  });

  it("initializes only the folder explicitly returned by the folder picker", async () => {
    const repository = {
      repoId: "repo_new", path: "C:/new-project", head: null, branch: "main", detached: false,
      state: "normal", isFavorite: false, lastAccessedAt: 10, availability: "available",
    };
    const chooseRepository = vi.fn().mockResolvedValue("C:/new-project");
    Object.defineProperty(window, "gitcrest", {
      configurable: true,
      value: {
        getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:43210", token: "test-session-token", windowAccess: "readWrite" }),
        subscribeToEvents: vi.fn(async () => vi.fn()),
        chooseRepository,
      },
    });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "gitcrest-core", version: "0.1.0", apiVersion: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200, headers: { "X-GitCrest-API-Version": "1" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(repository), { status: 200, headers: { "X-GitCrest-API-Version": "1" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<App />);
    expect(await screen.findByRole("heading", { name: "Recent repositories" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /Initialize a repository/ }));
    expect(await screen.findByText("C:/new-project", { selector: ".workspaceCrumb .mutedText" })).toBeDefined();
    expect(chooseRepository).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[2][0])).toBe("http://127.0.0.1:43210/api/v1/repositories/initialize");
    expect(JSON.parse(String(fetcher.mock.calls[2][1]?.body))).toEqual({ path: "C:/new-project" });
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
