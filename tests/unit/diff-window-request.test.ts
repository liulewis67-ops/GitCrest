// @vitest-environment node
import { describe, expect, it } from "vitest";
import { parseDiffWindowRequest } from "../../electron/main/diff-window-request";

const repoId = `repo_${"a".repeat(64)}`;
const A = "a".repeat(40);
const B = "B".repeat(64);

describe("Diff window requests", () => {
  it("accepts the existing scopes unchanged", () => {
    expect(parseDiffWindowRequest({ repoId, path: "a.txt", scope: "workingTree" }).scope).toBe("workingTree");
    expect(parseDiffWindowRequest({ repoId, path: "a.txt", scope: "commit", commitOid: A }).commitOid).toBe(A);
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "commit" })).toThrow(/commit ID/);
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "index", commitOid: A })).toThrow(/historical/);
  });

  it("accepts a comparison from one commit to another, or to the working tree", () => {
    expect(parseDiffWindowRequest({ repoId, path: "a.txt", scope: "range", fromOid: A, toOid: B })).toMatchObject({ fromOid: A, toOid: B });
    expect(parseDiffWindowRequest({ repoId, path: "a.txt", scope: "range", fromOid: A }).toOid).toBeUndefined();
  });

  it("refuses a comparison without a valid start, or with an end that is not a full commit ID", () => {
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "range" })).toThrow(/starting commit/);
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "range", fromOid: "main" })).toThrow(/starting commit/);
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "range", fromOid: A, toOid: "HEAD" })).toThrow(/end of a comparison/);
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "range", fromOid: A, commitOid: A })).toThrow(/historical/);
  });

  it("refuses comparison IDs on any other scope", () => {
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "workingTree", fromOid: A })).toThrow(/only valid for a comparison/);
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "commit", commitOid: A, toOid: A })).toThrow(/only valid for a comparison/);
  });

  it("still checks the repository and the path", () => {
    expect(() => parseDiffWindowRequest({ repoId: "repo_x", path: "a.txt", scope: "range", fromOid: A })).toThrow(/repository ID/);
    expect(() => parseDiffWindowRequest({ repoId, path: " ", scope: "range", fromOid: A })).toThrow(/file path/);
    expect(() => parseDiffWindowRequest({ repoId, path: "a.txt", scope: "bogus" })).toThrow(/scope/);
  });
});
