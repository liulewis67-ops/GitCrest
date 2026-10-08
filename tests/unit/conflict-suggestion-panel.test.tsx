// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, WorkflowConflictFileResponse } from "../../src/api/client";
import { ConflictSuggestionPanel } from "../../src/features/workflows/ConflictSuggestionPanel";

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
  isText: true,
};

function makeApi(request = vi.fn().mockResolvedValue({ provider: "ollama", model: "qwen", response: "merged result\n", files: ["src/conflict.ts [base/ours/theirs/result]"] })) {
  return {
    getRepositoryWorkflowConflictAiSettings: vi.fn().mockResolvedValue({ provider: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen", hasCloudCredential: false }),
    requestRepositoryWorkflowConflictSuggestion: request,
    getRepositoryWorkflowConflictFile: vi.fn().mockResolvedValue(conflict),
  } as unknown as GitCrestApiClient;
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
  const api = {
    ...makeApi(),
    getRepositoryWorkflowConflictAiSettings: vi.fn().mockResolvedValue({ provider: "none", baseUrl: "", model: "", hasCloudCredential: false }),
  } as unknown as GitCrestApiClient;
  render(<ConflictSuggestionPanel api={api} file={conflict} hasUnsavedChanges onClose={vi.fn()} />);
  expect(await screen.findByText(/Save or discard your local editor changes/)).toBeTruthy();
  expect(screen.getByText(/Choose an AI provider in Settings/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Request conflict suggestion" })).toHaveProperty("disabled", true);
  expect(api.requestRepositoryWorkflowConflictSuggestion).not.toHaveBeenCalled();
});
