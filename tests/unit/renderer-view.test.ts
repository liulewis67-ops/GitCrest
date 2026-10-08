import { describe, expect, it } from "vitest";
import { resolveRendererView } from "../../src/app/routing/renderer-view";

describe("resolveRendererView", () => {
  it("uses the workspace for an absent or unknown view", () => {
    expect(resolveRendererView("")).toBe("workspace");
    expect(resolveRendererView("?view=settings")).toBe("workspace");
  });

  it("selects the diff window", () => {
    expect(resolveRendererView("?view=diff&repo=repo-1")).toBe("diff");
  });

  it("selects the conflict window", () => {
    expect(resolveRendererView("?view=conflicts&task=task-1")).toBe("conflicts");
  });
});
