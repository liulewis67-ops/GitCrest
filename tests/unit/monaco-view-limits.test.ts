import { describe, expect, it } from "vitest";
import type { DiffDocumentResponse } from "../../src/api/client";
import { exceedsMonacoViewLimits } from "../../src/features/diff/monaco-view-limits";

const hunk: DiffDocumentResponse["hunks"][number] = {
  oldStart: 1,
  oldLines: 1,
  newStart: 1,
  newLines: 1,
  rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "old", newText: "new" }],
};

describe("exceedsMonacoViewLimits", () => {
  it("keeps ordinary hunks in Monaco while limiting very fragmented diffs", () => {
    expect(exceedsMonacoViewLimits([hunk])).toBe(false);
    expect(exceedsMonacoViewLimits(Array.from({ length: 51 }, () => hunk))).toBe(true);
  });

  it("degrades a diff when the combined hunk text exceeds one million characters", () => {
    const longHunk: DiffDocumentResponse["hunks"][number] = {
      ...hunk,
      rows: [{ kind: "change", oldLine: 1, newLine: 1, oldText: "x".repeat(500_000), newText: "y".repeat(500_000) }],
    };
    expect(exceedsMonacoViewLimits([longHunk])).toBe(true);
  });
});
