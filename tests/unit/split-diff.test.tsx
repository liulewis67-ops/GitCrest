// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffDocumentResponse } from "../../src/api/client";
import { SplitDiff } from "../../src/features/diff/SplitDiff";

afterEach(cleanup);

describe("SplitDiff", () => {
  it("keeps historical commit diffs read-only", () => {
    const onStageSelection = vi.fn();
    const document: DiffDocumentResponse = {
      repoId: "repo_fixture",
      path: "src/file.ts",
      revision: "sha256:commit-fixture",
      originalPath: null,
      scope: "commit",
      changeKind: "modified",
      status: "text",
      hunks: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "old", newText: "new" }],
      }],
    };
    render(<SplitDiff document={document} onStageSelection={onStageSelection} disabled={false} />);

    expect(screen.getByText("COMMIT ↔ FIRST PARENT")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /stage|unstage/i })).toBeNull();
    expect(onStageSelection).not.toHaveBeenCalled();
  });
});
