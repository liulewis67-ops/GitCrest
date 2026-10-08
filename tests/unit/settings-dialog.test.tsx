// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";

afterEach(cleanup);

it("saves provider configuration without sending a model request", async () => {
  const api = {
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
    setAiSettings: vi.fn().mockResolvedValue({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", hasCloudCredential: false }),
    setAiCredential: vi.fn(), deleteAiCredential: vi.fn(),
  } as unknown as GitCrestApiClient;
  render(<SettingsDialog api={api} onClose={vi.fn()} />);
  await screen.findByRole("combobox", { name: "AI provider" });
  fireEvent.change(screen.getByRole("combobox", { name: "AI provider" }), { target: { value: "ollama" } });
  fireEvent.change(screen.getByLabelText("Model"), { target: { value: "qwen" } });
  fireEvent.click(screen.getByRole("button", { name: "Save provider settings" }));
  await waitFor(() => expect(api.setAiSettings).toHaveBeenCalledWith("ollama", "http://127.0.0.1:11434", "qwen"));
  expect(api.setAiCredential).not.toHaveBeenCalled();
  expect(await screen.findByText("Provider settings saved. No model request was made.")).toBeTruthy();
});

it("submits cloud keys through the credential API and clears the field", async () => {
  const api = {
    getAiSettings: vi.fn().mockResolvedValue({ provider: "openAiCompatible", baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: false }),
    setAiSettings: vi.fn(),
    setAiCredential: vi.fn().mockResolvedValue({ provider: "openAiCompatible", baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: true }),
    deleteAiCredential: vi.fn(),
  } as unknown as GitCrestApiClient;
  render(<SettingsDialog api={api} onClose={vi.fn()} />);
  const keyInput = await screen.findByLabelText("Cloud API key");
  fireEvent.change(keyInput, { target: { value: "private-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  await waitFor(() => expect(api.setAiCredential).toHaveBeenCalledWith("private-test-key"));
  expect(keyInput).toHaveProperty("value", "");
  expect(screen.queryByText("private-test-key")).toBeNull();
  expect(await screen.findByText("API key saved to the system credential store.")).toBeTruthy();
});
