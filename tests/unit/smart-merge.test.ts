import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { findConflictBlocks } from "../../src/features/workflows/model/conflict-blocks";
import { splitLines } from "../../src/features/workflows/model/line-diff";
import { merge3 } from "../../src/features/workflows/model/merge3";
import { applySmartMerge, smartMerge, smartMergeBlock, tokenize } from "../../src/features/workflows/model/smart-merge";

function random(seed: number) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

it("combines edits on neighbouring lines that Git reports as one conflict", () => {
  const base = "a\nb\nc\nd\n";
  const ours = "a\nB\nc\nd\n";
  const theirs = "a\nb\nC\nd\n";
  expect(merge3(splitLines(base), splitLines(ours), splitLines(theirs))!.some((region) => region.kind === "conflict")).toBe(true);
  expect(smartMerge(base, ours, theirs)).toBe("a\nB\nC\nd\n");
  expect(smartMerge(base, "a\nd\n", "a\nb\nc\nD\n")).toBe("a\nD\n");
});

it("takes the changed side when the other side matches the base or both made the same change", () => {
  expect(smartMerge("x\n", "x\n", "y\n")).toBe("y\n");
  expect(smartMerge("x\n", "y\n", "x\n")).toBe("y\n");
  expect(smartMerge("x\n", "y\n", "y\n")).toBe("y\n");
});

it("combines word-level edits that share a line but not a word", () => {
  expect(smartMerge("call(a, b);\n", "call(x, b);\n", "call(a, y);\n")).toBe("call(x, y);\n");
  expect(smartMerge("const 名字 = 1;\r\n", "let 名字 = 1;\r\n", "const 名字 = 2;\r\n")).toBe("let 名字 = 2;\r\n");
});

it("leaves overlapping edits for the user", () => {
  expect(smartMerge("x = 1;\n", "x = 2;\n", "x = 3;\n")).toBeNull();
  // Words that touch are as ambiguous as words that overlap.
  expect(smartMerge("value\n", "value1\n", "value 2\n")).toBeNull();
  // Two insertions at the same place have no right order.
  expect(smartMerge("a\nb\n", "a\nX\nb\n", "a\nY\nb\n")).toBeNull();
  // An insertion next to the other side's edit could duplicate a line both sides added.
  expect(smartMerge("1\nb\nc\n9\n", "1\nS\nb\nC\n9\n", "1\nS\nB\nc\n9\n")).toBeNull();
});

it("tokenizes without losing characters", () => {
  for (const text of ["a\r\nb\rc\n", "  foo(bar_1, 'x')\t;\n", "名字 = 值。", ""]) expect(tokenize(text).join("")).toBe(text);
});

it("resolves a two-way block whose shared edge lines Git moved outside the markers", () => {
  const base = "1\nb\nc\nd\n9\n";
  const ours = "1\nB\nC\nd\n9\n";
  const theirs = "1\nB\nc\nD\n9\n";
  const regions = merge3(splitLines(base), splitLines(ours), splitLines(theirs));
  const content = "1\nB\n<<<<<<< ours\nC\nd\n=======\nc\nD\n>>>>>>> theirs\n9\n";
  const [block] = findConflictBlocks(content);
  const outcome = smartMergeBlock(block, regions);
  expect(outcome).toEqual({ kind: "merged", text: "C\nD\n" });
  expect(applySmartMerge(content, [block], [outcome])).toEqual({ content: "1\nB\nC\nD\n9\n", merged: 1 });
  expect(smartMergeBlock({ ...block, ours: "other\n" }, regions)).toEqual({ kind: "unknown" });
});

it("uses a diff3 block's own base and keeps overlapping blocks as markers", () => {
  const overlapping = "<<<<<<< ours\nx = 2;\n||||||| base\nx = 1;\n=======\nx = 3;\n>>>>>>> theirs\n";
  const content = `<<<<<<< ours\nB\nc\n||||||| base\nb\nc\n=======\nb\nC\n>>>>>>> theirs\nmid\n${overlapping}`;
  const blocks = findConflictBlocks(content);
  const outcomes = blocks.map((block) => smartMergeBlock(block, null));
  expect(outcomes.map((outcome) => outcome.kind)).toEqual(["merged", "overlapping"]);
  expect(applySmartMerge(content, blocks, outcomes)).toEqual({ content: `B\nC\nmid\n${overlapping}`, merged: 1 });
});

it("matches git merge-file whenever Git merges cleanly and Smart Merge accepts the input", () => {
  const directory = mkdtempSync(join(tmpdir(), "gitcrest-smart-merge-"));
  try {
    const next = random(1234);
    const pick = () => `line ${Math.floor(next() * 6)}\n`;
    let compared = 0;
    for (let round = 0; round < 60; round += 1) {
      const base = Array.from({ length: 4 + Math.floor(next() * 8) }, (_, index) => `base ${index}\n`);
      const mutate = () => base.flatMap((line) => {
        const roll = next();
        return roll < 0.08 ? [] : roll < 0.2 ? [pick()] : roll < 0.25 ? [line, pick()] : [line];
      });
      const ours = mutate().join("");
      const theirs = mutate().join("");
      const files = { ours: join(directory, "ours"), base: join(directory, "base"), theirs: join(directory, "theirs") };
      writeFileSync(files.ours, ours);
      writeFileSync(files.base, base.join(""));
      writeFileSync(files.theirs, theirs);
      let gitOutput: string;
      try {
        gitOutput = execFileSync("git", ["merge-file", "-p", files.ours, files.base, files.theirs]).toString();
      } catch {
        continue;
      }
      const merged = smartMerge(base.join(""), ours, theirs);
      if (merged === null) continue;
      expect(merged).toBe(gitOutput);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(10);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
