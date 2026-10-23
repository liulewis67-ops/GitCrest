import { describe, expect, it } from "vitest";
import { parseWorkspaceSession } from "../../src/features/repositories/model/workspace-session";

describe("parseWorkspaceSession", () => {
  it("returns an empty session when storage is absent or malformed", () => {
    expect(parseWorkspaceSession(null)).toEqual({ openRepoIds: [], tabs: {} });
    expect(parseWorkspaceSession("not-json")).toEqual({ openRepoIds: [], tabs: {} });
    expect(parseWorkspaceSession("null")).toEqual({ openRepoIds: [], tabs: {} });
  });

  it("normalizes repository IDs and restores only supported per-repository state", () => {
    expect(parseWorkspaceSession(JSON.stringify({
      openRepoIds: ["repo-a", "repo-a", 3, "repo-b"],
      activeRepoId: "repo-b",
      tabs: {
        "repo-a": {
          mode: "history",
          selectedCommit: "abc123",
          selectedFilePath: "src/main.rs",
          selectedFileScope: "index",
          selectedCommitFilePath: "src/lib.rs",
          selectedDiffCommitOid: "def456",
          graphScrollTop: 120.5,
          commitAction: "commitAndPush",
        },
        "repo-b": {
          mode: "unsupported",
          selectedFileScope: "unsupported",
          graphScrollTop: -8,
          commitAction: "unsupported",
        },
        ignored: null,
      },
    }))).toEqual({
      openRepoIds: ["repo-a", "repo-b"],
      activeRepoId: "repo-b",
      tabs: {
        "repo-a": {
          mode: "history",
          selectedCommit: "abc123",
          selectedFilePath: "src/main.rs",
          selectedFileScope: "index",
          selectedCommitFilePath: "src/lib.rs",
          selectedDiffCommitOid: "def456",
          graphScrollTop: 120.5,
          commitAction: "commitAndPush",
        },
        "repo-b": { mode: "changes", graphScrollTop: 0 },
      },
    });
  });

  it("maps sessions saved with the Graph and Diff modes onto the task view showing the same content", () => {
    const session = parseWorkspaceSession(JSON.stringify({
      openRepoIds: ["graph", "working", "commit", "branches"],
      tabs: {
        graph: { mode: "graph", graphScrollTop: 10 },
        branches: { mode: "branches", selectedCommit: "c0ffee", graphScrollTop: 4 },
        working: { mode: "diff", selectedFilePath: "a.txt", selectedFileScope: "workingTree", graphScrollTop: 0 },
        commit: { mode: "diff", selectedFilePath: "b.txt", selectedFileScope: "commit", selectedDiffCommitOid: "c0ffee", graphScrollTop: 0 },
      },
    }));
    expect(session.tabs.graph).toEqual({ mode: "history", graphScrollTop: 10 });
    // Branches merged into History, which now shows the branch list beside the graph.
    expect(session.tabs.branches).toEqual({ mode: "history", selectedCommit: "c0ffee", graphScrollTop: 4 });
    expect(session.tabs.working).toEqual({ mode: "changes", selectedFilePath: "a.txt", selectedFileScope: "workingTree", graphScrollTop: 0 });
    // A historical file never becomes a working-tree selection.
    expect(session.tabs.commit).toEqual({ mode: "history", selectedCommitFilePath: "b.txt", selectedDiffCommitOid: "c0ffee", graphScrollTop: 0 });
  });

  it("drops non-finite scroll positions and invalid top-level fields", () => {
    expect(parseWorkspaceSession(JSON.stringify({
      openRepoIds: "repo-a",
      activeRepoId: 1,
      tabs: { "repo-a": { graphScrollTop: Number.POSITIVE_INFINITY } },
    }))).toEqual({
      openRepoIds: [],
      tabs: { "repo-a": { mode: "changes", graphScrollTop: 0 } },
    });
  });
});
