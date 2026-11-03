// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, PipelineRunResponse } from "../../src/api/client";
import { InPlacePipelineBanner, PipelineConflictAbortedDialog } from "../../src/features/pipelines";
import {
  EMPTY_PIPELINE_STATE,
  applyPipelineEvent,
  inPlacePipelineState,
  reducePipelineEvent,
  replacePipelineRuns,
  resetPipelineState,
  usePipelineState,
} from "../../src/features/pipelines/model/pipeline-store";

beforeEach(resetPipelineState);
afterEach(cleanup);

function run(overrides: Partial<PipelineRunResponse> = {}): PipelineRunResponse {
  return {
    runId: "run_1", repoId: "repo_a", ruleId: "r1", ruleName: "Promote", sourceBranch: "feature/1", sourceOid: "a".repeat(40),
    executionMode: "temporaryWorktree", status: "running", shelfId: null, createdAtMs: 1, updatedAtMs: 2, recovery: null, shelfPending: false,
    steps: [{ position: 0, targetBranch: "uat", remote: "origin", state: "preparing", leaseOid: null, mergeOid: null, repoContext: null, message: null, workspaceFailed: false }],
    ...overrides,
  };
}

const event = (type: string, payload: Record<string, unknown>, repoId = "repo_a") => ({ type, repoId, payload }) as Parameters<typeof reducePipelineEvent>[1];

it("keeps the newest snapshot of each run and ignores unrelated events", () => {
  const first = reducePipelineEvent(EMPTY_PIPELINE_STATE, event("pipeline.run.updated", run()));
  const second = reducePipelineEvent(first, event("pipeline.run.updated", run({ status: "succeeded", updatedAtMs: 5 })));
  expect(Object.keys(second.runs)).toEqual(["run_1"]);
  expect(second.runs.run_1.status).toBe("succeeded");
  expect(reducePipelineEvent(second, event("status.changed", {}))).toBe(second);
  expect(reducePipelineEvent(second, event("pipeline.run.updated", { runId: "x" }))).toBe(second);
});

it("tracks trigger prompts until the run leaves pendingConfirmation", () => {
  const pending = reducePipelineEvent(EMPTY_PIPELINE_STATE, event("pipeline.trigger.pending", {
    runId: "run_1", ruleId: "r1", ruleName: "Promote", sourceBranch: "feature/1", targets: ["uat", "dev"], protectedTarget: true,
  }));
  expect(pending.triggers).toEqual([{ runId: "run_1", repoId: "repo_a", ruleId: "r1", ruleName: "Promote", sourceBranch: "feature/1", targets: ["uat", "dev"], protectedTarget: true }]);
  const stillPending = reducePipelineEvent(pending, event("pipeline.run.updated", run({ status: "pendingConfirmation" })));
  expect(stillPending.triggers).toHaveLength(1);
  const started = reducePipelineEvent(stillPending, event("pipeline.run.updated", run({ status: "running" })));
  expect(started.triggers).toEqual([]);
  expect(reducePipelineEvent(EMPTY_PIPELINE_STATE, event("pipeline.trigger.pending", { runId: "run_1", targets: [] }))).toBe(EMPTY_PIPELINE_STATE);
});

it("tracks aborted-conflict prompts until the run stops waiting", () => {
  const aborted = reducePipelineEvent(EMPTY_PIPELINE_STATE, event("pipeline.conflict.aborted", { runId: "run_1", position: 0, targetBranch: "uat" }));
  expect(aborted.aborted).toEqual([{ runId: "run_1", repoId: "repo_a", position: 0, targetBranch: "uat" }]);
  const waiting = reducePipelineEvent(aborted, event("pipeline.run.updated", run({ status: "waitingForConflicts" })));
  expect(waiting.aborted).toHaveLength(1);
  expect(reducePipelineEvent(waiting, event("pipeline.run.updated", run({ status: "running" }))).aborted).toEqual([]);
});

it("replaces only the runs of the given repository", () => {
  applyPipelineEvent(event("pipeline.run.updated", run({ runId: "a1", repoId: "repo_a" })));
  applyPipelineEvent(event("pipeline.run.updated", run({ runId: "b1", repoId: "repo_b" }), "repo_b"));
  replacePipelineRuns("repo_a", [run({ runId: "a2", repoId: "repo_a" })]);
  function Probe() {
    const state = usePipelineState();
    return <p data-testid="runs">{Object.keys(state.runs).sort().join(",")}</p>;
  }
  render(<Probe />);
  expect(screen.getByTestId("runs").textContent).toBe("a2,b1");
});

