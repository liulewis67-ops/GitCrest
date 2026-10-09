// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { SettingsDialog } from "../../src/features/settings/SettingsDialog";
import { defaultShortcutPreferences } from "../../src/shared/lib/shortcut-preferences";
import { PrivacyScopePreview } from "../../src/features/settings/PrivacyScopePreview";

afterEach(cleanup);

function cancellableApi(methods: Record<string, unknown>, signals: AbortSignal[] = []) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn((signal: AbortSignal) => { signals.push(signal); return api; }) };
  return api as unknown as GitCrestApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

it("moves focus into settings, traps Tab, and restores the opener on close", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
  });
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Open settings</button>{open && <SettingsDialog api={api} onClose={() => setOpen(false)} />}</>;
  }
  render(<Harness />);

  const opener = screen.getByRole("button", { name: "Open settings" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  const close = within(dialog).getByRole("button", { name: "Close settings" });
  await waitFor(() => expect(document.activeElement).toBe(close));
  const focusable = [...dialog.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )];
  const last = focusable[focusable.length - 1];
  fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: "Tab" });
  expect(document.activeElement).toBe(close);

  fireEvent.click(close);
  await waitFor(() => expect(document.activeElement).toBe(opener));
});

it("aborts AI settings loading when the settings dialog closes", async () => {
  const pending = deferred<Awaited<ReturnType<GitCrestApiClient["getAiSettings"]>>>();
  const signals: AbortSignal[] = [];
  const api = cancellableApi({ getAiSettings: vi.fn(() => pending.promise) }, signals);
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Open settings</button>{open && <SettingsDialog api={api} onClose={() => setOpen(false)} />}</>;
  }
  render(<Harness />);

  fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
  const dialog = await screen.findByRole("dialog", { name: "Settings" });
  await waitFor(() => expect(signals).toHaveLength(1));
  fireEvent.click(within(dialog).getByRole("button", { name: "Close settings" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull());
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => pending.resolve({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }));
});

it("records a replacement shortcut and rejects an existing assignment", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
  });
  const onShortcutsChange = vi.fn();
  render(<SettingsDialog api={api} onClose={vi.fn()} onShortcutsChange={onShortcutsChange} />);

  const commandPalette = screen.getByRole("button", { name: "Record shortcut for Open command palette" });
  fireEvent.click(commandPalette);
  fireEvent.keyDown(commandPalette, { key: "b", ctrlKey: true });
  expect((await screen.findByRole("alert")).textContent).toContain("Already assigned to Switch branch.");
  expect(onShortcutsChange).not.toHaveBeenCalled();

  fireEvent.keyDown(commandPalette, { key: "m", ctrlKey: true });
  expect(onShortcutsChange).toHaveBeenCalledWith({ ...defaultShortcutPreferences, commandPalette: "Mod+M" });
});

it("saves provider configuration without sending a model request", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
    setAiSettings: vi.fn().mockResolvedValue({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", hasCloudCredential: false }),
    setAiCredential: vi.fn(), deleteAiCredential: vi.fn(),
  });
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
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "openAiCompatible", baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: false }),
    setAiSettings: vi.fn(),
    setAiCredential: vi.fn().mockResolvedValue({ provider: "openAiCompatible", baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: true }),
    deleteAiCredential: vi.fn(),
  });
  render(<SettingsDialog api={api} onClose={vi.fn()} />);
  const keyInput = await screen.findByLabelText("Cloud API key");
  fireEvent.change(keyInput, { target: { value: "private-test-key" } });
  fireEvent.click(screen.getByRole("button", { name: "Save API key" }));
  await waitFor(() => expect(api.setAiCredential).toHaveBeenCalledWith("private-test-key"));
  expect(keyInput).toHaveProperty("value", "");
  expect(screen.queryByText("private-test-key")).toBeNull();
  expect(await screen.findByText("API key saved to the system credential store.")).toBeTruthy();
});

it("shows reviewable staged and worktree scopes and previews selected local diff text", async () => {
  const api = cancellableApi({
    getRepositoryStatus: vi.fn().mockResolvedValue({ repoId: "repo_fixture", refreshedAtMs: 1, files: [
      { path: "src/staged.ts", indexStatus: "M", worktreeStatus: " ", kind: "modified", categories: ["staged"], modeChanged: false },
      { path: "src/both.ts", indexStatus: "M", worktreeStatus: "M", kind: "modified", categories: ["staged", "unstaged"], modeChanged: false },
      { path: "secret.env", indexStatus: " ", worktreeStatus: "?", kind: "untracked", categories: ["untracked", "ignored"], modeChanged: false },
      { path: "src/conflict.ts", indexStatus: "U", worktreeStatus: "U", kind: "conflicted", categories: ["conflicted"], modeChanged: false },
    ] }),
    getFileDiff: vi.fn().mockResolvedValue({ repoId: "repo_fixture", path: "src/staged.ts", revision: "rev", originalPath: null, scope: "index", changeKind: "modified", status: "text", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "old value", newText: "new value" }] }] }),
  });
  render(<PrivacyScopePreview api={api} repoId="repo_fixture" />);
  await screen.findByText("src/staged.ts");
  expect(screen.queryByText("secret.env")).toBeNull();
  expect(screen.queryByText("src/conflict.ts")).toBeNull();
  const checkboxes = screen.getAllByRole("checkbox");
  fireEvent.click(checkboxes[0]);
  fireEvent.click(checkboxes[1]);
  fireEvent.click(screen.getAllByRole("button", { name: "Preview diff" })[0]);
  await waitFor(() => expect(api.getFileDiff).toHaveBeenCalledWith("repo_fixture", "src/staged.ts", "index"));
  expect((screen.getByLabelText("Diff preview for src/staged.ts").querySelector("pre")?.textContent ?? "")).toContain("-old value\n+new value");
  expect(await screen.findByText("2 selected")).toBeTruthy();
});

