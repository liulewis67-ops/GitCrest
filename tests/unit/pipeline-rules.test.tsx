// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, PipelineRule } from "../../src/api/client";
import { AutomationsSection } from "../../src/features/pipelines";
import {
  effectiveConfirmation,
  globMatch,
  moveItem,
  newPipelineRule,
  nextRuleId,
  renderCommitMessage,
  splitRemoteBranch,
  validateRule,
} from "../../src/features/pipelines/model/rule-form";
import { PipelineRuleEditor } from "../../src/features/pipelines/ui/PipelineRuleEditor";

afterEach(cleanup);

function rule(overrides: Partial<PipelineRule> = {}): PipelineRule {
  return {
    ...newPipelineRule("r_01"),
    name: "Promote",
    targets: [{ branch: "uat", remote: "origin" }, { branch: "dev", remote: "origin" }],
    confirmation: "auto",
    ...overrides,
  };
}

it("matches branch patterns like the core: * stays in one segment, ** crosses", () => {
  expect(globMatch("feature/*", "feature/1")).toBe(true);
  expect(globMatch("feature/*", "feature/a/b")).toBe(false);
  expect(globMatch("feature/**", "feature/a/b")).toBe(true);
  expect(globMatch("fix-?", "fix-1")).toBe(true);
  expect(globMatch("fix-?", "fix-/")).toBe(false);
  expect(globMatch("*", "uat")).toBe(true);
  expect(globMatch("feature/*", "uat")).toBe(false);
});

it("validates the same rules as the core", () => {
  expect(validateRule(rule())).toBeUndefined();
  expect(validateRule(rule({ name: " " }))).toEqual({ code: "name" });
  expect(validateRule(rule({ trigger: { kind: "afterPush", branchPattern: "" } }))).toEqual({ code: "pattern" });
  expect(validateRule(rule({ targets: [] }))).toEqual({ code: "noTargets" });
  expect(validateRule(rule({ targets: [{ branch: "", remote: "origin" }] }))).toEqual({ code: "emptyTarget" });
  expect(validateRule(rule({ targets: [{ branch: "uat", remote: "origin" }, { branch: "uat", remote: "origin" }] }))).toEqual({ code: "duplicateTarget", branch: "uat" });
  expect(validateRule(rule({ targets: [{ branch: "feature/x", remote: "origin" }] }))).toEqual({ code: "targetMatchesTrigger", branch: "feature/x" });
  expect(validateRule(rule({ commitMessageTemplate: "Merge {branch}" }))).toEqual({ code: "unknownPlaceholder", name: "branch" });
  for (const bad of ["Merge {source", "Merge source}", "Merge {{source}}"]) {
    expect(validateRule(rule({ commitMessageTemplate: bad }))).toEqual({ code: "unbalancedTemplate" });
  }
  expect(validateRule(rule(), [rule()])).toEqual({ code: "duplicateRuleId" });
});

it("renders commit messages, forces protected targets to ask and helps with ids and ordering", () => {
  expect(renderCommitMessage("Merge branch '{source}' into {target}", "feature/1", "uat")).toBe("Merge branch 'feature/1' into uat");
  expect(renderCommitMessage("{sourceShortOid}", "s", "t", "0123456789")).toBe("0123456");
  expect(effectiveConfirmation(rule())).toBe("auto");
  for (const branch of ["main", "master", "release/1.0", "production"]) {
    expect(effectiveConfirmation(rule({ targets: [{ branch, remote: "origin" }] }))).toBe("ask");
  }
  expect(nextRuleId([rule()])).toBe("r_02");
  expect(nextRuleId([rule({ ruleId: "r_02" })])).toBe("r_03");
  expect(splitRemoteBranch("refs/remotes/origin/feature/a")).toEqual({ remote: "origin", branch: "feature/a" });
  expect(splitRemoteBranch("refs/remotes/origin/HEAD")).toBeUndefined();
  expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
  expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
});

const remoteBranches = [{ remote: "origin", branch: "uat" }, { remote: "origin", branch: "dev" }, { remote: "origin", branch: "main" }];

