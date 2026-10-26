// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import type { AiSettingsResponse, GitCrestApiClient, StatusSnapshotResponse } from "../../src/api/client";
import { CommitMessageAssistant } from "../../src/features/commits/ui/CommitMessageAssistant";

afterEach(cleanup);

const stagedSnapshot: StatusSnapshotResponse = {
  repoId: "repo_fixture",
  refreshedAtMs: 1,
  files: [{ path: "src/only.ts", indexStatus: "M", worktreeStatus: " ", kind: "modified", categories: ["staged"], modeChanged: false }],
};

const stagedDiff = {
  repoId: "repo_fixture", path: "src/only.ts", revision: "sha256:staged", originalPath: null,
  scope: "index" as const, changeKind: "modified" as const, status: "text" as const,
  hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, rows: [
    { kind: "change" as const, oldLine: 1, newLine: 1, oldText: "old selected", newText: "new selected" },
    { kind: "change" as const, oldLine: 2, newLine: 2, oldText: "old unselected", newText: "new unselected" },
  ] }],
};

const settings: AiSettingsResponse = { activeProviderId: "local", providers: [{ id: "local", name: "Local", apiFormat: "openAiChatCompletions", baseUrl: "http://127.0.0.1:11434/v1", model: "qwen", maxOutputTokens: null, hasApiKey: false, isLocal: true }], configPath: null };

function makeApi(requestAiReview = vi.fn()) {
  return {
    getAiSettings: vi.fn().mockResolvedValue(settings),
    getRepositoryStatus: vi.fn().mockResolvedValue(stagedSnapshot),
    getFileDiff: vi.fn().mockResolvedValue(stagedDiff),
    requestAiReview,
  } as unknown as GitCrestApiClient;
}

function Harness({ api, selections = [], onUse = vi.fn() }: {
  api: GitCrestApiClient;
  selections?: Array<{ path: string; revision: string; selections: Array<{ hunkIndex: number; rowIndex?: number }> }>;
  onUse?: (message: string) => void;
}) {
  const [draft, setDraft] = useState("original draft");
  return <>
    <textarea aria-label="Commit message" value={draft} onChange={(event) => setDraft(event.target.value)} />
    <CommitMessageAssistant api={api} repoId="repo_fixture" draftMessage={draft} commitSelections={selections} commitSelectionRepoId={selections.length ? "repo_fixture" : undefined} onUseSuggestion={onUse} onClose={vi.fn()} />
  </>;
}

it("sends only selected staged rows and requires explicit consent before showing an editable suggestion", async () => {
  const request = vi.fn().mockResolvedValue({ provider: "Local", apiFormat: "openAiChatCompletions", model: "qwen", response: "feat: update selected value", files: ["src/only.ts [index]"] });
  const api = makeApi(request);
  render(<Harness api={api} selections={[{ path: "src/only.ts", revision: "sha256:staged", selections: [{ hunkIndex: 0, rowIndex: 0 }] }]} />);

  await screen.findByText("src/only.ts · staged/index · 1 selected hunk/row range");
  expect(screen.getByText("Local · OpenAI Chat Completions · qwen · http://127.0.0.1:11434/v1 (this machine)")).toBeTruthy();
  expect(screen.getByText(/Write a concise Conventional Commit message/)).toBeTruthy();
  const preview = screen.getByText("src/only.ts · staged/index · 1 selected hunk/row range").closest("details")?.querySelector("pre")?.textContent || "";
  expect(preview).toContain("+new selected");
  expect(preview).not.toContain("new unselected");
  expect(request).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the staged diff/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send reviewed staged diff" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("repo_fixture", expect.stringContaining("Conventional Commit"), [{ path: "src/only.ts", scope: "index", revision: "sha256:staged", selections: [{ hunkIndex: 0, rowIndex: 0 }] }]));
  expect(await screen.findByLabelText("Commit message suggestion")).toHaveProperty("value", "feat: update selected value");
  expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveProperty("value", "original draft");
});

