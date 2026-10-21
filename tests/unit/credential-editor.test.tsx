// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { httpsHostFromRemote } from "../../src/shared/lib/https-remote-host";
import { CredentialEditor } from "../../src/features/credentials/ui/CredentialEditor";
import { HostCredentials, credentialHostFromInput } from "../../src/features/credentials";

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

it("reads a credential host from a bare host or an HTTPS URL", () => {
  expect(credentialHostFromInput(" Git.Example.test:8443 ")).toBe("git.example.test:8443");
  expect(credentialHostFromInput("https://git.example.test/org/repo.git")).toBe("git.example.test");
  expect(credentialHostFromInput("ssh://git.example.test/org/repo.git")).toBeUndefined();
  expect(credentialHostFromInput("")).toBeUndefined();
});

it("shows credential cards for the hosts it was opened with and for hosts entered later", async () => {
  const api = {
    getCredentialStatus: vi.fn((host: string) => Promise.resolve({ host, username: null, isConfigured: false })),
    setCredential: vi.fn(),
    deleteCredential: vi.fn(),
  } as unknown as GitCrestApiClient;
  render(<HostCredentials api={api} initialHosts={["example.test", "example.test"]} />);
  expect(screen.getAllByRole("article")).toHaveLength(1);
  expect(screen.getByRole("article", { name: "HTTPS credential for example.test" })).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Host or HTTPS URL"), { target: { value: "not a host" } });
  fireEvent.click(screen.getByRole("button", { name: "Show credential" }));
  expect(screen.getByRole("alert").textContent).toContain("Enter an HTTPS host");

  fireEvent.change(screen.getByLabelText("Host or HTTPS URL"), { target: { value: "https://gitea.example.test/org/repo.git" } });
  fireEvent.click(screen.getByRole("button", { name: "Show credential" }));
  expect(await screen.findByRole("article", { name: "HTTPS credential for gitea.example.test" })).toBeTruthy();
  await waitFor(() => expect(api.getCredentialStatus).toHaveBeenCalledWith("gitea.example.test"));
});
