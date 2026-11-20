// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommitWorkbench } from "../../src/features/commits/ui/CommitWorkbench";
import { PipelineRuleEditor } from "../../src/features/pipelines/ui/PipelineRuleEditor";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { newPipelineRule } from "../../src/features/pipelines/model/rule-form";
import type { RepositoryResponse } from "../../src/api/client";

afterEach(cleanup);
const repository: RepositoryResponse = { repoId: "repo", path: "C:/repo", head: "a".repeat(40), branch: "main", detached: false, state: "normal", isFavorite: false, lastAccessedAt: 1, availability: "available" };
function composer(stagedCount = 0, hasConflicts = false, waiting = false) {
  const onStageAll = vi.fn();
  const onResolveConflicts = vi.fn();
  const onSubmit = vi.fn();
  render(<CommitWorkbench repository={repository} status={{ stagedCount, workingCount: 2, hasConflicts, sensitiveStagedPaths: [] }}
    commit={{ message: "", summary: "", description: "", template: "plain", selections: [], activeAction: "commit", actionLabel: "Commit", actionIsDanger: false, actionMenuOpen: false, assistantOpen: false, amend: false, signOff: false, sign: false, busy: false, canCommit: false }}
    connected hasActiveRepositoryTask={waiting} shortcuts={defaultShortcutPreferences} isMacPlatform={false}
    onStageAll={onStageAll} onResolveConflicts={onResolveConflicts} onSubmit={onSubmit}
    onChangeMessage={vi.fn()} onChangeSummary={vi.fn()} onChangeDescription={vi.fn()} onChangeTemplate={vi.fn()}
    onClearSelections={vi.fn()} onAssistantOpenChange={vi.fn()} onSelectAmend={vi.fn()} onSelectSignOff={vi.fn()}
    onSelectSign={vi.fn()} onChooseAction={vi.fn()} onToggleActionMenu={vi.fn()} />);
  return { onStageAll, onResolveConflicts, onSubmit };
}

it("offers explicit staging without staging or submitting anything on render", () => {
  const handlers = composer();
  expect(handlers.onStageAll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Stage all changes" }));
  expect(handlers.onStageAll).toHaveBeenCalledOnce();
  expect(handlers.onSubmit).not.toHaveBeenCalled();
});

it("hands focus to the summary after files are staged", () => {
  composer(2);
  expect(screen.queryByRole("button", { name: "Stage all changes" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Write a commit summary" }));
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Commit message" }));
  expect(screen.getByRole("textbox", { name: /description/i }).closest("details")?.open).toBe(false);
});

it("prioritizes resolving conflicts and suppresses next actions while a task owns the repository", () => {
  const handlers = composer(0, true);
  fireEvent.click(screen.getByRole("button", { name: "Resolve conflicts" }));
  expect(handlers.onResolveConflicts).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Stage all changes" })).toBeNull();
  cleanup();
  composer(0, false, true);
  expect(screen.queryByRole("button", { name: "Stage all changes" })).toBeNull();
});

it("keeps a new Hook focused on basic fields while preserving advanced configuration", () => {
  render(<PipelineRuleEditor rule={newPipelineRule("r_01")} otherRules={[]} localBranches={[]} remoteBranches={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Name" }));
  expect(screen.getByRole("combobox", { name: "Merge" }).closest("details")?.open).toBe(false);
  fireEvent.click(screen.getByText("Merge and conflict options", { exact: true }));
  expect(screen.getByRole("combobox", { name: "Merge" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Save Hook" })).toBeTruthy();
  cleanup();
  render(<PipelineRuleEditor rule={{ ...newPipelineRule("r_02"), commitMessageTemplate: "Merge {source}" }} otherRules={[]} localBranches={[]} remoteBranches={[]} onSave={vi.fn()} onCancel={vi.fn()} />);
  expect(screen.getByText("Customized").closest("details")?.open).toBe(true);
});
