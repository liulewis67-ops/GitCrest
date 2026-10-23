import type { ConflictBlock } from "./conflict-blocks";
import { diffLines, splitLines } from "./line-diff";
import { withEol, type Merge3Region } from "./merge3";

/** The word-level pass is the costly one, so larger blocks are left to the user. */
const MAX_WORD_MERGE_CHARS = 8000;
const MAX_WORD_EDITS = 400;

/**
 * `merged`: both sides' edits to the base never overlap, so they combine into `text`. `overlapping`: they do, and the
 * user decides. `unknown`: the base for the block cannot be determined, so nothing can be combined safely.
 */
export type SmartMergeOutcome = { kind: "merged"; text: string } | { kind: "overlapping" } | { kind: "unknown" };

interface Edit { aStart: number; aEnd: number; tokens: string[] }

/**
 * Combines both sides of one conflict when their edits to the base never overlap, or returns `null`. Whole lines are
 * tried first, where replacements of neighbouring lines combine (Git refuses those). Edits that share a line are then
 * tried word by word, where they must also be separated by at least one unchanged token.
 */
export function smartMerge(base: string, ours: string, theirs: string): string | null {
  if (ours === theirs || theirs === base) return ours;
  if (ours === base) return theirs;
  const byLine = mergeTokens(splitLines(base), splitLines(ours), splitLines(theirs), false);
  if (byLine !== null) return byLine;
  if (Math.max(base.length, ours.length, theirs.length) > MAX_WORD_MERGE_CHARS) return null;
  return mergeTokens(tokenize(base), tokenize(ours), tokenize(theirs), true, MAX_WORD_EDITS);
}

/** Smart Merge for one parsed block, using its own diff3 base or the matching three-way merge conflict. */
export function smartMergeBlock(block: ConflictBlock, regions: readonly Merge3Region[] | null): SmartMergeOutcome {
  const ours = withEol(block.ours);
  const theirs = withEol(block.theirs);
  if (ours === theirs) return { kind: "merged", text: block.ours };
  if (block.base !== null) return outcome(smartMerge(block.base, block.ours, block.theirs));
  for (const region of regions ?? []) {
    if (region.kind !== "conflict") continue;
    // Git moves lines both sides share at a conflict's edges outside the markers; match the block without them.
    const prefix = commonPrefix(region.ours, region.theirs);
    const suffix = commonSuffix(region.ours, region.theirs, prefix);
    if (withEol(region.ours.slice(prefix, region.ours.length - suffix).join("")) !== ours) continue;
    if (withEol(region.theirs.slice(prefix, region.theirs.length - suffix).join("")) !== theirs) continue;
    const merged = smartMerge(region.base.join(""), region.ours.join(""), region.theirs.join(""));
    const head = region.ours.slice(0, prefix).join("");
    const tail = region.ours.slice(region.ours.length - suffix).join("");
    if (merged === null || merged.length < head.length + tail.length || !merged.startsWith(head) || !merged.endsWith(tail)) return { kind: "overlapping" };
    return { kind: "merged", text: merged.slice(head.length, merged.length - tail.length) };
  }
  return { kind: "unknown" };
}

/** Replaces every block that has a merged outcome in one pass; the others keep their markers. */
export function applySmartMerge(content: string, blocks: readonly ConflictBlock[], outcomes: readonly SmartMergeOutcome[]) {
  let next = content;
  let merged = 0;
  // Back to front, so the offsets of the blocks still to replace stay valid.
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const result = outcomes[index];
    if (result?.kind !== "merged") continue;
    next = next.slice(0, blocks[index].start) + result.text + next.slice(blocks[index].end);
    merged += 1;
  }
  return { content: next, merged };
}

/** Splits text into newlines, runs of other whitespace, words and single punctuation characters. */
export function tokenize(text: string) {
  return text.match(/\r\n?|\n|[^\S\r\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function outcome(text: string | null): SmartMergeOutcome {
  return text === null ? { kind: "overlapping" } : { kind: "merged", text };
}

function mergeTokens(base: string[], ours: string[], theirs: string[], separated: boolean, maxEdits?: number) {
  const oursHunks = diffLines(base, ours, maxEdits);
  const theirsHunks = diffLines(base, theirs, maxEdits);
  if (!oursHunks || !theirsHunks) return null;
  const oursEdits = oursHunks.map((hunk): Edit => ({ aStart: hunk.aStart, aEnd: hunk.aEnd, tokens: ours.slice(hunk.bStart, hunk.bEnd) }));
  const theirsEdits = theirsHunks.map((hunk): Edit => ({ aStart: hunk.aStart, aEnd: hunk.aEnd, tokens: theirs.slice(hunk.bStart, hunk.bEnd) }));
  const edits = [...oursEdits];
  for (const edit of theirsEdits) {
    if (oursEdits.some((other) => sameEdit(edit, other))) continue;
    if (oursEdits.some((other) => clashes(edit, other, separated))) return null;
    edits.push(edit);
  }
  edits.sort((left, right) => left.aStart - right.aStart);
  const out: string[] = [];
  let position = 0;
  for (const edit of edits) {
    out.push(...base.slice(position, edit.aStart), ...edit.tokens);
    position = edit.aEnd;
  }
  out.push(...base.slice(position));
  return out.join("");
}

/**
 * Edits clash when they touch. The one exception is two line replacements that merely border each other, which is the
 * case Git refuses. An insertion bordering the other side's edit still clashes: when both sides add the same line, the
 * diff may attribute it to different edits, and combining them would duplicate it.
 */
function clashes(left: Edit, right: Edit, separated: boolean) {
  const touching = left.aStart <= right.aEnd && right.aStart <= left.aEnd;
  if (separated || left.aStart === left.aEnd || right.aStart === right.aEnd) return touching;
  return left.aStart < right.aEnd && right.aStart < left.aEnd;
}

function sameEdit(left: Edit, right: Edit) {
  return left.aStart === right.aStart && left.aEnd === right.aEnd && left.tokens.length === right.tokens.length
    && left.tokens.every((token, index) => token === right.tokens[index]);
}

function commonPrefix(left: readonly string[], right: readonly string[]) {
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) count += 1;
  return count;
}

function commonSuffix(left: readonly string[], right: readonly string[], prefix: number) {
  let count = 0;
  while (count < left.length - prefix && count < right.length - prefix && left[left.length - 1 - count] === right[right.length - 1 - count]) count += 1;
  return count;
}
