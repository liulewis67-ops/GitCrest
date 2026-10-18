// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, WorkflowConflictFileResponse } from "../../src/api/client";
import { ConflictSuggestionPanel } from "../../src/features/workflows/ui/ConflictSuggestionPanel";

afterEach(cleanup);

const conflict: WorkflowConflictFileResponse = {
  repoId: "repo_fixture",
  taskId: "task_conflict",
  path: "src/conflict.ts",
  operation: "merge",
  headOid: "a".repeat(40),
  baseContent: "base value\n",
  oursContent: "ours value\n",
  theirsContent: "theirs value\n",
  resultContent: "<<<<<<< ours\nours value\n=======\ntheirs value\n>>>>>>> theirs\n",
  resultRevision: "b".repeat(64),
  isText: true, oursPresent: true, theirsPresent: true,
};

function makeApi(request = vi.fn().mockResolvedValue({ provider: "ollama", model: "qwen", response: "merged result\n", files: ["src/conflict.ts [base/ours/theirs/result]"] })) {
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn(() => api),
    getRepositoryWorkflowConflictAiSettings: vi.fn().mockResolvedValue({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", hasCloudCredential: false }),
    requestRepositoryWorkflowConflictSuggestion: request,
    getRepositoryWorkflowConflictFile: vi.fn().mockResolvedValue(conflict),
  };
  return api as unknown as GitCrestApiClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

it("reviews conflict sources and requires consent before showing a suggestion without editing the result", async () => {
  const request = vi.fn().mockResolvedValue({ provider: "ollama", model: "qwen", response: "merged result\n", files: ["src/conflict.ts [base/ours/theirs/result]"] });
  const api = makeApi(request);
  render(<ConflictSuggestionPanel api={api} file={conflict} hasUnsavedChanges={false} onClose={vi.fn()} />);
  expect(await screen.findByText("http://127.0.0.1:11434")).toBeTruthy();
  expect(screen.getByText(/Source: merge · src\/conflict.ts/)).toBeTruthy();
  for (const label of ["BASE", "OURS", "THEIRS", "CURRENT RESULT"]) fireEvent.click(screen.getByText(new RegExp(`^${label} ·`)));
  expect(screen.getByText("ours value")).toBeTruthy();
  expect(screen.getByText("theirs value")).toBeTruthy();
  expect(screen.getByText("CURRENT RESULT · 60 bytes").parentElement?.querySelector("pre")?.textContent).toContain("<<<<<<< ours");
  expect(request).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("checkbox", { name: /I reviewed the endpoint/ }));
  fireEvent.click(screen.getByRole("button", { name: "Request conflict suggestion" }));
  await waitFor(() => expect(api.requestRepositoryWorkflowConflictSuggestion).toHaveBeenCalledWith("repo_fixture", {
    taskId: "task_conflict", path: "src/conflict.ts", expectedOperation: "merge", expectedHeadOid: "a".repeat(40), expectedResultRevision: "b".repeat(64),
  }));
  expect(await screen.findByRole("heading", { name: /awaiting review/ })).toBeTruthy();
  expect(screen.getByLabelText("Suggested conflict result").textContent).toContain("merged result");
  expect(screen.getByText(/It has not been applied to the editor/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Save result/ })).toBeNull();
});

it("keeps manual conflict editing available when AI is disabled or the local result has unsaved changes", async () => {
  const api = makeApi();
  api.withSignal = vi.fn(() => api);
  api.getRepositoryWorkflowConflictAiSettings = vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false });
  render(<ConflictSuggestionPanel api={api} file={conflict} hasUnsavedChanges onClose={vi.fn()} />);
  expect(await screen.findByText(/Save or discard your local editor changes/)).toBeTruthy();
  expect(screen.getByText(/Choose an AI provider in Settings/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Request conflict suggestion" })).toHaveProperty("disabled", true);
  expect(api.requestRepositoryWorkflowConflictSuggestion).not.toHaveBeenCalled();
});

it("aborts AI settings lookup when the suggestion panel closes", async () => {
  const pending = deferred<Awaited<ReturnType<GitCrestApiClient["getRepositoryWorkflowConflictAiSettings"]>>>();
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
    getRepositoryWorkflowConflictAiSettings: vi.fn(() => pending.promise),
  };
  const client = api as unknown as GitCrestApiClient;
  const { unmount } = render(<ConflictSuggestionPanel api={client} file={conflict} hasUnsavedChanges={false} onClose={vi.fn()} />);
  await waitFor(() => expect(signals).toHaveLength(1));
  unmount();
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => pending.resolve({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", hasCloudCredential: false }));
});

it("aborts the conflict revision lookup when the suggestion panel closes", async () => {
  const pending = deferred<WorkflowConflictFileResponse>();
  const signals: AbortSignal[] = [];
  let api: Record<string, unknown>;
  api = {
    withSignal: vi.fn((signal: AbortSignal) => {
      signals.push(signal);
      return api;
    }),
    getRepositoryWorkflowConflictAiSettings: vi.fn().mockResolvedValue({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", hasCloudCredential: false }),
    requestRepositoryWorkflowConflictSuggestion: vi.fn().mockResolvedValue({ provider: "ollama", model: "qwen", response: "merged result\n", files: ["src/conflict.ts"] }),
    getRepositoryWorkflowConflictFile: vi.fn(() => pending.promise),
  };
  const client = api as unknown as GitCrestApiClient;
  const { unmount } = render(<ConflictSuggestionPanel api={client} file={conflict} hasUnsavedChanges={false} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /I reviewed the endpoint/ }));
  fireEvent.click(screen.getByRole("button", { name: "Request conflict suggestion" }));
  await waitFor(() => expect(api.getRepositoryWorkflowConflictFile).toHaveBeenCalledWith("repo_fixture", "task_conflict", "src/conflict.ts"));
  expect(signals).toHaveLength(2);
  unmount();
  expect(signals[1]?.aborted).toBe(true);
  await act(async () => pending.resolve(conflict));
});

it("does not start conflict revision lookup when the panel closes while the provider is responding", async () => {
  const pending = deferred<Awaited<ReturnType<GitCrestApiClient["requestRepositoryWorkflowConflictSuggestion"]>>>();
  const api = makeApi(vi.fn(() => pending.promise));
  const { unmount } = render(<ConflictSuggestionPanel api={api} file={conflict} hasUnsavedChanges={false} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /I reviewed the endpoint/ }));
  fireEvent.click(screen.getByRole("button", { name: "Request conflict suggestion" }));
  await waitFor(() => expect(api.requestRepositoryWorkflowConflictSuggestion).toHaveBeenCalled());
  unmount();
  await act(async () => pending.resolve({ provider: "ollama", model: "qwen", response: "merged result\n", files: ["src/conflict.ts"] }));
  expect(api.getRepositoryWorkflowConflictFile).not.toHaveBeenCalled();
});
