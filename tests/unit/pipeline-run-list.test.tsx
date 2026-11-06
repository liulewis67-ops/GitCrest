// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, PipelineRunResponse } from "../../src/api/client";
import { PipelineRunList } from "../../src/features/pipelines";
import { applyPipelineEvent, resetPipelineState } from "../../src/features/pipelines/model/pipeline-store";

beforeEach(resetPipelineState);
afterEach(cleanup);

function run(overrides: Partial<PipelineRunResponse> = {}): PipelineRunResponse {
  return {
    runId: "run_1", repoId: "repo_a", ruleId: "r_01", ruleName: "Promote", sourceBranch: "feature/1", sourceOid: "a".repeat(40),
    executionMode: "temporaryWorktree", status: "running", shelfId: null, createdAtMs: 1, updatedAtMs: 2, recovery: null, shelfPending: false,
    steps: [
      { position: 0, targetBranch: "uat", remote: "origin", state: "done", leaseOid: null, mergeOid: null, repoContext: null, message: null, workspaceFailed: false },
      { position: 1, targetBranch: "dev", remote: "origin", state: "merging", leaseOid: null, mergeOid: null, repoContext: null, message: null, workspaceFailed: false },
    ],
    ...overrides,
  };
}

function api(runs: PipelineRunResponse[] = []) {
  return {
    listPipelineRuns: vi.fn().mockResolvedValue(runs),
    actOnPipelineRun: vi.fn().mockResolvedValue(run()),
    startPipelineRun: vi.fn().mockResolvedValue(run()),
  };
}

const show = (client: ReturnType<typeof api>, onOpenConflicts = vi.fn()) =>
  render(<PipelineRunList api={client as unknown as GitCrestApiClient} repoId="repo_a" onOpenConflicts={onOpenConflicts} />);

it("loads the repository's runs and shows the chain of targets", async () => {
  show(api([run(), run({ runId: "other", repoId: "repo_b", ruleName: "Elsewhere" })]));
  const row = await screen.findByRole("article", { name: "Promote" });
  expect(within(row).getByText("feature/1 → uat ✓ → dev …")).toBeTruthy();
  expect(within(row).getByText("running")).toBeTruthy();
  expect(screen.queryByRole("article", { name: "Elsewhere" })).toBeNull();
});

it("renders nothing while there are no runs", async () => {
  const client = api();
  const { container } = show(client);
  await waitFor(() => expect(client.listPipelineRuns).toHaveBeenCalledWith("repo_a"));
  expect(container.textContent).toBe("");
});

it("follows run updates from events", async () => {
  show(api([run()]));
  await screen.findByRole("article", { name: "Promote" });
  applyPipelineEvent({ type: "pipeline.run.updated", repoId: "repo_a", payload: run({ status: "succeeded", steps: run().steps.map((step) => ({ ...step, state: "done" as const })) }) } as Parameters<typeof applyPipelineEvent>[0]);
  expect(await screen.findByText("feature/1 → uat ✓ → dev ✓")).toBeTruthy();
  expect(screen.getByText("done")).toBeTruthy();
});

it("offers to resolve, skip or stop a run waiting for conflicts", async () => {
  const client = api([run({
    status: "waitingForConflicts",
    steps: [{ position: 0, targetBranch: "uat", remote: "origin", state: "waitingForConflicts", leaseOid: null, mergeOid: null, repoContext: "repo_hidden", message: null, workspaceFailed: false }],
  })]);
  const onOpenConflicts = vi.fn();
  show(client, onOpenConflicts);
  const row = await screen.findByRole("article", { name: "Promote" });

  fireEvent.click(within(row).getByRole("button", { name: "Resolve conflicts" }));
  expect(onOpenConflicts).toHaveBeenCalledWith("repo_hidden");
  fireEvent.click(within(row).getByRole("button", { name: "Skip target" }));
  await waitFor(() => expect(client.actOnPipelineRun).toHaveBeenCalledWith("repo_a", "run_1", "skipTarget"));
  fireEvent.click(within(row).getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(client.actOnPipelineRun).toHaveBeenCalledWith("repo_a", "run_1", "stop"));
});

it("confirms a queued run", async () => {
  const client = api([run({ status: "pendingConfirmation" })]);
  show(client);
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  await waitFor(() => expect(client.actOnPipelineRun).toHaveBeenCalledWith("repo_a", "run_1", "resume"));
});

it.each([
  ["resumePush", "Push the merge", "resume", "Discard", "discard"],
  ["restartStep", "Run this operation again", "resume", "Discard", "discard"],
  ["returnToSource", "Return to feature/1", "returnToSource", "Stay here", "discard"],
] as const)("offers the %s choice for an interrupted run", async (recovery, primary, primaryAction, secondary, secondaryAction) => {
  const client = api([run({ status: "interrupted", recovery })]);
  show(client);
  fireEvent.click(await screen.findByRole("button", { name: primary }));
  await waitFor(() => expect(client.actOnPipelineRun).toHaveBeenCalledWith("repo_a", "run_1", primaryAction));
  fireEvent.click(screen.getByRole("button", { name: secondary }));
  await waitFor(() => expect(client.actOnPipelineRun).toHaveBeenLastCalledWith("repo_a", "run_1", secondaryAction));
});

it("runs a failed run again from its commit and keeps failure diagnostics in Details", async () => {
  const client = api([run({ status: "failed" })]);
  client.startPipelineRun.mockRejectedValueOnce(new Error("Another pipeline run of this repository is in progress."));
  show(client);
  fireEvent.click(await screen.findByRole("button", { name: "Run again" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The Hook could not apply that choice.");
  const disclosure = screen.getByRole("button", { name: "Details" });
  const diagnostic = document.getElementById(disclosure.getAttribute("aria-controls")!);
  expect(diagnostic?.textContent).toContain("Another pipeline run of this repository is in progress.");
  expect(diagnostic?.hidden).toBe(true);
  fireEvent.click(disclosure);
  expect(diagnostic?.hidden).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Run again" }));
  await waitFor(() => expect(client.startPipelineRun).toHaveBeenLastCalledWith("repo_a", { ruleId: "r_01", sourceBranch: "feature/1", sourceOid: "a".repeat(40) }));
});

it("offers cleanup and stop without replay or discard actions when cleanup is pending", async () => {
  const pending = run({ status: "interrupted", recovery: "cleanupRequired" });
  pending.steps[0].state = "cleanupRequired";
  pending.steps[0].message = "Returning to the source branch failed";
  const client = api([pending]);
  client.actOnPipelineRun.mockResolvedValue(pending);
  show(client);
  fireEvent.click(await screen.findByRole("button", { name: "Clean up and stop" }));
  await waitFor(() => expect(client.actOnPipelineRun).toHaveBeenCalledWith("repo_a", "run_1", "returnToSource"));
  expect(screen.queryByRole("button", { name: "Run this operation again" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Push the merge" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
});

it("does not offer Run again for a finished-successfully or active run", async () => {
  show(api([run({ status: "succeeded" })]));
  await screen.findByRole("article", { name: "Promote" });
  expect(screen.queryByRole("button", { name: "Run again" })).toBeNull();
});

it("warns when the changes set aside for a run are still in the stash list", async () => {
  show(api([run({ status: "cancelled", shelfPending: true })]));
  expect((await screen.findByRole("note")).textContent).toContain("git stash pop");
});
