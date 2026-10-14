import { diffLines, type LineHunk } from "./line-diff";

export type Merge3Region =
  | { kind: "stable"; lines: string[] }
  /** Only one side changed this region, or both made the identical change (`both`). */
  | { kind: "ours" | "theirs" | "both"; base: string[]; ours: string[]; theirs: string[] }
  | { kind: "conflict"; base: string[]; ours: string[]; theirs: string[] };

export type NonConflictingMode = "all" | "ours" | "theirs";

interface SideHunk { hunk: LineHunk; side: "ours" | "theirs" }

/** Line-based three-way merge. Returns `null` when either side differs too much from the base to diff cheaply. */
export function merge3(base: readonly string[], ours: readonly string[], theirs: readonly string[]): Merge3Region[] | null {
  const oursHunks = diffLines(base, ours);
  const theirsHunks = diffLines(base, theirs);
  if (!oursHunks || !theirsHunks) return null;
  const hunks: SideHunk[] = [
    ...oursHunks.map((hunk) => ({ hunk, side: "ours" as const })),
    ...theirsHunks.map((hunk) => ({ hunk, side: "theirs" as const })),
  ].sort((left, right) => left.hunk.aStart - right.hunk.aStart || left.hunk.aEnd - right.hunk.aEnd);

  const regions: Merge3Region[] = [];
  let position = 0;
  let index = 0;
  while (index < hunks.length) {
    const cluster = [hunks[index]];
    const clusterStart = hunks[index].hunk.aStart;
    let clusterEnd = hunks[index].hunk.aEnd;
    index += 1;
    while (index < hunks.length && touches(hunks[index].hunk, clusterEnd)) {
      clusterEnd = Math.max(clusterEnd, hunks[index].hunk.aEnd);
      cluster.push(hunks[index]);
      index += 1;
    }
    if (clusterStart > position) regions.push({ kind: "stable", lines: base.slice(position, clusterStart) as string[] });
    const baseLines = base.slice(clusterStart, clusterEnd) as string[];
    const oursLines = applySide(base, ours, cluster, "ours", clusterStart, clusterEnd);
    const theirsLines = applySide(base, theirs, cluster, "theirs", clusterStart, clusterEnd);
    const hasOurs = cluster.some((entry) => entry.side === "ours");
    const hasTheirs = cluster.some((entry) => entry.side === "theirs");
    const kind = hasOurs && hasTheirs ? (sameLines(oursLines, theirsLines) ? "both" : "conflict") : hasOurs ? "ours" : "theirs";
    regions.push({ kind, base: baseLines, ours: oursLines, theirs: theirsLines });
    position = clusterEnd;
  }
  if (position < base.length) regions.push({ kind: "stable", lines: base.slice(position) as string[] });
  return regions;
}

export function countConflicts(regions: readonly Merge3Region[]) {
  return regions.filter((region) => region.kind === "conflict").length;
}

/**
 * Rebuilds a file from the merge regions. One-sided changes are applied according to `mode`; real conflicts stay as
 * diff3-style markers so every remaining decision is still visible to the user.
 */
export function renderMerge3(regions: readonly Merge3Region[], mode: NonConflictingMode, lineEnding = "\n") {
  const parts: string[] = [];
  const text = (lines: readonly string[]) => withEol(lines.join(""), lineEnding);
  for (const region of regions) {
    switch (region.kind) {
      case "stable": parts.push(region.lines.join("")); break;
      case "both": parts.push(region.ours.join("")); break;
      case "ours": parts.push((mode === "theirs" ? region.base : region.ours).join("")); break;
      case "theirs": parts.push((mode === "ours" ? region.base : region.theirs).join("")); break;
      case "conflict":
        parts.push(`<<<<<<< ours${lineEnding}${text(region.ours)}||||||| base${lineEnding}${text(region.base)}=======${lineEnding}${text(region.theirs)}>>>>>>> theirs${lineEnding}`);
        break;
    }
  }
  return parts.join("");
}

export function withEol(text: string, lineEnding = "\n") {
  return text === "" || text.endsWith("\n") ? text : text + lineEnding;
}

/** Like Git, hunks that touch (not only overlap) belong together, so adjacent edits are never combined silently. */
function touches(hunk: LineHunk, clusterEnd: number) {
  return hunk.aStart <= clusterEnd;
}

function applySide(base: readonly string[], side: readonly string[], cluster: SideHunk[], which: "ours" | "theirs", start: number, end: number) {
  const out: string[] = [];
  let position = start;
  for (const entry of cluster) {
    if (entry.side !== which) continue;
    out.push(...base.slice(position, entry.hunk.aStart), ...side.slice(entry.hunk.bStart, entry.hunk.bEnd));
    position = entry.hunk.aEnd;
  }
  out.push(...base.slice(position, end));
  return out;
}

function sameLines(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
