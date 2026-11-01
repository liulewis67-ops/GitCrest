import { describe, expect, it } from "vitest";
import { applyPresentedEdit, conflictSourceLocations, presentConflicts, presentedOffset } from "../../src/features/workflows/model/conflict-presentation";
import { findConflictBlocks } from "../../src/features/workflows/model/conflict-blocks";

const marked = "top\n<<<<<<< ours\nleft\n||||||| base\nold\n=======\nright\n>>>>>>> theirs\nbottom\n";
describe("clean merge presentation", () => {
  it("shows ancestor content without Git marker syntax or duplicated sides", () => {
    const view = presentConflicts(marked, null);
    expect(view.text).toBe("top\nold\nbottom\n");
    expect(view.conflicts).toHaveLength(1);
    expect(presentedOffset(view, marked.indexOf("<<<<<<<"))).toBe(4);
    expect(presentedOffset(view, marked.indexOf("bottom"))).toBe(8);
  });
  it("preserves pending decisions when editing unrelated context", () => {
    const view = presentConflicts(marked, null);
    expect(applyPresentedEdit(view, "prefix\n" + view.text)).toBe("prefix\n" + marked);
    expect(applyPresentedEdit(view, view.text + "suffix")).toBe(marked + "suffix");
  });
  it("resolves a manually composed region without losing surrounding text", () => {
    expect(applyPresentedEdit(presentConflicts(marked, null), "top\nleft + right\nbottom\n")).toBe("top\nleft + right\nbottom\n");
  });
  it("keeps a later conflict pending after manually resolving the first", () => {
    const raw = marked + marked;
    const next = applyPresentedEdit(presentConflicts(raw, null), "top\ncombined\nbottom\ntop\nold\nbottom\n");
    expect(next).toBe("top\ncombined\nbottom\n" + marked);
    expect(findConflictBlocks(next)).toHaveLength(1);
  });
  it("supports empty ancestor insertions and EOF with no final newline", () => {
    const raw = "start\n<<<<<<< ours\nleft\n||||||| base\n=======\nright\n>>>>>>> theirs\n";
    const view = presentConflicts(raw, null);
    expect(view.text).toBe("start\n");
    expect(applyPresentedEdit(view, "start\ncombined")).toBe("start\ncombined");
    const noBase = raw.replace("||||||| base\n", "");
    expect(presentConflicts(noBase, null, "start\nleft", "start\nright").text).toBe("start\nleft");
  });
  it("preserves exact mixed line endings outside a composed result", () => {
    const raw = marked.replace("top\n", "top\r\n").replace("bottom\n", "bottom\r\n");
    expect(applyPresentedEdit(presentConflicts(raw, null), "top\r\ncombined\nbottom\r\n")).toBe("top\r\ncombined\nbottom\r\n");
  });
  it("locates an empty source side using a known three-way deletion range", () => {
    const blocks = findConflictBlocks("top\n<<<<<<< ours\n||||||| base\nold\n=======\nright\n>>>>>>> theirs\n");
    expect(conflictSourceLocations(blocks, [{ kind: "stable", lines: ["top\n"] }, { kind: "conflict", base: ["old\n"], ours: [], theirs: ["right\n"] }], "top\n", "top\nright\n")).toEqual([{ ours: 4, theirs: 4 }]);
  });
});
