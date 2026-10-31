// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { PipelineTriggerDialog } from "../../src/features/pipelines";
import { applyPipelineEvent, resetPipelineState, usePipelineState, type PipelineTriggerPrompt } from "../../src/features/pipelines/model/pipeline-store";

beforeEach(resetPipelineState);
afterEach(cleanup);

const prompt: PipelineTriggerPrompt = {
  runId: "run_1", repoId: "repo_a", ruleId: "r_01", ruleName: "Promote", sourceBranch: "feature/1", targets: ["uat", "dev"], protectedTarget: false,
};

function api(overrides: Record<string, unknown> = {}) {
  return {
    getPipelineRepositorySettings: vi.fn().mockResolvedValue({ effectiveExecutionMode: "temporaryWorktree" }),
    listPipelineRules: vi.fn().mockResolvedValue([{ ruleId: "r_01", confirmation: "ask" }, { ruleId: "r_02", confirmation: "ask" }]),
    replacePipelineRules: vi.fn().mockResolvedValue([]),
    startPipelineRun: vi.fn().mockResolvedValue({}),
    ...overrides,
  };
}

function Host({ client }: { client: ReturnType<typeof api> }) {
  const trigger = usePipelineState().triggers[0];
  return trigger ? <PipelineTriggerDialog api={client as unknown as GitCrestApiClient} prompt={trigger} /> : <p>closed</p>;
}

function announce() {
  applyPipelineEvent({ type: "pipeline.trigger.pending", repoId: "repo_a", payload: { runId: prompt.runId, ruleId: prompt.ruleId, ruleName: prompt.ruleName, sourceBranch: prompt.sourceBranch, targets: prompt.targets, protectedTarget: false } } as Parameters<typeof applyPipelineEvent>[0]);
}

it("lists the targets and the execution mode, and runs them all", async () => {
  const client = api();
  announce();
  render(<Host client={client} />);
  expect(screen.getByRole("dialog", { name: "Merge feature/1 into integration branches?" })).toBeTruthy();
  expect(await screen.findByText(/temporary worktree; your working tree stays/)).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(client.startPipelineRun).toHaveBeenCalledWith("repo_a", { runId: "run_1" }));
  await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
  expect(client.replacePipelineRules).not.toHaveBeenCalled();
});

it("runs only the checked targets", async () => {
  const client = api();
  announce();
  render(<Host client={client} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "uat" }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(client.startPipelineRun).toHaveBeenCalledWith("repo_a", { runId: "run_1", targets: ["dev"] }));
});

it("cannot run with nothing selected", () => {
  announce();
  render(<Host client={api()} />);
  fireEvent.click(screen.getByRole("checkbox", { name: "uat" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "dev" }));
  expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
});

it("can stop asking for this rule before running", async () => {
  const client = api();
  announce();
  render(<Host client={client} />);
  fireEvent.click(screen.getByRole("checkbox", { name: /ask again/ }));
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  await waitFor(() => expect(client.replacePipelineRules).toHaveBeenCalledWith("repo_a", [{ ruleId: "r_01", confirmation: "auto" }, { ruleId: "r_02", confirmation: "ask" }]));
  expect(client.startPipelineRun).toHaveBeenCalled();
});

it("does not offer to stop asking when a target is protected", () => {
  const protectedPrompt = { ...prompt, targets: ["main", "dev"], protectedTarget: true };
  applyPipelineEvent({ type: "pipeline.trigger.pending", repoId: "repo_a", payload: { ...protectedPrompt } } as Parameters<typeof applyPipelineEvent>[0]);
  render(<Host client={api()} />);
  expect(screen.queryByRole("checkbox", { name: /ask again/ })).toBeNull();
  expect(screen.getByText("protected branch")).toBeTruthy();
});

it("leaves the run queued on Not now and shows the core's message when starting fails", async () => {
  const client = api({ startPipelineRun: vi.fn().mockRejectedValue(new Error("Another pipeline run of this repository is in progress.")) });
  announce();
  render(<Host client={client} />);
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Another pipeline run of this repository is in progress.");
  fireEvent.click(screen.getByRole("button", { name: "Not now" }));
  await waitFor(() => expect(screen.getByText("closed")).toBeTruthy());
  expect(client.replacePipelineRules).not.toHaveBeenCalled();
});
