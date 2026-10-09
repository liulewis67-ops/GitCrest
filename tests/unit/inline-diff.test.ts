import { describe, expect, it } from "vitest";
import { splitInlineDiff } from "../../src/features/diff/model/inline-diff";

describe("splitInlineDiff", () => {
  it("marks only changed word tokens and preserves matching prefix and suffix", () => {
    expect(splitInlineDiff("const value = 1;", "const value = 2;")).toEqual([
      { text: "const value = ", changed: false }, { text: "1", changed: true }, { text: ";", changed: false },
    ]);
  });

  it("highlights inserted and deleted content without changing whitespace", () => {
    expect(splitInlineDiff("return result;", "return value result;")).toEqual([
      { text: "return result;", changed: false },
    ]);
    expect(splitInlineDiff("return value result;", "return result;")).toEqual([
      { text: "return ", changed: false }, { text: "value ", changed: true }, { text: "result;", changed: false },
    ]);
    expect(splitInlineDiff("new line", null)).toEqual([{ text: "new line", changed: true }]);
  });

  it("leaves identical lines unmarked and handles Unicode identifiers", () => {
    expect(splitInlineDiff("你好 = 1", "你好 = 1")).toEqual([{ text: "你好 = 1", changed: false }]);
    expect(splitInlineDiff("名字 = 1", "名字 = 2")).toEqual([
      { text: "名字 = ", changed: false }, { text: "1", changed: true },
    ]);
  });

  it("falls back to common edges when the token comparison exceeds its work bound", () => {
    const commonPrefix = "same ".repeat(600);
    expect(splitInlineDiff(`${commonPrefix}old;`, `${commonPrefix}new;`).slice(-2)).toEqual([
      { text: "old", changed: true }, { text: ";", changed: false },
    ]);
  });
});
