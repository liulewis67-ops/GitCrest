// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, PipelineRule, PipelineRunResponse } from "../../src/api/client";
import {
  PipelineRunPickerDialog,
  PipelineWorkspaceFailureDialog,
  currentPipelineSource,
  pipelineRunBlocker,
} from "../../src/features/pipelines";
import {
  EMPTY_PIPELINE_STATE,
  applyPipelineEvent,
  dismissPipelineWorkspaceFailure,
  reducePipelineEvent,
  resetPipelineState,
  usePipelineState,
} from "../../src/features/pipelines/model/pipeline-store";
import { newPipelineRule } from "../../src/features/pipelines/model/rule-form";

beforeEach(resetPipelineState);
afterEach(cleanup);

const rule = (overrides: Partial<PipelineRule> = {}): PipelineRule => ({
  ...newPipelineRule("r_01"),
  name: "Promote",
  targets: [{ branch: "uat", remote: "origin" }, { branch: "main", remote: "origin" }],
  ...overrides,
});

it("explains why a branch cannot run a pipeline yet", () => {
  expect(pipelineRunBlocker({ upstream: null, ahead: null })).toBe("noUpstream");
  expect(pipelineRunBlocker({ upstream: "origin/f", ahead: 0, upstreamGone: true })).toBe("noUpstream");
  expect(pipelineRunBlocker({ upstream: "origin/f", ahead: 2 })).toBe("unpushed");
  expect(pipelineRunBlocker({ upstream: "origin/f", ahead: null })).toBe("unpushed");
  expect(pipelineRunBlocker({ upstream: "origin/f", ahead: 0 })).toBeUndefined();
});

it("takes the current local branch as the pipeline source", () => {
  const branch = (over: Record<string, unknown>) => ({ kind: "local", isCurrent: false, name: "x", oid: "a".repeat(40), upstream: "origin/x", ahead: 0, ...over });
  expect(currentPipelineSource(undefined)).toBeUndefined();
  expect(currentPipelineSource({ branches: [branch({})] })).toBeUndefined();
  expect(currentPipelineSource({ branches: [branch({ isCurrent: true, name: "feature/1" })] })).toEqual({ branch: "feature/1", oid: "a".repeat(40) });
  expect(currentPipelineSource({ branches: [branch({ isCurrent: true, name: "feature/1", ahead: 3 })] })).toEqual({ branch: "feature/1", oid: "a".repeat(40), blocker: "unpushed" });
  expect(currentPipelineSource({ branches: [branch({ isCurrent: true, kind: "remote" })] })).toBeUndefined();
});

function pickerApi(rules: PipelineRule[]) {
  return {
    listPipelineRules: vi.fn().mockResolvedValue(rules),
    startPipelineRun: vi.fn().mockResolvedValue({}),
  };
}

const source = { branch: "feature/1", oid: "b".repeat(40) };

it("runs the chosen rule for the branch's pushed commit with the checked targets", async () => {
  const api = pickerApi([rule(), rule({ ruleId: "r_02", name: "Disabled", enabled: false })]);
  const onClose = vi.fn();
  render(<PipelineRunPickerDialog api={api as unknown as GitCrestApiClient} repoId="repo_a" source={source} onClose={onClose} />);
  expect(await screen.findByRole("dialog", { name: "Run a pipeline for feature/1" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: "Disabled" })).toBeNull();
  expect(screen.getByText("protected branch")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(api.startPipelineRun).toHaveBeenCalledWith("repo_a", { ruleId: "r_01", sourceBranch: "feature/1", sourceOid: source.oid }));
  expect(onClose).toHaveBeenCalled();
});

it("can run a subset of the targets", async () => {
  const api = pickerApi([rule()]);
  render(<PipelineRunPickerDialog api={api as unknown as GitCrestApiClient} repoId="repo_a" source={source} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /main/ }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(api.startPipelineRun).toHaveBeenCalledWith("repo_a", { ruleId: "r_01", sourceBranch: "feature/1", sourceOid: source.oid, targets: ["uat"] }));
});

