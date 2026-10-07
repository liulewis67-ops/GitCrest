// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { CredentialEditor, httpsHostFromRemote } from "../../src/features/credentials/CredentialEditor";

afterEach(cleanup);

it("normalizes HTTPS hosts and ignores non-HTTPS remotes", () => {
  expect(httpsHostFromRemote("https://GitHub.com:443/org/repo.git")).toBe("github.com");
  expect(httpsHostFromRemote("ssh://github.com/org/repo.git")).toBeUndefined();
  expect(httpsHostFromRemote("not a URL")).toBeUndefined();
});

it("saves credentials through the API and clears the secret field", async () => {
  const api = {
    getCredentialStatus: vi.fn().mockResolvedValue({ host: "github.com", username: null, isConfigured: false }),
    setCredential: vi.fn().mockResolvedValue({ host: "github.com", username: "lewis", isConfigured: true }),
    deleteCredential: vi.fn(),
  } as unknown as GitCrestApiClient;
  render(<CredentialEditor api={api} host="github.com" />);
  await screen.findByText("Not set");
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "lewis" } });
  fireEvent.change(screen.getByLabelText("Token or password"), { target: { value: "test-secret-value" } });
  fireEvent.click(screen.getByRole("button", { name: "Save credential" }));
  await waitFor(() => expect(api.setCredential).toHaveBeenCalledWith("github.com", "lewis", "test-secret-value"));
  expect(screen.getByLabelText("Token or password")).toHaveProperty("value", "");
  expect(await screen.findByText("Saved")).toBeTruthy();
  expect(screen.queryByText("test-secret-value")).toBeNull();
});

it("requires an explicit second action before deleting a saved credential", async () => {
  const api = {
    getCredentialStatus: vi.fn().mockResolvedValue({ host: "github.com", username: "lewis", isConfigured: true }),
    setCredential: vi.fn(),
    deleteCredential: vi.fn().mockResolvedValue(undefined),
  } as unknown as GitCrestApiClient;
  render(<CredentialEditor api={api} host="github.com" />);
  await screen.findByText("Saved");
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  expect(api.deleteCredential).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
  await waitFor(() => expect(api.deleteCredential).toHaveBeenCalledWith("github.com"));
});