it("aborts changed-file status loading when the privacy preview unmounts", async () => {
  const pending = deferred<Awaited<ReturnType<GitCrestApiClient["getRepositoryStatus"]>>>();
  const signals: AbortSignal[] = [];
  const api = cancellableApi({ getRepositoryStatus: vi.fn(() => pending.promise) }, signals);
  const { unmount } = render(<PrivacyScopePreview api={api} repoId="repo_fixture" />);
  await waitFor(() => expect(signals).toHaveLength(1));
  unmount();
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => pending.resolve({ repoId: "repo_fixture", refreshedAtMs: 1, files: [] }));
});

it("aborts deselected diff previews and batch review reads on unmount", async () => {
  const status = { repoId: "repo_fixture", refreshedAtMs: 1, files: [{ path: "src/file.ts", indexStatus: " ", worktreeStatus: "M", kind: "modified", categories: ["unstaged"], modeChanged: false }] };
  const document = { repoId: "repo_fixture", path: "src/file.ts", revision: "rev", originalPath: null, scope: "workingTree" as const, changeKind: "modified" as const, status: "text" as const, hunks: [] };
  const previewDiff = deferred<Awaited<ReturnType<GitCrestApiClient["getFileDiff"]>>>();
  const reviewDiff = deferred<Awaited<ReturnType<GitCrestApiClient["getFileDiff"]>>>();
  const signals: AbortSignal[] = [];
  const api = cancellableApi({
    getRepositoryStatus: vi.fn().mockResolvedValue(status),
    getFileDiff: vi.fn().mockReturnValueOnce(previewDiff.promise).mockReturnValueOnce(reviewDiff.promise),
  }, signals);
  const settings = { provider: "openAiCompatible" as const, baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: true };
  const view = render(<PrivacyScopePreview api={api} repoId="repo_fixture" settings={settings} />);
  await screen.findByText("src/file.ts");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Preview diff" }));
  await waitFor(() => expect(api.getFileDiff).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("checkbox"));
  expect(signals[1]?.aborted).toBe(true);
  await act(async () => previewDiff.resolve(document));

  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Review all selected diffs before sending" }));
  await waitFor(() => expect(api.getFileDiff).toHaveBeenCalledTimes(2));
  view.unmount();
  expect(signals[2]?.aborted).toBe(true);
  await act(async () => reviewDiff.resolve(document));
});

it("requires reviewed diff display and an explicit confirmation before provider requests", async () => {
  const document = { repoId: "repo_fixture", path: "src/only.ts", revision: "sha256:reviewed", originalPath: null, scope: "workingTree" as const, changeKind: "modified" as const, status: "text" as const, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, rows: [{ kind: "change" as const, oldLine: 1, newLine: 1, oldText: "before", newText: "after" }] }] };
  const api = cancellableApi({
    getRepositoryStatus: vi.fn().mockResolvedValue({ repoId: "repo_fixture", refreshedAtMs: 1, files: [{ path: "src/only.ts", indexStatus: " ", worktreeStatus: "M", kind: "modified", categories: ["unstaged"], modeChanged: false }] }),
    getFileDiff: vi.fn().mockResolvedValue(document),
    requestAiReview: vi.fn().mockResolvedValue({ provider: "openAiCompatible", model: "model-a", response: "Reviewed response", files: ["src/only.ts [worktree]"] }),
  });
  render(<PrivacyScopePreview api={api} repoId="repo_fixture" settings={{ provider: "openAiCompatible", baseUrl: "https://api.example.test/v1", model: "model-a", hasCloudCredential: true }} />);
  await screen.findByText("src/only.ts");
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Review all selected diffs before sending" }));
  const send = await screen.findByRole("button", { name: "Send these exact diffs" });
  expect(screen.getByLabelText("Confirm provider request").querySelector("pre")?.textContent).toContain("-before\n+after");
  expect(api.requestAiReview).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the files/ }));
  fireEvent.click(send);
  await waitFor(() => expect(api.requestAiReview).toHaveBeenCalledWith("repo_fixture", "Summarize the selected changes and note any risks.", [{ path: "src/only.ts", scope: "workingTree", revision: "sha256:reviewed" }]));
  expect(await screen.findByText("Reviewed response")).toBeTruthy();
});
