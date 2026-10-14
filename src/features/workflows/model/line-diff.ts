/** A replacement of `a[aStart, aEnd)` by `b[bStart, bEnd)`. Insertions have an empty a-range, deletions an empty b-range. */
export interface LineHunk {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
}

/** Edit-distance ceiling for the Myers search; beyond it callers fall back to plain rendering. */
const MAX_EDIT_DISTANCE = 1500;

/** Splits text into lines that keep their terminators, so joining the result reproduces the input exactly. */
export function splitLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Line-level diff. Returns the changed hunks in order, or `null` when the inputs differ too much to diff cheaply. */
export function diffLines(a: readonly string[], b: readonly string[], maxEdits = MAX_EDIT_DISTANCE): LineHunk[] | null {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) return [];
  const moves = shortestEdit(midA, midB, maxEdits);
  if (!moves) return null;

  const hunks: LineHunk[] = [];
  let aIndex = prefix;
  let bIndex = prefix;
  let open: LineHunk | null = null;
  for (const move of moves) {
    if (move === "equal") {
      if (open) { hunks.push(open); open = null; }
      aIndex += 1;
      bIndex += 1;
      continue;
    }
    open ??= { aStart: aIndex, aEnd: aIndex, bStart: bIndex, bEnd: bIndex };
    if (move === "delete") { aIndex += 1; open.aEnd = aIndex; } else { bIndex += 1; open.bEnd = bIndex; }
  }
  if (open) hunks.push(open);
  return hunks;
}

type Move = "equal" | "delete" | "insert";

function shortestEdit(a: readonly string[], b: readonly string[], maxEdits: number): Move[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const frontier = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(frontier.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1])
        ? frontier[offset + k + 1]
        : frontier[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x += 1; y += 1; }
      frontier[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m, offset);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, offset: number): Move[] {
  const reversed: Move[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const frontier = trace[d];
    const k = x - y;
    const previousK = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1]) ? k + 1 : k - 1;
    const previousX = frontier[offset + previousK];
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) { reversed.push("equal"); x -= 1; y -= 1; }
    if (d > 0) reversed.push(x === previousX ? "insert" : "delete");
    x = previousX;
    y = previousY;
  }
  return reversed.reverse();
}
