import { describe, expect, it } from "vitest";
import { analyzeConflictDraft, preserveFinalNewline, reviewChoiceText, sourceOffset } from "../../src/features/workflows/model/conflict-review";

const marked = "top\r\n<<<<<<< current\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\nbottom";
describe("conflict review safety", () => {
  it("recognizes complete markers without classifying them as malformed", () => {
    const review = analyzeConflictDraft(marked);
    expect(review.blocks).toHaveLength(1);
    expect(review.hasMarkers).toBe(true);
    expect(review.malformed).toBe(false);
  });
  it.each(["<<<<<<< ours\nx\n", "=======\n", ">>>>>>> theirs\n", "<<<< ours\nx\n", marked + "\n<<<<<<< unfinished\n"])("does not treat incomplete markers as resolved: %s", (content) => {
    expect(analyzeConflictDraft(content)).toMatchObject({ hasMarkers: true, malformed: true });
  });
  it("permits a genuinely marker-free result, including an empty file", () => {
    expect(analyzeConflictDraft("resolved\r\n")).toMatchObject({ hasMarkers: false, malformed: false });
    expect(analyzeConflictDraft("")).toMatchObject({ hasMarkers: false, malformed: false });
  });
  it("aligns unique source text without guessing repeated or absent ranges", () => {
    const block = analyzeConflictDraft(marked).blocks[0];
    expect(sourceOffset("top\r\nours\r\nbottom", block, "ours")).toBe(5);
    expect(sourceOffset("ours\r\nours\r\n", block, "ours")).toBeUndefined();
    expect(sourceOffset("different", block, "ours")).toBeUndefined();
  });
  it("does not add a newline at EOF when the chosen source has none", () => {
    const content = "<<<<<<< ours\ncurrent\n=======\nincoming\n>>>>>>> theirs\n";
    const block = analyzeConflictDraft(content).blocks[0];
    expect(preserveFinalNewline(content, block, block.ours, "current")).toBe("current");
    expect(preserveFinalNewline(content, block, block.ours, "current\n")).toBe("current\n");
    expect(preserveFinalNewline(content + "tail", block, block.ours, "current")).toBe("current\n");
  });
  it("uses the source's exact endings when marker formatting differs", () => {
    const content = "<<<<<<< current\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> incoming\r\n";
    const block = analyzeConflictDraft(content).blocks[0];
    expect(reviewChoiceText(block, "theirs", "top\r\nours\nbottom", "top\r\ntheirs\nbottom")).toBe("theirs\n");
    expect(sourceOffset("top\r\ntheirs\nbottom", block, "theirs")).toBe(5);
    expect(reviewChoiceText(block, "both", "ours", "theirs")).toBe("ours\r\ntheirs");
  });
});