it("asks to skip the target or stop the run and sends the choice", async () => {
  applyPipelineEvent(event("pipeline.conflict.aborted", { runId: "run_1", position: 0, targetBranch: "uat" }));
  const actOnPipelineRun = vi.fn().mockResolvedValue(run({ status: "running" }));
  const api = { actOnPipelineRun } as unknown as GitCrestApiClient;
  function Host() {
    const prompt = usePipelineState().aborted[0];
    return prompt ? <PipelineConflictAbortedDialog api={api} prompt={prompt} /> : <p>closed</p>;
  }
  render(<Host />);
  expect(screen.getByRole("dialog", { name: "The merge into uat was aborted" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Skip this target" }));
  await waitFor(() => expect(actOnPipelineRun).toHaveBeenCalledWith("repo_a", "run_1", "skipTarget"));
  await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
});

it("keeps the dialog open and shows the error when the choice fails", async () => {
  applyPipelineEvent(event("pipeline.conflict.aborted", { runId: "run_1", position: 0, targetBranch: "uat" }));
  const api = { actOnPipelineRun: vi.fn().mockRejectedValue(new Error("not allowed now")) } as unknown as GitCrestApiClient;
  function Host() {
    const prompt = usePipelineState().aborted[0];
    return prompt ? <PipelineConflictAbortedDialog api={api} prompt={prompt} /> : null;
  }
  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "Stop the Hook" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The Hook could not apply that choice.");
  const disclosure = screen.getByRole("button", { name: "Details" });
  const diagnostic = document.getElementById(disclosure.getAttribute("aria-controls")!);
  expect(diagnostic?.textContent).toContain("not allowed now");
  expect(diagnostic?.hidden).toBe(true);
  fireEvent.click(disclosure);
  expect(diagnostic?.hidden).toBe(false);
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Decide later" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("reports what a switch-in-place run does to the working tree, strongest state first", () => {
  const inPlace = (status: PipelineRunResponse["status"], runId: string, repoId = "repo_a") =>
    run({ runId, repoId, status, executionMode: "switchInPlace" });
  const stateWith = (...runs: PipelineRunResponse[]) => ({ ...EMPTY_PIPELINE_STATE, runs: Object.fromEntries(runs.map((r) => [r.runId, r])) });

  expect(inPlacePipelineState(EMPTY_PIPELINE_STATE, "repo_a")).toBeUndefined();
  expect(inPlacePipelineState(stateWith(inPlace("running", "a")), undefined)).toBeUndefined();
  expect(inPlacePipelineState(stateWith(inPlace("running", "a")), "repo_a")).toBe("running");
  expect(inPlacePipelineState(stateWith(inPlace("interrupted", "a"), inPlace("waitingForConflicts", "b")), "repo_a")).toBe("waitingForConflicts");
  expect(inPlacePipelineState(stateWith(inPlace("interrupted", "a")), "repo_a")).toBe("interrupted");
  expect(inPlacePipelineState(stateWith(inPlace("succeeded", "a"), inPlace("pendingConfirmation", "b")), "repo_a")).toBeUndefined();
  expect(inPlacePipelineState(stateWith(inPlace("running", "a", "repo_b")), "repo_a")).toBeUndefined();
  expect(inPlacePipelineState(stateWith(run({ status: "running", executionMode: "temporaryWorktree" })), "repo_a")).toBeUndefined();
});

it("shows a banner only while a switch-in-place run holds or waits on the working tree", () => {
  render(<InPlacePipelineBanner repoId="repo_a" />);
  expect(screen.queryByRole("status")).toBeNull();
  act(() => { applyPipelineEvent(event("pipeline.run.updated", run({ executionMode: "switchInPlace", status: "running" }))); });
  expect(screen.getByRole("status").textContent).toContain("branch operations are paused");
  cleanup();
  render(<InPlacePipelineBanner repoId="repo_a" />);
  act(() => { applyPipelineEvent(event("pipeline.run.updated", run({ executionMode: "switchInPlace", status: "waitingForConflicts" }))); });
  expect(screen.getByRole("status").textContent).toContain("resolve the conflicts");
  act(() => { applyPipelineEvent(event("pipeline.run.updated", run({ executionMode: "switchInPlace", status: "succeeded" }))); });
  expect(screen.queryByRole("status")).toBeNull();
});


it("pauses branch operations for root commands even when merge mode is a temporary worktree", () => {
  const commandRun = run();
  commandRun.steps[0].remote = "";
  const state = { ...EMPTY_PIPELINE_STATE, runs: { run_1: commandRun } };
  expect(inPlacePipelineState(state, "repo_a")).toBe("running");
});
