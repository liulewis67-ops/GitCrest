import type { DiffDocumentResponse } from "../../../api/client";
import { rowKey, type RowSelection } from "./code-review-analysis";

export type RowSide = "old" | "new";

/** A selection as sent to staging: a whole hunk, a change row, or one side of a row that has both. */
export type DiffSelectionItem = { hunkIndex: number; rowIndex?: number; side?: RowSide };

/** How much of one change row is selected. */
export type RowSelectionState = "all" | RowSide | "none";

/**
 * Selected change rows as keys: `hunk:row` for a whole row, `hunk:row:old` or `hunk:row:new` for one
 * side. Whole-hunk items are expanded to their rows, and two halves of one row become the whole row.
 */
export function selectedRowKeys(document: DiffDocumentResponse, selection: DiffSelectionItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of selection) {
    if (item.rowIndex !== undefined) {
      addKey(keys, item.hunkIndex, item.rowIndex, item.side ? item.side : "all");
      continue;
    }
    document.hunks[item.hunkIndex]?.rows.forEach((row, rowIndex) => {
      if (row.kind === "change") addKey(keys, item.hunkIndex, rowIndex, "all");
    });
  }
  return keys;
}

function addKey(keys: Set<string>, hunkIndex: number, rowIndex: number, part: "all" | RowSide) {
  const whole = rowKey(hunkIndex, rowIndex);
  if (keys.has(whole)) return;
  if (part === "all") {
    keys.delete(`${whole}:old`);
    keys.delete(`${whole}:new`);
    keys.add(whole);
    return;
  }
  const other = `${whole}:${part === "old" ? "new" : "old"}`;
  if (keys.has(other)) {
    keys.delete(other);
    keys.add(whole);
  } else {
    keys.add(`${whole}:${part}`);
  }
}

export function rowState(keys: ReadonlySet<string>, hunkIndex: number, rowIndex: number): RowSelectionState {
  const whole = rowKey(hunkIndex, rowIndex);
  if (keys.has(whole)) return "all";
  if (keys.has(`${whole}:old`)) return "old";
  if (keys.has(`${whole}:new`)) return "new";
  return "none";
}

/** A copy of the keys with one row set to the given state. */
export function withRowState(keys: ReadonlySet<string>, hunkIndex: number, rowIndex: number, state: RowSelectionState): Set<string> {
  const next = new Set(keys);
  const whole = rowKey(hunkIndex, rowIndex);
  next.delete(whole);
  next.delete(`${whole}:old`);
  next.delete(`${whole}:new`);
  if (state !== "none") addKey(next, hunkIndex, rowIndex, state);
  return next;
}

/** Adds the given row selections, merging halves with what is already selected. */
export function withRows(keys: ReadonlySet<string>, rows: readonly RowSelection[]): Set<string> {
  const next = new Set(keys);
  for (const row of rows) addKey(next, row.hunkIndex, row.rowIndex, row.side ?? "all");
  return next;
}

/** Removes the given row selections; removing one half of a whole row keeps the other half. */
export function withoutRows(keys: ReadonlySet<string>, rows: readonly RowSelection[]): Set<string> {
  let next = new Set(keys);
  for (const row of rows) {
    const state = rowState(next, row.hunkIndex, row.rowIndex);
    if (!row.side || state === row.side) next = withRowState(next, row.hunkIndex, row.rowIndex, "none");
    else if (state === "all") next = withRowState(next, row.hunkIndex, row.rowIndex, row.side === "old" ? "new" : "old");
  }
  return next;
}

/** Selection items in diff order; a hunk whose change rows are all wholly selected is sent as the hunk. */
export function selectionFromKeys(document: DiffDocumentResponse, keys: ReadonlySet<string>): DiffSelectionItem[] {
  const items: DiffSelectionItem[] = [];
  document.hunks.forEach((hunk, hunkIndex) => {
    const changeRows = hunk.rows.flatMap((row, rowIndex) => row.kind === "change" ? [rowIndex] : []);
    const states = changeRows.map((rowIndex) => rowState(keys, hunkIndex, rowIndex));
    if (changeRows.length > 0 && states.every((state) => state === "all")) {
      items.push({ hunkIndex });
      return;
    }
    changeRows.forEach((rowIndex, index) => {
      const state = states[index];
      if (state === "all") items.push({ hunkIndex, rowIndex });
      else if (state === "old" || state === "new") items.push({ hunkIndex, rowIndex, side: state });
    });
  });
  return items;
}

/** Selected change rows, counting a half-selected row once. */
export function selectedRowCount(keys: ReadonlySet<string>): number {
  return new Set([...keys].map((key) => key.split(":").slice(0, 2).join(":"))).size;
}
