// @vitest-environment jsdom
// AI assistance is deferred and hidden by default; these tests turn it on to keep the hidden section working.
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { SettingsPage } from "../../src/features/settings/ui/SettingsPage";

vi.mock("../../src/shared/lib/feature-flags", () => ({ AI_FEATURES_ENABLED: true }));

afterEach(cleanup);

function cancellableApi(methods: Record<string, unknown>, signals: AbortSignal[] = []) {
  let api: Record<string, unknown>;
  api = { listAccounts: vi.fn().mockResolvedValue({ accounts: [] }), ...methods, withSignal: vi.fn((signal: AbortSignal) => { signals.push(signal); return api; }) };
  return api as unknown as GitCrestApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

it("shows the AI section and its shortcut when AI assistance is enabled", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
  });
  render(<SettingsPage api={api} onClose={vi.fn()} />);

  const nav = await screen.findByRole("navigation", { name: "Settings sections" });
  expect(within(nav).getByRole("button", { name: "AI assistant" })).toBeTruthy();
  expect(await screen.findByRole("combobox", { name: "AI provider" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Record shortcut for Generate commit message" })).toBeTruthy();
});

it("aborts AI settings and account loading when the settings dialog closes", async () => {
  const pending = deferred<Awaited<ReturnType<GitCrestApiClient["getAiSettings"]>>>();
  const signals: AbortSignal[] = [];
  const api = cancellableApi({ getAiSettings: vi.fn(() => pending.promise) }, signals);
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Open settings</button>{open && <SettingsPage api={api} onClose={() => setOpen(false)} />}</>;
  }
  render(<Harness />);

  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(signals).toHaveLength(2));
  fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  await act(async () => pending.resolve({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }));
});

it("saves provider configuration without sending a model request", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
    setAiSettings: vi.fn().mockResolvedValue({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", hasCloudCredential: false }),
    setAiCredential: vi.fn(), deleteAiCredential: vi.fn(),
  });
  render(<SettingsPage api={api} onClose={vi.fn()} />);
  await screen.findByRole("combobox", { name: "AI provider" });
  fireEvent.change(screen.getByRole("combobox", { name: "AI provider" }), { target: { value: "ollama" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen" } });
  fireEvent.click(screen.getByRole("button", { name: "Save provider settings" }));
  await waitFor(() => expect(api.setAiSettings).toHaveBeenCalledWith("ollama", "http://127.0.0.1:11434", "qwen"));
  expect(api.setAiCredential).not.toHaveBeenCalled();
  expect(await screen.findByText("Provider settings saved. No model request was made.")).toBeTruthy();
});

it("submits cloud keys through the credential API and clears the field", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "openAiCompatible", baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: false }),
    setAiSettings: vi.fn(),
    setAiCredential: vi.fn().mockResolvedValue({ provider: "openAiCompatible", baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: true }),
    deleteAiCredential: vi.fn(),
  });
  render(<SettingsPage api={api} onClose={vi.fn()} />);
  const keyInput = await screen.findByLabelText("Cloud API key");
  fireEvent.change(keyInput, { target: { value: "private-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  await waitFor(() => expect(api.setAiCredential).toHaveBeenCalledWith("private-test-key"));
  expect(keyInput).toHaveProperty("value", "");
  expect(screen.queryByText("private-test-key")).toBeNull();
  expect(await screen.findByText("API key saved to the system credential store.")).toBeTruthy();
});
