// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, PipelineRule } from "../../src/api/client";
import { AutomationsSection } from "../../src/features/pipelines";
import { newPipelineRule } from "../../src/features/pipelines/model/rule-form";

afterEach(cleanup);

const rule = (id: string, name: string, overrides: Partial<PipelineRule> = {}): PipelineRule => ({
  ...newPipelineRule(id),
  name,
  targets: [{ branch: "uat", remote: "origin" }],
  confirmation: "auto",
  ...overrides,
});

function api(existing: PipelineRule[] = [rule("r_01", "Mine")]) {
  return {
    getPipelineAppSettings: vi.fn().mockResolvedValue({ executionMode: "temporaryWorktree", inPlaceDirtyPolicy: "shelve" }),
    getPipelineRepositorySettings: vi.fn().mockResolvedValue({ executionMode: null, inPlaceDirtyPolicy: null, effectiveExecutionMode: "temporaryWorktree", effectiveInPlaceDirtyPolicy: "shelve" }),
    listPipelineRules: vi.fn().mockResolvedValue(existing),
    getRepositoryBranches: vi.fn().mockResolvedValue({ repoId: "repo_a", current: null, detached: false, branches: [] }),
    writePipelineRulesFile: vi.fn().mockResolvedValue({ path: ".gitcrest/pipelines.json", document: { schemaVersion: 1, rules: existing } }),
    importPipelineRules: vi.fn(),
  };
}

const show = (client: ReturnType<typeof api>) => render(<AutomationsSection api={client as unknown as GitCrestApiClient} repoId="repo_a" />);

it("exports the rules to the repository file and says where", async () => {
  const client = api();
  show(client);
  await screen.findByText("Mine");
  fireEvent.click(screen.getByRole("button", { name: "Export to repository" }));
  await waitFor(() => expect(client.writePipelineRulesFile).toHaveBeenCalledWith("repo_a"));
  expect((await screen.findByRole("status")).textContent).toContain(".gitcrest/pipelines.json");
});

it("reviews imported rules first, and saves them only after confirmation", async () => {
  const client = api();
  const imported = [rule("r_02", "Shared", { confirmation: "ask" })];
  client.importPipelineRules
    .mockResolvedValueOnce({ imported, rules: [rule("r_01", "Mine"), ...imported], applied: false })
    .mockResolvedValueOnce({ imported, rules: [rule("r_01", "Mine"), ...imported], applied: true });
  show(client);
  await screen.findByText("Mine");

  fireEvent.click(screen.getByRole("button", { name: "Import from repository" }));
  const review = await screen.findByRole("region", { name: "Review imported rules" });
  expect(within(review).getByText("Shared")).toBeTruthy();
  expect(within(review).getByText(/never runs rules from a repository file by itself/)).toBeTruthy();
  expect(client.importPipelineRules).toHaveBeenCalledTimes(1);
  expect(client.importPipelineRules).toHaveBeenLastCalledWith("repo_a", { apply: false });
  expect(screen.queryByText("Shared", { selector: "strong" })?.closest(".pipelineImportReview")).toBeTruthy();

  fireEvent.click(within(review).getByRole("button", { name: "Import 1 rules" }));
  await waitFor(() => expect(client.importPipelineRules).toHaveBeenLastCalledWith("repo_a", { apply: true }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review imported rules" })).toBeNull());
  expect(screen.getByText("Shared")).toBeTruthy();
  expect(screen.getByText("Imported 1 rules. They ask before they run.")).toBeTruthy();
});

it("can cancel the review without saving anything", async () => {
  const client = api();
  client.importPipelineRules.mockResolvedValue({ imported: [rule("r_02", "Shared", { confirmation: "ask" })], rules: [], applied: false });
  show(client);
  await screen.findByText("Mine");
  fireEvent.click(screen.getByRole("button", { name: "Import from repository" }));
  const review = await screen.findByRole("region", { name: "Review imported rules" });
  fireEvent.click(within(review).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Review imported rules" })).toBeNull());
  expect(client.importPipelineRules).toHaveBeenCalledTimes(1);
});

it("shows import guidance and diagnostic details for a malformed or missing rules file", async () => {
  const client = api();
  client.importPipelineRules.mockRejectedValue(new Error("The rules file is not a valid GitCrest pipelines file."));
  show(client);
  await screen.findByText("Mine");
  fireEvent.click(screen.getByRole("button", { name: "Import from repository" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Could not import the rules file.");
  const disclosure = screen.getByRole("button", { name: "Details" });
  const diagnostic = document.getElementById(disclosure.getAttribute("aria-controls")!);
  expect(diagnostic?.textContent).toContain("The rules file is not a valid GitCrest pipelines file.");
  expect(diagnostic?.hidden).toBe(true);
  fireEvent.click(disclosure);
  expect(diagnostic?.hidden).toBe(false);
  expect(screen.queryByRole("region", { name: "Review imported rules" })).toBeNull();
});

it("will not confirm an import of a file with no rules", async () => {
  const client = api();
  client.importPipelineRules.mockResolvedValue({ imported: [], rules: [rule("r_01", "Mine")], applied: false });
  show(client);
  await screen.findByText("Mine");
  fireEvent.click(screen.getByRole("button", { name: "Import from repository" }));
  expect(await screen.findByText("The file has no rules.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Import 0 rules" }) as HTMLButtonElement).disabled).toBe(true);
});
