// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient, RepositoryResponse } from "../../src/api/client";
import { defaultShortcutPreferences } from "../../src/features/settings/model/shortcut-preferences";
import { CommitWorkbench } from "../../src/features/commits/ui/CommitWorkbench";

afterEach(cleanup);

const repository = { repoId: "repo_a", path: "/r", head: "b".repeat(40), branch: "main", detached: false, availability: "available" } as unknown as RepositoryResponse;

function renderWorkbench(identityMissing: boolean, canCommit: boolean) {
  const api = { getRepositoryIdentity: vi.fn().mockResolvedValue({ name: null, email: null, nameScope: null, emailScope: null, resolved: false }) } as unknown as GitCrestApiClient;
  const noop = vi.fn();
  render(<CommitWorkbench
    repository={repository}
    status={{ stagedCount: 1, hasConflicts: false, sensitiveStagedPaths: [] }}
    commit={{ message: "feat: x", summary: "feat: x", description: "", template: "plain", selections: [], activeAction: "commit", actionLabel: "Commit", actionIsDanger: false, actionMenuOpen: false, assistantOpen: false, amend: false, signOff: false, sign: false, busy: false, canCommit }}
    shortcuts={defaultShortcutPreferences}
    isMacPlatform={false}
    connected
    hasActiveRepositoryTask={false}
    api={api}
    identityMissing={identityMissing}
    onChangeMessage={noop} onChangeSummary={noop} onChangeDescription={noop} onChangeTemplate={noop} onClearSelections={noop}
    onAssistantOpenChange={noop} onSelectAmend={noop} onSelectSignOff={noop} onSelectSign={noop} onSubmit={noop} onChooseAction={noop} onToggleActionMenu={noop}
  />);
}

it("blocks Commit with a reason and offers the identity editor when no author is set", () => {
  renderWorkbench(true, false);
  const commit = screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement;
  expect(commit.disabled).toBe(true);
  expect(commit.title).toBe("Set your commit author name and email first.");
  expect(screen.getByRole("alert").textContent).toContain("Git does not know who you are yet");
  expect(screen.queryByLabelText("Author name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Set identity" }));
  expect(screen.getByLabelText("Author name")).toBeTruthy();
});

it("shows no identity notice once an author resolves", () => {
  renderWorkbench(false, true);
  expect(screen.queryByText("Git does not know who you are yet")).toBeNull();
  expect((screen.getByRole("button", { name: "Commit" }) as HTMLButtonElement).disabled).toBe(false);
});