it("previews matches and the message, and saves only a valid rule", () => {
  const onSave = vi.fn();
  render(<PipelineRuleEditor rule={newPipelineRule("r_01")} otherRules={[]} localBranches={["feature/1", "feature/login", "bugfix/2"]} remoteBranches={remoteBranches} onSave={onSave} onCancel={vi.fn()} />);
  const save = screen.getByRole("button", { name: "Save rule" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status", { name: "" }).textContent).toContain("Matches: feature/1, feature/login");

  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Promote" } });
  fireEvent.change(screen.getByLabelText("Choose a remote branch"), { target: { value: "origin/uat" } });
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  expect(screen.getByText("Preview: Merge branch 'feature/1' into uat")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Merge commit message"), { target: { value: "Promote {source} to {target}" } });
  expect(screen.getByText("Preview: Promote feature/1 to uat")).toBeTruthy();

  expect((save as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(save);
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
    name: "Promote",
    targets: [{ branch: "uat", remote: "origin" }],
    commitMessageTemplate: "Promote {source} to {target}",
    confirmation: "ask",
  }));
});

it("explains validation problems and the forced confirmation for protected targets", () => {
  const onSave = vi.fn();
  render(<PipelineRuleEditor rule={rule({ targets: [] })} otherRules={[]} localBranches={[]} remoteBranches={remoteBranches} onSave={onSave} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Merge commit message"), { target: { value: "Merge {oops}" } });
  expect(screen.getByRole("alert").textContent).toBe("Add at least one target branch.");

  fireEvent.change(screen.getByLabelText("Choose a remote branch"), { target: { value: "origin/main" } });
  fireEvent.click(screen.getByRole("button", { name: "Add target" }));
  expect(screen.getByRole("alert").textContent).toBe("The message uses an unknown placeholder {oops}.");
  expect(screen.getByRole("note").textContent).toContain("main looks protected");
  const confirmation = screen.getByLabelText("Before running") as HTMLSelectElement;
  expect(confirmation.disabled).toBe(true);
  expect(confirmation.value).toBe("ask");

  fireEvent.change(screen.getByLabelText("Merge commit message"), { target: { value: "Merge {source}" } });
  fireEvent.click(screen.getByRole("button", { name: "Remove main" }));
  expect(screen.getByRole("alert").textContent).toBe("Add at least one target branch.");
  expect(onSave).not.toHaveBeenCalled();
});

function sectionApi(initialRules: PipelineRule[] = []) {
  let rules = initialRules;
  let app = { executionMode: "temporaryWorktree" as const, inPlaceDirtyPolicy: "shelve" as const };
  let repository: { executionMode: "temporaryWorktree" | "switchInPlace" | null; inPlaceDirtyPolicy: "shelve" | "refuse" | null } = { executionMode: null, inPlaceDirtyPolicy: null };
  const effective = () => ({
    ...repository,
    effectiveExecutionMode: repository.executionMode ?? app.executionMode,
    effectiveInPlaceDirtyPolicy: repository.inPlaceDirtyPolicy ?? app.inPlaceDirtyPolicy,
  });
  return {
    getPipelineAppSettings: vi.fn(async () => app),
    setPipelineAppSettings: vi.fn(async (next: typeof app) => { app = next; return app; }),
    getPipelineRepositorySettings: vi.fn(async () => effective()),
    setPipelineRepositorySettings: vi.fn(async (_id: string, next: typeof repository) => { repository = { executionMode: next.executionMode ?? null, inPlaceDirtyPolicy: next.inPlaceDirtyPolicy ?? null }; return effective(); }),
    listPipelineRules: vi.fn(async () => rules),
    replacePipelineRules: vi.fn(async (_id: string, next: PipelineRule[]) => { rules = next; return rules; }),
    getRepositoryBranches: vi.fn(async () => ({
      repoId: "repo_a", current: "feature/1", detached: false,
      branches: [
        { name: "feature/1", fullName: "refs/heads/feature/1", kind: "local" },
        { name: "origin/uat", fullName: "refs/remotes/origin/uat", kind: "remote" },
        { name: "origin/dev", fullName: "refs/remotes/origin/dev", kind: "remote" },
      ],
    })),
  };
}

it("shows the app default and the repository override, and saves changes", async () => {
  const api = sectionApi();
  render(<AutomationsSection api={api as unknown as GitCrestApiClient} repoId="repo_a" />);
  await screen.findByText("Temporary worktree (recommended)");

  fireEvent.click(screen.getByRole("radio", { name: /Switch in place/ }));
  await waitFor(() => expect(api.setPipelineAppSettings).toHaveBeenCalledWith({ executionMode: "switchInPlace", inPlaceDirtyPolicy: "shelve" }));
  const dirty = await screen.findByLabelText("Uncommitted changes when switching in place");
  expect(dirty).toBeTruthy();

  fireEvent.change(screen.getByLabelText("This repository"), { target: { value: "temporaryWorktree" } });
  await waitFor(() => expect(api.setPipelineRepositorySettings).toHaveBeenCalledWith("repo_a", { executionMode: "temporaryWorktree", inPlaceDirtyPolicy: null }));
  await waitFor(() => expect(screen.queryByLabelText("Uncommitted changes when switching in place")).toBeNull());
});

it("adds, disables, reorders and deletes rules through the core", async () => {
  const api = sectionApi([rule({ ruleId: "r_01", name: "First" }), rule({ ruleId: "r_02", name: "Second" })]);
  render(<AutomationsSection api={api as unknown as GitCrestApiClient} repoId="repo_a" />);
  await screen.findByText("First");

  fireEvent.click(screen.getByRole("checkbox", { name: "Enabled: First" }));
  await waitFor(() => expect(api.replacePipelineRules).toHaveBeenLastCalledWith("repo_a", [expect.objectContaining({ ruleId: "r_01", enabled: false }), expect.objectContaining({ ruleId: "r_02" })]));

  fireEvent.click(screen.getByRole("button", { name: "Move down: First" }));
  await waitFor(() => expect(api.replacePipelineRules).toHaveBeenLastCalledWith("repo_a", [expect.objectContaining({ ruleId: "r_02" }), expect.objectContaining({ ruleId: "r_01" })]));

  fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
  await waitFor(() => expect(api.replacePipelineRules).toHaveBeenLastCalledWith("repo_a", [expect.objectContaining({ ruleId: "r_01" })]));

  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  const editor = await screen.findByRole("form", { name: "Rule" });
  fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "Third" } });
  fireEvent.change(within(editor).getByLabelText("Choose a remote branch"), { target: { value: "origin/uat" } });
  fireEvent.click(within(editor).getByRole("button", { name: "Add target" }));
  fireEvent.click(within(editor).getByRole("button", { name: "Save rule" }));
  await waitFor(() => expect(api.replacePipelineRules).toHaveBeenLastCalledWith("repo_a", [expect.objectContaining({ ruleId: "r_01" }), expect.objectContaining({ ruleId: "r_02", name: "Third" })]));
  await waitFor(() => expect(screen.queryByRole("form", { name: "Rule" })).toBeNull());
});

