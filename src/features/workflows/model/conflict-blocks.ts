import { withEol, type Merge3Region } from "./merge3";

export interface ConflictBlock {
  index: number;
  /** Stable across re-parses while the block's content is unchanged; used to key per-block UI state. */
  id: string;
  start: number;
  end: number;
  ours: string;
  theirs: string;
  /** Base text from diff3 markers, or `null` when the file uses the two-way marker style. */
  base: string | null;
  line: number;
}

export type BlockChoice = "ours" | "theirs" | "both";

export function findConflictBlocks(content: string): ConflictBlock[] {
  const lines: { text: string; start: number; end: number }[] = [];
  let offset = 0;
  for (const match of content.matchAll(/\r?\n/g)) {
    const end = (match.index ?? 0) + match[0].length;
    lines.push({ text: content.slice(offset, end), start: offset, end });
    offset = end;
  }
  if (offset < content.length) lines.push({ text: content.slice(offset), start: offset, end: content.length });

  const blocks: ConflictBlock[] = [];
  const seenIds = new Map<string, number>();
  for (let startIndex = 0; startIndex < lines.length; startIndex += 1) {
    if (!isConflictStart(lines[startIndex].text)) continue;
    let separatorIndex = -1;
    for (let index = startIndex + 1; index < lines.length; index += 1) {
      if (isConflictStart(lines[index].text)) break;
      if (lines[index].text.replace(/\r?\n$/, "") === "=======") {
        separatorIndex = index;
        break;
      }
    }
    if (separatorIndex < 0) continue;
    let endIndex = -1;
    for (let index = separatorIndex + 1; index < lines.length; index += 1) {
      if (isConflictStart(lines[index].text)) break;
      if (isConflictEnd(lines[index].text)) {
        endIndex = index;
        break;
      }
    }
    if (endIndex < 0) continue;
    let baseIndex = -1;
    for (let index = startIndex + 1; index < separatorIndex; index++) {
      if (isConflictBase(lines[index].text)) { baseIndex = index; break; }
    }
    const oursEnd = baseIndex >= 0 ? baseIndex : separatorIndex;
    const ours = content.slice(lines[startIndex].end, lines[oursEnd].start);
    const theirs = content.slice(lines[separatorIndex].end, lines[endIndex].start);
    const contentId = `${ours.length}:${theirs.length}:${hash(`${ours}\u0000${theirs}`)}`;
    const occurrence = seenIds.get(contentId) ?? 0;
    seenIds.set(contentId, occurrence + 1);
    blocks.push({
      index: blocks.length + 1,
      id: `${contentId}#${occurrence}`,
      start: lines[startIndex].start,
      end: lines[endIndex].end,
      ours,
      theirs,
      base: baseIndex >= 0 ? content.slice(lines[baseIndex].end, lines[separatorIndex].start) : null,
      line: startIndex + 1,
    });
    startIndex = endIndex;
  }
  return blocks;
}

export function replaceConflictBlock(content: string, block: ConflictBlock, replacement: string) {
  return content.slice(0, block.start) + replacement + content.slice(block.end);
}

export function choiceText(block: ConflictBlock, choice: BlockChoice) {
  return choice === "both" ? block.ours + block.theirs : block[choice];
}

/**
 * The common-ancestor text for a block: from its own diff3 section when present, otherwise from the matching
 * three-way merge conflict. `null` means the base cannot be determined (for example Git merged hunks differently).
 */
export function baseForBlock(block: ConflictBlock, regions: readonly Merge3Region[] | null): string | null {
  if (block.base !== null) return block.base;
  if (!regions) return null;
  const ours = withEol(block.ours);
  const theirs = withEol(block.theirs);
  for (const region of regions) {
    if (region.kind === "conflict" && withEol(region.ours.join("")) === ours && withEol(region.theirs.join("")) === theirs) return region.base.join("");
  }
  return null;
}

function isConflictStart(line: string) {
  return /^<{7}(?: .*)?$/.test(line.replace(/\r?\n$/, ""));
}

function isConflictEnd(line: string) {
  return /^>{7}(?: .*)?$/.test(line.replace(/\r?\n$/, ""));
}

function isConflictBase(line: string) {
  return /^\|{7}(?: .*)?$/.test(line.replace(/\r?\n$/, ""));
}

function hash(text: string) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value.toString(36);
}
