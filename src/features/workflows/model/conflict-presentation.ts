import { baseForBlock, findConflictBlocks, type ConflictBlock } from "./conflict-blocks";
import { preserveFinalNewline, reviewChoiceText } from "./conflict-review";
import type { Merge3Region } from "./merge3";
import { sourceOffset } from "./conflict-review";

export interface PresentedConflict { block: ConflictBlock; start: number; end: number }
export interface ConflictPresentation { raw: string; text: string; conflicts: PresentedConflict[] }

/** Region offsets also locate deletions, whose source text has zero length. */
export function conflictSourceLocations(blocks: readonly ConflictBlock[], regions: readonly Merge3Region[] | null, ours: string, theirs: string) {
  let current = 0;
  let incoming = 0;
  const candidates: Array<{ ours: number; theirs: number; current: string; incoming: string }> = [];
  const normalize = (text: string) => text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  for (const region of regions ?? []) {
    if (region.kind === "stable") { const length = region.lines.join("").length; current += length; incoming += length; continue; }
    if (region.kind === "conflict") candidates.push({ ours: current, theirs: incoming, current: normalize(region.ours.join("")), incoming: normalize(region.theirs.join("")) });
    current += region.ours.join("").length; incoming += region.theirs.join("").length;
  }
  return blocks.map((block) => {
    const matching = candidates.filter((item) => item.current === normalize(block.ours) && item.incoming === normalize(block.theirs));
    // Ambiguous repeated regions remain unmapped; never apply an arrow to a guessed range.
    return matching.length === 1 ? { ours: matching[0].ours, theirs: matching[0].theirs }
      : { ours: sourceOffset(ours, block, "ours"), theirs: sourceOffset(theirs, block, "theirs") };
  });
}

/** Git markers remain an internal pending-decision representation, never editor content. */
export function presentConflicts(raw: string, regions: readonly Merge3Region[] | null, ours?: string | null, theirs?: string | null): ConflictPresentation {
  const conflicts: PresentedConflict[] = [];
  let text = "";
  let cursor = 0;
  for (const block of findConflictBlocks(raw)) {
    text += raw.slice(cursor, block.start);
    const start = text.length;
    const base = baseForBlock(block, regions);
    // The ancestor is the neutral starting point. If unavailable, show current text as a pending proposal.
    const proposal = base ?? preserveFinalNewline(raw, block, reviewChoiceText(block, "ours", ours, theirs), ours);
    text += proposal;
    conflicts.push({ block, start, end: text.length });
    cursor = block.end;
  }
  return { raw, text: text + raw.slice(cursor), conflicts };
}

export function presentedOffset(view: ConflictPresentation, rawOffset: number) {
  let delta = 0;
  for (const { block, start, end } of view.conflicts) {
    if (rawOffset < block.start) break;
    if (rawOffset < block.end) return start;
    delta += block.end - block.start - (end - start);
  }
  return rawOffset - delta;
}

/** Editing a pending region explicitly supplies its output; other decisions remain pending. */
export function applyPresentedEdit(view: ConflictPresentation, next: string) {
  if (next === view.text) return view.raw;
  let start = 0;
  while (start < view.text.length && start < next.length && view.text[start] === next[start]) start++;
  let end = view.text.length;
  let nextEnd = next.length;
  while (end > start && nextEnd > start && view.text[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  const touched = view.conflicts.filter((item) => start === end
    ? start >= item.start && (start < item.end || item.start === item.end)
    : start < item.end && end > item.start || item.start === item.end && start <= item.start && end >= item.end);
  const from = Math.min(start, ...touched.map((item) => item.start));
  const to = Math.max(end, ...touched.map((item) => item.end));
  const rawOffset = (offset: number, edge: "start" | "end") => {
    let delta = 0;
    for (const item of view.conflicts) {
      if (touched.includes(item) && offset >= item.start && offset <= item.end) return edge === "start" ? item.block.start : item.block.end;
      if (item.end <= offset) delta += item.block.end - item.block.start - (item.end - item.start);
    }
    return offset + delta;
  };
  return view.raw.slice(0, rawOffset(from, "start")) + view.text.slice(from, start) + next.slice(start, nextEnd) + view.text.slice(end, to) + view.raw.slice(rawOffset(to, "end"));
}