it("says so when there is no enabled rule and shows the core's message when starting fails", async () => {
  const empty = pickerApi([]);
  const { unmount } = render(<PipelineRunPickerDialog api={empty as unknown as GitCrestApiClient} repoId="repo_a" source={source} onClose={vi.fn()} />);
  expect(await screen.findByText(/no enabled rule yet/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
  unmount();

  const failing = pickerApi([rule()]);
  failing.startPipelineRun.mockRejectedValue(new Error("Another pipeline run of this repository is in progress."));
  render(<PipelineRunPickerDialog api={failing as unknown as GitCrestApiClient} repoId="repo_a" source={source} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Another pipeline run of this repository is in progress.");
});

function failedRun(overrides: Partial<PipelineRunResponse> = {}): PipelineRunResponse {
  return {
    runId: "run_1", repoId: "repo_a", ruleId: "r_01", ruleName: "Promote", sourceBranch: "feature/1", sourceOid: "a".repeat(40),
    executionMode: "temporaryWorktree", status: "failed", shelfId: null, createdAtMs: 1, updatedAtMs: 2, recovery: null, shelfPending: false,
    steps: [{ position: 0, targetBranch: "uat", remote: "origin", state: "failed", leaseOid: null, mergeOid: null, repoContext: null, message: "Pipeline worktree unavailable: the folder could not be created", workspaceFailed: true }],
    ...overrides,
  };
}

const event = (run: PipelineRunResponse) => ({ type: "pipeline.run.updated", repoId: "repo_a", payload: run }) as Parameters<typeof reducePipelineEvent>[1];

it("remembers a worktree failure once and does not ask again after it was answered", () => {
  const first = reducePipelineEvent(EMPTY_PIPELINE_STATE, event(failedRun()));
  expect(first.workspaceFailures).toEqual([{ runId: "run_1", repoId: "repo_a", ruleId: "r_01", sourceBranch: "feature/1", sourceOid: "a".repeat(40), message: "Pipeline worktree unavailable: the folder could not be created" }]);
  expect(reducePipelineEvent(first, event(failedRun({ updatedAtMs: 9 }))).workspaceFailures).toHaveLength(1);

  applyPipelineEvent(event(failedRun()));
  dismissPipelineWorkspaceFailure("run_1");
  function Probe() {
    return <p data-testid="count">{usePipelineState().workspaceFailures.length}</p>;
  }
  render(<Probe />);
  act(() => { applyPipelineEvent(event(failedRun({ updatedAtMs: 10 }))); });
  expect(screen.getByTestId("count").textContent).toBe("0");

  const ordinary = failedRun({ runId: "run_2", steps: [{ ...failedRun().steps[0], workspaceFailed: false }] });
  expect(reducePipelineEvent(EMPTY_PIPELINE_STATE, event(ordinary)).workspaceFailures).toEqual([]);
  const inPlace = failedRun({ runId: "run_3", executionMode: "switchInPlace" });
  expect(reducePipelineEvent(EMPTY_PIPELINE_STATE, event(inPlace)).workspaceFailures).toEqual([]);
});

function failureApi() {
  return {
    getPipelineRepositorySettings: vi.fn().mockResolvedValue({ executionMode: null, inPlaceDirtyPolicy: "refuse" }),
    setPipelineRepositorySettings: vi.fn().mockResolvedValue({}),
    startPipelineRun: vi.fn().mockResolvedValue({}),
  };
}

function FailureHost({ client }: { client: ReturnType<typeof failureApi> }) {
  const first = usePipelineState().workspaceFailures[0];
  return first ? <PipelineWorkspaceFailureDialog api={client as unknown as GitCrestApiClient} failure={first} /> : <p>closed</p>;
}

it("offers to run in place this time without changing the repository setting", async () => {
  const client = failureApi();
  applyPipelineEvent(event(failedRun()));
  render(<FailureHost client={client} />);
  expect(screen.getByText(/Pipeline worktree unavailable/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Run in place this time" }));
  await waitFor(() => expect(client.startPipelineRun).toHaveBeenCalledWith("repo_a", { ruleId: "r_01", sourceBranch: "feature/1", sourceOid: "a".repeat(40), executionMode: "switchInPlace" }));
  expect(client.setPipelineRepositorySettings).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
});

it("can switch the repository to in place for good, keeping its dirty-work choice", async () => {
  const client = failureApi();
  applyPipelineEvent(event(failedRun()));
  render(<FailureHost client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "Always use in place for this repository" }));
  await waitFor(() => expect(client.setPipelineRepositorySettings).toHaveBeenCalledWith("repo_a", { executionMode: "switchInPlace", inPlaceDirtyPolicy: "refuse" }));
  await waitFor(() => expect(client.startPipelineRun).toHaveBeenCalled());
});

it("does nothing on Cancel, and never starts a run on its own", async () => {
  const client = failureApi();
  applyPipelineEvent(event(failedRun()));
  render(<FailureHost client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
  expect(client.startPipelineRun).not.toHaveBeenCalled();
  expect(client.setPipelineRepositorySettings).not.toHaveBeenCalled();
});
