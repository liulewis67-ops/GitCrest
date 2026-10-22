// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useCommitDraft } from "../../src/features/commits";

afterEach(cleanup);

it("keeps each repository's commit draft when switching repository tabs", () => {
  const { result, rerender } = renderHook(({ repoId }) => useCommitDraft(repoId), { initialProps: { repoId: "repo-a" } });

  act(() => {
    result.current.setSummary("feat: first repository");
    result.current.setDescription("Body for A.");
    result.current.setAmend(true);
    result.current.addDiffSelection("src/a.ts", "rev-1", [{ hunkIndex: 0 }]);
  });
  rerender({ repoId: "repo-b" });

  expect(result.current.summary).toBe("");
  expect(result.current.amend).toBe(false);
  expect(result.current.selections).toEqual([]);
  act(() => result.current.setSummary("fix: second repository"));

  rerender({ repoId: "repo-a" });
  expect(result.current.message).toBe("feat: first repository\n\nBody for A.");
  expect(result.current.amend).toBe(true);
  expect(result.current.selections).toEqual([{ path: "src/a.ts", revision: "rev-1", selections: [{ hunkIndex: 0 }] }]);
  expect(result.current.selectionRepoId).toBe("repo-a");

  rerender({ repoId: "repo-b" });
  expect(result.current.summary).toBe("fix: second repository");
});

it("clears a finished commit from its own repository's draft, even from another tab", () => {
  const { result, rerender } = renderHook(({ repoId }) => useCommitDraft(repoId), { initialProps: { repoId: "repo-a" } });
  act(() => {
    result.current.setSummary("feat: committed");
    result.current.addDiffSelection("src/a.ts", "rev-1", [{ hunkIndex: 1 }]);
  });
  const committedMessage = result.current.message;
  const committedSelections = JSON.stringify(result.current.selections);

  rerender({ repoId: "repo-b" });
  act(() => result.current.setSummary("fix: untouched"));
  act(() => result.current.clearCommitted("repo-a", committedMessage, committedSelections));

  expect(result.current.summary).toBe("fix: untouched");
  rerender({ repoId: "repo-a" });
  expect(result.current.message).toBe("");
  expect(result.current.selections).toEqual([]);
});

it("keeps a message the user changed while the commit ran", () => {
  const { result } = renderHook(() => useCommitDraft("repo-a"));
  act(() => result.current.setSummary("feat: committed"));
  const committedMessage = result.current.message;
  act(() => result.current.setSummary("feat: next change"));

  act(() => result.current.clearCommitted("repo-a", committedMessage, "[]"));

  expect(result.current.summary).toBe("feat: next change");
});