it("keeps a user-edited draft when a delayed provider response arrives and disables applying that suggestion", async () => {
  let resolveRequest!: (value: { provider: string; apiFormat: "openAiChatCompletions"; model: string; response: string; files: string[] }) => void;
  const request = vi.fn(() => new Promise((resolve) => { resolveRequest = resolve; }));
  render(<Harness api={makeApi(request)} />);
  await screen.findByText("src/only.ts · staged/index · all staged changes");
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the staged diff/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send reviewed staged diff" }));
  await waitFor(() => expect(request).toHaveBeenCalled());
  fireEvent.change(screen.getByRole("textbox", { name: "Commit message" }), { target: { value: "my manual message" } });
  resolveRequest({ provider: "Local", apiFormat: "openAiChatCompletions", model: "qwen", response: "feat: late suggestion", files: ["src/only.ts [index]"] });
  expect(await screen.findByText("The commit draft changed while the provider was responding. Your text was kept; start a new request to use a suggestion.")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveProperty("value", "my manual message");
  expect(screen.getByRole("button", { name: "Use suggestion" })).toHaveProperty("disabled", true);
});

it("allows a fresh suggestion to be applied explicitly and keeps provider failures retryable", async () => {
  const onUse = vi.fn();
  const request = vi.fn()
    .mockRejectedValueOnce(new Error("provider unavailable"))
    .mockResolvedValueOnce({ provider: "Local", apiFormat: "openAiChatCompletions", model: "qwen", response: "fix: handle staged case", files: ["src/only.ts [index]"] });
  render(<Harness api={makeApi(request)} onUse={onUse} />);
  await screen.findByText("src/only.ts · staged/index · all staged changes");
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the staged diff/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send reviewed staged diff" }));
  expect(await screen.findByText("provider unavailable")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Commit message" })).toHaveProperty("value", "original draft");
  fireEvent.click(screen.getByRole("button", { name: "Review and retry" }));
  await screen.findByText("src/only.ts · staged/index · all staged changes");
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the staged diff/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send reviewed staged diff" }));
  const useSuggestion = await screen.findByRole("button", { name: "Use suggestion" });
  fireEvent.click(useSuggestion);
  expect(onUse).toHaveBeenCalledWith("fix: handle staged case");
});

it("marks a suggestion stale when a refresh shows that staged status changed during the provider request", async () => {
  const changedSnapshot: StatusSnapshotResponse = {
    ...stagedSnapshot,
    refreshedAtMs: 2,
    files: [{ ...stagedSnapshot.files[0], worktreeStatus: "M", categories: ["staged", "unstaged"] }],
  };
  const getRepositoryStatus = vi.fn()
    .mockResolvedValueOnce(stagedSnapshot)
    .mockResolvedValueOnce(stagedSnapshot)
    .mockResolvedValueOnce(changedSnapshot);
  const api = {
    ...makeApi(vi.fn().mockResolvedValue({ provider: "Local", apiFormat: "openAiChatCompletions", model: "qwen", response: "feat: stale change", files: ["src/only.ts [index]"] })),
    getRepositoryStatus,
  } as unknown as GitCrestApiClient;
  render(<Harness api={api} />);
  await screen.findByText("src/only.ts · staged/index · all staged changes");
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the staged diff/ }));
  fireEvent.click(screen.getByRole("button", { name: "Send reviewed staged diff" }));
  expect(await screen.findByText("This suggestion is stale and cannot be applied.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Use suggestion" })).toHaveProperty("disabled", true);
});

it("summarizes only reviewed staged changes without writing the summary into the commit message", async () => {
  const request = vi.fn().mockResolvedValue({ provider: "Local", apiFormat: "openAiChatCompletions", model: "qwen", response: "- Updates the staged value.\n- Leaves unstaged edits untouched.", files: ["src/only.ts [index]"] });
  render(<Harness api={makeApi(request)} />);
  await screen.findByText("src/only.ts · staged/index · all staged changes");
  fireEvent.change(screen.getByRole("combobox", { name: "AI output" }), { target: { value: "changeSummary" } });
  expect(screen.getByText(/Summarize the reviewed staged changes/)).toBeTruthy();
  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the staged diff/ }));
  fireEvent.click(screen.getByRole("button", { name: "Summarize reviewed staged diff" }));
  await waitFor(() => expect(request).toHaveBeenCalledWith("repo_fixture", expect.stringContaining("concise bullet points"), [{ path: "src/only.ts", scope: "index", revision: "sha256:staged" }]));
  expect(await screen.findByLabelText("AI change summary")).toBeTruthy();
  expect(screen.getByLabelText("Commit message")).toHaveProperty("value", "original draft");
  expect(screen.queryByRole("button", { name: "Use suggestion" })).toBeNull();
});

it("asks for an active provider and never sends without one", async () => {
  const request = vi.fn();
  const api = { ...makeApi(request), getAiSettings: vi.fn().mockResolvedValue({ ...settings, activeProviderId: null }) } as unknown as GitCrestApiClient;
  render(<Harness api={api} />);

  await screen.findByText("Add an AI provider and make it active in Settings before sending a request. Manual commit remains available.");
  await screen.findByText(/src\/only.ts · staged\/index/);
  fireEvent.click(screen.getByLabelText(/I reviewed the staged diff/));
  expect((screen.getByRole("button", { name: "Send reviewed staged diff" }) as HTMLButtonElement).disabled).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
