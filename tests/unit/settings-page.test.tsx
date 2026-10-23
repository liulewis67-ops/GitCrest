// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { SettingsPage } from "../../src/features/settings/ui/SettingsPage";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { reloadAppearance } from "../../src/features/settings/model/appearance-store";
import { PrivacyScopePreview } from "../../src/features/settings/ui/PrivacyScopePreview";

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

it("moves focus into settings, traps Tab, and restores the opener on close", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
  });
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button type="button" onClick={() => setOpen(true)}>Open settings</button>{open && <SettingsPage api={api} onClose={() => setOpen(false)} />}</>;
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

it("records a replacement shortcut and rejects an existing assignment", async () => {
  const api = cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
  });
  const onShortcutsChange = vi.fn();
  render(<SettingsPage api={api} onClose={vi.fn()} onShortcutsChange={onShortcutsChange} />);

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

function settingsApi() {
  return cancellableApi({
    getAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
  });
}

it("applies a built-in theme from the gallery and switches a fixed color mode to show it", async () => {
  window.localStorage.clear();
  reloadAppearance();
  render(<SettingsPage api={settingsApi()} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("radio", { name: "Light" }));
  expect(document.documentElement.dataset.theme).toBe("light");

  fireEvent.click(screen.getByRole("button", { name: /^Midnight, Dark/ }));
  expect(document.documentElement.dataset.themeId).toBe("midnight");
  expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("button", { name: /^Midnight, Dark, Used in dark mode, showing now$/ }).getAttribute("aria-pressed")).toBe("true");
});

it("previews theme edits live, restores on cancel, and saves a duplicated theme", async () => {
  window.localStorage.clear();
  reloadAppearance();
  render(<SettingsPage api={settingsApi()} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));

  fireEvent.click(screen.getByRole("button", { name: "Duplicate GitCrest Dark" }));
  fireEvent.click(screen.getByRole("button", { name: "Violet" }));
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#a48bf0");
  expect(document.documentElement.dataset.themeId).toMatch(/^custom-/);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.documentElement.dataset.themeId).toBe("gitcrest-dark");
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#6db6d8");

  fireEvent.click(screen.getByRole("button", { name: "Duplicate GitCrest Dark" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Violet night" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Background" }), { target: { value: "#101010" } });
  fireEvent.click(screen.getByRole("button", { name: "Create theme" }));
  await screen.findByText("Saved “Violet night” and switched to it.");
  expect(document.documentElement.style.getPropertyValue("--canvas")).toBe("#101010");
  screen.getByRole("button", { name: /^Violet night, Dark, Used in dark mode, showing now$/ });
  expect(window.localStorage.getItem("gitcrest-appearance-v1")).toContain("Violet night");
});

it("drops an unsaved theme draft when Settings closes", async () => {
  window.localStorage.clear();
  reloadAppearance();
  const { unmount } = render(<SettingsPage api={settingsApi()} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));
  fireEvent.click(screen.getByRole("button", { name: "New theme" }));
  fireEvent.click(screen.getByRole("button", { name: "Rose" }));
  expect(document.documentElement.dataset.themeId).toMatch(/^custom-/);
  unmount();
  expect(document.documentElement.dataset.themeId).toBe("gitcrest-dark");
});

it("changes global style from the Style card and lets a theme override it", async () => {
  window.localStorage.clear();
  reloadAppearance();
  render(<SettingsPage api={settingsApi()} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));

  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Density" })).getByRole("radio", { name: "Compact" }));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Commit graph" })).getByRole("radio", { name: "Color per lane" }));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: "Motion" })).getByRole("radio", { name: "Reduced" }));
  expect(document.documentElement.dataset).toMatchObject({ density: "compact", graphColors: "lanes", motion: "reduced" });

  fireEvent.click(screen.getByRole("button", { name: "Duplicate GitCrest Dark" }));
  const density = screen.getByRole("combobox", { name: "Density" });
  expect(within(density).getByRole("option", { name: "Use global (Compact)" })).toBeTruthy();
  fireEvent.change(density, { target: { value: "comfortable" } });
  expect(document.documentElement.dataset.density).toBe("comfortable");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(document.documentElement.dataset.density).toBe("compact");
});

it("fixes low-contrast colors in the theme editor on request", async () => {
  window.localStorage.clear();
  reloadAppearance();
  render(<SettingsPage api={settingsApi()} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("radio", { name: "Dark" }));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate GitCrest Dark" }));
  expect(screen.queryByRole("button", { name: "Fix readability" })).toBeNull();

  fireEvent.change(screen.getByRole("textbox", { name: "Text" }), { target: { value: "#2a2f36" } });
  screen.getByText(/readability check\(s\) below the recommended contrast/);
  fireEvent.click(screen.getByRole("button", { name: "Fix readability" }));
  screen.getByText("Adjusted the colors that were below the recommended contrast.");
  expect(screen.queryByRole("button", { name: "Fix readability" })).toBeNull();
});
