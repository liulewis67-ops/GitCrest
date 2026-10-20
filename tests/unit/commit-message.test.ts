import { describe, expect, it } from "vitest";
import { composeCommitMessage, splitCommitMessage } from "../../src/features/commits/model/commit-message";

describe("commit message summary and description", () => {
  it("leaves the description out when it is empty", () => {
    expect(composeCommitMessage("  fix: trim input  ", "")).toBe("fix: trim input");
    expect(composeCommitMessage("fix: trim input", " \n\t\n")).toBe("fix: trim input");
  });

  it("joins the description after a blank line and keeps its inner layout", () => {
    expect(composeCommitMessage("feat: add export", "\n\nWhy:\n  - users asked\n\nRefs #12\n\n")).toBe("feat: add export\n\nWhy:\n  - users asked\n\nRefs #12");
  });

  it("splits a full message back into summary and description", () => {
    expect(splitCommitMessage("feat: add export\r\n\r\nWhy it matters\nRefs #12\n")).toEqual({ summary: "feat: add export", description: "Why it matters\nRefs #12" });
    expect(splitCommitMessage("\n  chore: bump\n")).toEqual({ summary: "chore: bump", description: "" });
    expect(splitCommitMessage("")).toEqual({ summary: "", description: "" });
  });

  it("round-trips a composed message", () => {
    const message = composeCommitMessage("feat: add export", "Body line\n\nSecond paragraph");
    const { summary, description } = splitCommitMessage(message);
    expect(composeCommitMessage(summary, description)).toBe(message);
  });
});
