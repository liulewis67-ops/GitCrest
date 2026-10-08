import { expect, it } from "vitest";
import { mergeStatusScope } from "../../src/api/status-snapshot";

it("merges a changed directory scope, adding new files and removing deleted ones", () => {
  const current = {
    repoId: "repo_fixture",
    refreshedAtMs: 1,
    files: [
      { path: "src/old.ts", indexStatus: ".", worktreeStatus: "M", kind: "modified" as const, categories: ["unstaged" as const], modeChanged: false },
      { path: "src/nested/also-old.ts", indexStatus: ".", worktreeStatus: "M", kind: "modified" as const, categories: ["unstaged" as const], modeChanged: false },
      { path: "notes.txt", indexStatus: ".", worktreeStatus: "M", kind: "modified" as const, categories: ["unstaged" as const], modeChanged: false },
    ],
  };
  const partial = {
    repoId: "repo_fixture",
    refreshedAtMs: 2,
    files: [
      { path: "src/new file.ts", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const, categories: ["untracked" as const], modeChanged: false },
    ],
  };
  const merged = mergeStatusScope(current, partial, ["src"]);

  expect(merged.refreshedAtMs).toBe(2);
  expect(merged.files.map((file) => file.path)).toEqual(["notes.txt", "src/new file.ts"]);
});

it("normalizes Windows directory separators when merging a dirty scope", () => {
  const current = {
    repoId: "repo_fixture",
    refreshedAtMs: 1,
    files: [
      { path: "src/old.ts", indexStatus: ".", worktreeStatus: "M", kind: "modified" as const, categories: ["unstaged" as const], modeChanged: false },
      { path: "notes.txt", indexStatus: ".", worktreeStatus: "M", kind: "modified" as const, categories: ["unstaged" as const], modeChanged: false },
    ],
  };
  const partial = {
    repoId: "repo_fixture",
    refreshedAtMs: 2,
    files: [
      { path: "src/new.ts", indexStatus: "?", worktreeStatus: "?", kind: "untracked" as const, categories: ["untracked" as const], modeChanged: false },
    ],
  };

  const merged = mergeStatusScope(current, partial, ["src\\"]);

  expect(merged.files.map((file) => file.path)).toEqual(["notes.txt", "src/new.ts"]);
});
