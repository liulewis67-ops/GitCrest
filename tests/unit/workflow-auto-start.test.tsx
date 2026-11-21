// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, WorkflowPreflightResponse } from "../../src/api/client";
import { WorkflowDialog } from "../../src/features/workflows/ui/WorkflowDialog";

afterEach(cleanup);
const preview: WorkflowPreflightResponse = { repoId: "repo", action: "merge", headOid: "a".repeat(40), targetOid: "b".repeat(40), targetSubject: "Target", operationInProgress: null, isClean: true, dirtyPaths: [], omittedDirtyPathCount: 0, conflictedPaths: [], omittedConflictedPathCount: 0, canStart: true, mergeKind: "mergeCommit", incomingCommitCount: 1 };
function setup(snapshot = preview) {
  const api = { preflightRepositoryWorkflow: vi.fn().mockResolvedValue(snapshot), startRepositoryWorkflow: vi.fn().mockResolvedValue({ taskId: "workflow" }), withSignal: (_signal: AbortSignal) => api };
  const onStarted = vi.fn(); const onClose = vi.fn();
  const props = { api: api as unknown as GitCrestApiClient, repoId: "repo", action: snapshot.action, targetOid: snapshot.targetOid, autoStart: true, onStarted, onClose };
  return { api, onStarted, onClose, props };
}

it.each(["merge", "cherryPick", "revert"] as const)("starts a clean %s with no dialog and only once under Strict Mode", async (action) => {
  const current = setup({ ...preview, action, mergeKind: action === "merge" ? "mergeCommit" : null });
  render(<StrictMode><WorkflowDialog {...current.props} /></StrictMode>);
  expect(screen.queryByRole("dialog")).toBeNull();
  await waitFor(() => expect(current.onStarted).toHaveBeenCalledOnce());
  expect(current.api.startRepositoryWorkflow).toHaveBeenCalledExactlyOnceWith("repo", { action, targetOid: preview.targetOid, expectedHeadOid: preview.headOid });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows review when a workflow needs local-change handling", async () => {
  const current = setup({ ...preview, isClean: false, dirtyPaths: ["draft.txt"] });
  render(<WorkflowDialog {...current.props} />);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(current.api.startRepositoryWorkflow).not.toHaveBeenCalled();
});

it("closes an up-to-date merge without asking or submitting a task", async () => {
  const current = setup({ ...preview, canStart: false, mergeKind: "upToDate" });
  render(<WorkflowDialog {...current.props} />);
  await waitFor(() => expect(current.onClose).toHaveBeenCalledOnce());
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(current.api.startRepositoryWorkflow).not.toHaveBeenCalled();
});

it("shows a submission error and does not retry the mutation on a preview refresh", async () => {
  const current = setup();
  current.api.startRepositoryWorkflow.mockRejectedValueOnce(new Error("Response lost"));
  render(<WorkflowDialog {...current.props} />);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  await waitFor(() => expect(current.api.preflightRepositoryWorkflow).toHaveBeenCalledTimes(2));
  expect(current.api.startRepositoryWorkflow).toHaveBeenCalledOnce();
});

it("does not start a superseded target after its preflight resolves", async () => {
  const current = setup();
  let resolve!: (value: WorkflowPreflightResponse) => void;
  current.api.preflightRepositoryWorkflow.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  const view = render(<WorkflowDialog {...current.props} />);
  const targetOid = "c".repeat(40);
  view.rerender(<WorkflowDialog {...current.props} targetOid={targetOid} />);
  await waitFor(() => expect(current.onStarted).toHaveBeenCalledOnce());
  await act(async () => resolve(preview));
  expect(current.api.startRepositoryWorkflow).toHaveBeenCalledExactlyOnceWith("repo", { action: "merge", targetOid, expectedHeadOid: preview.headOid });
});
