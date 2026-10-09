import { describe, expect, it } from "vitest";
import { parseDiffHunkSyntax } from "../../src/features/diff/model/tree-sitter";

describe("parseDiffHunkSyntax", () => {
  it("selects a plain-text fallback for grammars outside the bundled parser set", async () => {
    await expect(parseDiffHunkSyntax(null, "old", "new")).resolves.toEqual({ status: "unsupported", reason: "language" });
  });

  it("degrades oversized hunk excerpts before initializing WebAssembly", async () => {
    await expect(parseDiffHunkSyntax("rust", "x".repeat(250_001), "")).resolves.toEqual({ status: "unsupported", reason: "tooLarge" });
  });
});
