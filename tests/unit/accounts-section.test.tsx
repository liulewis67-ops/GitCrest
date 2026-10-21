// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AccountResponse, GitCrestApiClient } from "../../src/api/client";
import { GitCrestApiError } from "../../src/api/client";
import { AccountsSection } from "../../src/features/accounts";
import { groupAccountsByHost, tokenCreationUrl, tokenExpiry } from "../../src/features/accounts/model/accounts";

afterEach(cleanup);

function account(overrides: Partial<AccountResponse> = {}): AccountResponse {
  return {
    accountId: `acct_${"a".repeat(32)}`,
    provider: "github",
    host: "github.com",
    login: "octocat",
    displayName: "The Octocat",
    avatarUrl: null,
    authKind: "token",
    scopes: ["repo"],
    tokenExpiresAtMs: null,
    state: "active",
    selected: true,
    createdAtMs: 1,
    lastValidatedAtMs: 1,
    ...overrides,
  };
}

function apiWith(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

it("builds token links, groups accounts and flags expiring tokens", () => {
  expect(tokenCreationUrl("github", "github.com")).toBe("https://github.com/settings/tokens/new?description=GitCrest&scopes=repo%2Cread%3Auser");
  expect(tokenCreationUrl("gitlab", "GitLab.example.com:8443")).toBe("https://gitlab.example.com:8443/-/user_settings/personal_access_tokens?name=GitCrest&scopes=read_user%2Cread_repository%2Cwrite_repository");
  expect(tokenCreationUrl("github", "github.com/evil")).toBeUndefined();
  expect(tokenCreationUrl("github", "")).toBeUndefined();

  const other = account({ accountId: `acct_${"b".repeat(32)}`, login: "hubot", selected: false });
  const lab = account({ accountId: `acct_${"c".repeat(32)}`, provider: "gitlab", host: "gitlab.com" });
  expect(groupAccountsByHost([other, lab, account()]).map((group) => [group.host, group.accounts.map((item) => item.login)])).toEqual([
    ["github.com", ["octocat", "hubot"]],
    ["gitlab.com", ["octocat"]],
  ]);

  const day = 24 * 60 * 60 * 1000;
  expect(tokenExpiry(null, 0)).toBeUndefined();
  expect(tokenExpiry(0, 1)).toEqual({ kind: "expired" });
  expect(tokenExpiry(day / 2, 0)).toEqual({ kind: "today" });
  expect(tokenExpiry(3 * day + 1, 0)).toEqual({ kind: "soon", days: 3 });
  expect(tokenExpiry(30 * day, 0)).toBeUndefined();
});

it("signs in with a token and never shows the token afterwards", async () => {
  const signedIn = account();
  const api = apiWith({
    listAccounts: vi.fn().mockResolvedValueOnce({ accounts: [] }).mockResolvedValue({ accounts: [signedIn] }),
    signInWithToken: vi.fn().mockResolvedValue(signedIn),
  });
  render(<AccountsSection api={api} />);
  await screen.findByText(/No accounts yet/);

  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  fireEvent.click(screen.getByRole("radio", { name: "GitLab" }));
  expect(screen.getByLabelText("Host")).toHaveProperty("value", "gitlab.com");
  fireEvent.click(screen.getByRole("radio", { name: "GitHub" }));
  expect(screen.getByLabelText("Host")).toHaveProperty("value", "github.com");
  expect(screen.getByRole("link", { name: "Create a token on github.com" }).getAttribute("href")).toContain("scopes=repo");

  fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "test-secret-token" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await waitFor(() => expect(api.signInWithToken).toHaveBeenCalledWith("github", "github.com", "test-secret-token"));
  expect(await screen.findByText("Signed in as octocat on github.com.")).toBeTruthy();
  expect(screen.queryByLabelText("Personal access token")).toBeNull();
  expect(screen.getByText("Used for github.com")).toBeTruthy();
  expect(document.body.textContent).not.toContain("test-secret-token");
});

it("keeps the form open with the provider's message when sign-in fails", async () => {
  const api = apiWith({
    listAccounts: vi.fn().mockResolvedValue({ accounts: [] }),
    signInWithToken: vi.fn().mockRejectedValue(new GitCrestApiError(422, { error: { code: "ACCOUNT_TOKEN_REJECTED", message: "The provider rejected this token." } })),
  });
  render(<AccountsSection api={api} />);
  await screen.findByText(/No accounts yet/);
  fireEvent.click(screen.getByRole("button", { name: "Add account" }));
  fireEvent.change(screen.getByLabelText("Personal access token"), { target: { value: "expired" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  expect((await screen.findByRole("alert")).textContent).toBe("The provider rejected this token.");
  expect(screen.getByLabelText("Personal access token")).toHaveProperty("value", "expired");
});

it("switches the account Git uses and confirms before signing out", async () => {
  const first = account();
  const second = account({ accountId: `acct_${"b".repeat(32)}`, login: "hubot", displayName: null, selected: false });
  const api = apiWith({
    listAccounts: vi.fn()
      .mockResolvedValueOnce({ accounts: [first, second] })
      .mockResolvedValueOnce({ accounts: [{ ...first, selected: false }, { ...second, selected: true }] })
      .mockResolvedValue({ accounts: [{ ...first, selected: true }] }),
    selectAccount: vi.fn().mockResolvedValue({ ...second, selected: true }),
    signOutAccount: vi.fn().mockResolvedValue(undefined),
  });
  render(<AccountsSection api={api} />);
  const hubot = await screen.findByRole("listitem", { name: "hubot" });
  fireEvent.click(within(hubot).getByRole("button", { name: "Use for github.com" }));
  await waitFor(() => expect(api.selectAccount).toHaveBeenCalledWith(second.accountId));
  expect(await screen.findByText("Git now uses hubot for github.com.")).toBeTruthy();

  const switched = screen.getByRole("listitem", { name: "hubot" });
  fireEvent.click(within(switched).getByRole("button", { name: "Sign out" }));
  expect(api.signOutAccount).not.toHaveBeenCalled();
  expect(within(switched).getByText("Sign out hubot?")).toBeTruthy();
  fireEvent.click(within(switched).getByRole("button", { name: "Sign out" }));
  await waitFor(() => expect(api.signOutAccount).toHaveBeenCalledWith(second.accountId));
  expect(await screen.findByText(/Signed out hubot\. The token still works on GitHub/)).toBeTruthy();
  expect(screen.queryByRole("listitem", { name: "hubot" })).toBeNull();
});

it("offers to replace the token of an account that needs sign-in", async () => {
  const stale = account({ provider: "gitlab", host: "gitlab.example.com", state: "needsReauth" });
  const api = apiWith({ listAccounts: vi.fn().mockResolvedValue({ accounts: [stale] }) });
  render(<AccountsSection api={api} />);
  const row = await screen.findByRole("listitem", { name: "octocat" });
  expect(within(row).getByText("Needs sign-in")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: "Replace token" }));
  expect(screen.getByRole("radio", { name: "GitLab" })).toHaveProperty("checked", true);
  expect(screen.getByLabelText("Host")).toHaveProperty("value", "gitlab.example.com");
});
