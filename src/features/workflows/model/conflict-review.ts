import { findConflictBlocks, type BlockChoice, type ConflictBlock } from "./conflict-blocks";

/** Incomplete markers must not turn a failed parse into a false 'resolved' state. */
export function analyzeConflictDraft(content: string) {
  const blocks = findConflictBlocks(content);
  const markerLines = [...content.matchAll(/^(?:<{3,}|>{3,}|\|{7,}|={7,})(?:[^\r\n]*)/gm)];
  let blockIndex = 0;
  const malformed = markerLines.some((marker) => {
    const offset = marker.index ?? 0;
    while (blockIndex < blocks.length && blocks[blockIndex].end <= offset) blockIndex++;
    const block = blocks[blockIndex];
    return !block || offset < block.start;
  });
  return { blocks, malformed, hasMarkers: blocks.length > 0 || markerLines.length > 0 };
}

/** Only align an unambiguous exact source match; result offsets are never source line numbers. */
export function sourceOffset(source: string, block: ConflictBlock | undefined, side: "ours" | "theirs") {
  return block ? matchSource(source, block[side])?.offset : undefined;
}

function matchSource(source: string, text: string) {
  if (!text) return undefined;
  const normalized = source.replace(/\r\n/g, "\n");
  let needle = text.replace(/\r\n/g, "\n");
  let offset = normalized.indexOf(needle);
  // Closing markers need a separator newline even when the actual source ends without one.
  if (offset < 0 && needle.endsWith("\n") && normalized.endsWith(needle.slice(0, -1))) {
    needle = needle.slice(0, -1); offset = normalized.length - needle.length;
  }
  if (!needle || offset < 0 || normalized.indexOf(needle) !== offset || normalized.indexOf(needle, offset + 1) >= 0) return undefined;
  const rawOffset = (normalizedOffset: number) => {
    let raw = 0;
    for (let count = 0; count < normalizedOffset; count++) raw += source[raw] === "\r" && source[raw + 1] === "\n" ? 2 : 1;
    return raw;
  };
  const start = rawOffset(offset);
  return { offset: start, text: source.slice(start, rawOffset(offset + needle.length)) };
}

/** Recover the source's exact line endings when Git's marker formatting changed them. */
export function reviewChoiceText(block: ConflictBlock, choice: BlockChoice, oursSource: string | null | undefined, theirsSource: string | null | undefined) {
  const ours = oursSource == null ? block.ours : matchSource(oursSource, block.ours)?.text ?? block.ours;
  const theirs = theirsSource == null ? block.theirs : matchSource(theirsSource, block.theirs)?.text ?? block.theirs;
  if (choice === "ours") return ours;
  if (choice === "theirs") return theirs;
  const separator = ours && theirs && !ours.endsWith("\n") ? block.ours.endsWith("\r\n") ? "\r\n" : "\n" : "";
  return ours + separator + theirs;
}

/** Git adds a separator newline before the closing marker, even when the chosen source has none at EOF. */
export function preserveFinalNewline(draft: string, block: ConflictBlock, replacement: string, source: string | null | undefined) {
  return block.end === draft.length && source != null && !source.endsWith("\n") ? replacement.replace(/\r?\n$/, "") : replacement;
}
