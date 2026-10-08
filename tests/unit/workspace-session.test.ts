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
          mode: "diff",
          selectedCommit: "abc123",
          selectedFilePath: "src/main.rs",
          selectedFileScope: "index",
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
          mode: "diff",
          selectedCommit: "abc123",
          selectedFilePath: "src/main.rs",
          selectedFileScope: "index",
          selectedDiffCommitOid: "def456",
          graphScrollTop: 120.5,
          commitAction: "commitAndPush",
        },
        "repo-b": { mode: "graph", graphScrollTop: 0 },
      },
    });
  });

  it("drops non-finite scroll positions and invalid top-level fields", () => {
    expect(parseWorkspaceSession(JSON.stringify({
      openRepoIds: "repo-a",
      activeRepoId: 1,
      tabs: { "repo-a": { graphScrollTop: Number.POSITIVE_INFINITY } },
    }))).toEqual({
      openRepoIds: [],
      tabs: { "repo-a": { mode: "graph", graphScrollTop: 0 } },
    });
  });
});