it("keeps the editor open with the core's message when saving fails", async () => {
  const api = sectionApi();
  api.replacePipelineRules.mockRejectedValueOnce(new Error("storage unavailable"));
  render(<AutomationsSection api={api as unknown as GitCrestApiClient} repoId="repo_a" />);
  await screen.findByText(/No rules yet/);
  fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
  const editor = await screen.findByRole("form", { name: "Rule" });
  fireEvent.change(within(editor).getByLabelText("Name"), { target: { value: "Broken" } });
  fireEvent.change(within(editor).getByLabelText("Choose a remote branch"), { target: { value: "origin/dev" } });
  fireEvent.click(within(editor).getByRole("button", { name: "Add target" }));
  fireEvent.click(within(editor).getByRole("button", { name: "Save rule" }));
  expect((await within(editor).findByText("storage unavailable"))).toBeTruthy();
  expect(screen.getByRole("form", { name: "Rule" })).toBeTruthy();
});

it("asks to open a repository when there is none, but still offers the app default", async () => {
  const api = sectionApi();
  render(<AutomationsSection api={api as unknown as GitCrestApiClient} />);
  await screen.findByText("Temporary worktree (recommended)");
  expect(screen.getByText("Open a repository to edit its rules.")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add rule" }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.listPipelineRules).not.toHaveBeenCalled();
});
