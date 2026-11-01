import { expect, it } from "vitest";
import { analyzeConflictDraft, reviewChoiceText, sourceOffset } from "../../src/features/workflows/model/conflict-review";
import { merge3 } from "../../src/features/workflows/model/merge3";
import { splitLines } from "../../src/features/workflows/model/line-diff";
import { smartMergeBlock } from "../../src/features/workflows/model/smart-merge";

it("analyzes and maps a supported large file without expanding its shared prefix", () => {
  const prefix = Array.from({ length: 30_000 }, (_, index) => `line ${index}: shared content\n`).join("");
  const draft = prefix + "<<<<<<< current\ncurrent\n=======\nincoming\n>>>>>>> incoming\n";
  const ours = prefix + "current\n";
  const theirs = prefix + "incoming\n";
  expect(ours.length).toBeLessThan(1024 * 1024);
  const analysis = analyzeConflictDraft(draft);
  expect(analysis.blocks).toHaveLength(1);
  expect(analysis.blocks[0].start).toBe(prefix.length);
  const regions = merge3(splitLines(prefix + "base\n"), splitLines(ours), splitLines(theirs));
  expect(regions).toHaveLength(2);
  expect(smartMergeBlock(analysis.blocks[0], regions)).toEqual({ kind: "overlapping" });
  expect(sourceOffset(ours, analysis.blocks[0], "ours")).toBe(prefix.length);
  expect(reviewChoiceText(analysis.blocks[0], "ours", ours, theirs)).toBe("current\n");
}, 10_000);
