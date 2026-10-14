import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { baseForBlock, findConflictBlocks } from "../../src/features/workflows/model/conflict-blocks";
import { diffLines, splitLines } from "../../src/features/workflows/model/line-diff";
import { countConflicts, merge3, renderMerge3 } from "../../src/features/workflows/model/merge3";

function applyHunks(a: string[], b: string[], hunks: ReturnType<typeof diffLines>) {
  const out: string[] = [];
  let position = 0;
  for (const hunk of hunks ?? []) {
    out.push(...a.slice(position, hunk.aStart), ...b.slice(hunk.bStart, hunk.bEnd));
    position = hunk.aEnd;
  }
  out.push(...a.slice(position));
  return out;
}

function random(seed: number) {
  let state = seed;
  return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

it("splits lines keeping terminators, including CRLF and a missing final newline", () => {
  expect(splitLines("a\r\nb\nc")).toEqual(["a\r\n", "b\n", "c"]);
  expect(splitLines("")).toEqual([]);
  expect(splitLines("a\n").join("")).toBe("a\n");
});

it("diffs lines so that applying the hunks to a reproduces b", () => {
  const next = random(7);
  for (let round = 0; round < 200; round += 1) {
    const a = Array.from({ length: Math.floor(next() * 12) }, () => `${Math.floor(next() * 4)}\n`);
    const b = Array.from({ length: Math.floor(next() * 12) }, () => `${Math.floor(next() * 4)}\n`);
    const hunks = diffLines(a, b);
    expect(applyHunks(a, b, hunks)).toEqual(b);
  }
  expect(diffLines(["a\n", "b\n"], ["a\n", "b\n"])).toEqual([]);
  expect(diffLines(["a\n", "b\n", "c\n"], ["a\n", "x\n", "c\n"])).toEqual([{ aStart: 1, aEnd: 2, bStart: 1, bEnd: 2 }]);
});

it("gives up instead of searching an unbounded edit distance", () => {
  const a = Array.from({ length: 50 }, (_, index) => `a${index}\n`);
  const b = Array.from({ length: 50 }, (_, index) => `b${index}\n`);
  expect(diffLines(a, b, 10)).toBeNull();
});

const lines = (text: string) => splitLines(text);

it("classifies one-sided, identical, adjacent and conflicting changes", () => {
  const base = lines("a\nb\nc\nd\ne\n");
  const regions = merge3(base, lines("a\nB\nc\nd\ne\n"), lines("a\nb\nc\nd\nE\n"))!;
  expect(regions.map((region) => region.kind)).toEqual(["stable", "ours", "stable", "theirs"]);
  expect(renderMerge3(regions, "all")).toBe("a\nB\nc\nd\nE\n");
  expect(renderMerge3(regions, "ours")).toBe("a\nB\nc\nd\ne\n");
  expect(renderMerge3(regions, "theirs")).toBe("a\nb\nc\nd\nE\n");

  const same = merge3(base, lines("a\nX\nc\nd\ne\n"), lines("a\nX\nc\nd\ne\n"))!;
  expect(same.map((region) => region.kind)).toEqual(["stable", "both", "stable"]);

  const conflict = merge3(base, lines("a\nO\nc\nd\ne\n"), lines("a\nT\nc\nd\ne\n"))!;
  expect(countConflicts(conflict)).toBe(1);
  expect(renderMerge3(conflict, "all")).toBe("a\n<<<<<<< ours\nO\n||||||| base\nb\n=======\nT\n>>>>>>> theirs\nc\nd\ne\n");

  const adjacent = merge3(base, lines("a\nB\nc\nd\ne\n"), lines("a\nb\nC\nd\ne\n"))!;
  expect(countConflicts(adjacent)).toBe(1);
  const separated = merge3(base, lines("a\nB\nc\nd\ne\n"), lines("a\nb\nc\nD\ne\n"))!;
  expect(countConflicts(separated)).toBe(0);
  expect(renderMerge3(separated, "all")).toBe("a\nB\nc\nD\ne\n");
});

it("handles add/add, delete/modify, CRLF and a missing trailing newline", () => {
  expect(countConflicts(merge3([], lines("x\n"), lines("y\n"))!)).toBe(1);
  expect(countConflicts(merge3([], lines("x\n"), lines("x\n"))!)).toBe(0);
  expect(countConflicts(merge3(lines("a\nb\nc\n"), lines("a\nc\n"), lines("a\nB\nc\n"))!)).toBe(1);
  const crlf = merge3(lines("a\r\nb\r\nc\r\n"), lines("A\r\nb\r\nc\r\n"), lines("a\r\nb\r\nC\r\n"))!;
  expect(renderMerge3(crlf, "all", "\r\n")).toBe("A\r\nb\r\nC\r\n");
  const noEol = merge3(lines("a\nb"), lines("a\nO"), lines("a\nT"))!;
  expect(renderMerge3(noEol, "all")).toContain("O\n||||||| base\nb\n=======\nT\n>>>>>>> theirs\n");
});

it("finds the base text of a two-way marker block from the matching merge conflict", () => {
  const regions = merge3(lines("a\nb\nc\n"), lines("a\nO\nc\n"), lines("a\nT\nc\n"))!;
  const [block] = findConflictBlocks("a\n<<<<<<< ours\nO\n=======\nT\n>>>>>>> theirs\nc\n");
  expect(block.base).toBeNull();
  expect(baseForBlock(block, regions)).toBe("b\n");
  expect(baseForBlock({ ...block, ours: "other\n" }, regions)).toBeNull();
});

it("gives duplicate blocks distinct stable ids", () => {
  const marker = "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n";
  const [first, second] = findConflictBlocks(`${marker}mid\n${marker}`);
  expect(first.id).not.toBe(second.id);
  expect(findConflictBlocks(`${marker}mid\n${marker}`)[1].id).toBe(second.id);
});

it("agrees with git merge-file on whether random three-way inputs conflict and on conflict-free results", () => {
  const directory = mkdtempSync(join(tmpdir(), "gitcrest-merge3-"));
  try {
    const next = random(42);
    const pick = () => `line ${Math.floor(next() * 6)}\n`;
    for (let round = 0; round < 60; round += 1) {
      const base = Array.from({ length: 4 + Math.floor(next() * 8) }, (_, index) => `base ${index}\n`);
      const mutate = () => base.flatMap((line) => {
        const roll = next();
        return roll < 0.12 ? [] : roll < 0.3 ? [pick()] : roll < 0.38 ? [line, pick()] : [line];
      });
      const ours = mutate();
      const theirs = mutate();
      const files = { ours: join(directory, "ours"), base: join(directory, "base"), theirs: join(directory, "theirs") };
      writeFileSync(files.ours, ours.join(""));
      writeFileSync(files.base, base.join(""));
      writeFileSync(files.theirs, theirs.join(""));
      let gitOutput: string;
      let gitConflicts = 0;
      try {
        gitOutput = execFileSync("git", ["merge-file", "-p", files.ours, files.base, files.theirs]).toString();
      } catch (error) {
        const failure = error as { status?: number; stdout?: Buffer };
        gitConflicts = failure.status ?? 0;
        gitOutput = failure.stdout?.toString() ?? "";
      }
      const regions = merge3(base, ours, theirs)!;
      const conflicts = countConflicts(regions);
      // Git may coalesce neighbouring conflicts into fewer, larger ones, but both must agree on whether any exist.
      expect(gitConflicts > 0).toBe(conflicts > 0);
      if (conflicts === 0) expect(renderMerge3(regions, "all")).toBe(gitOutput);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
