import type { DiffDocumentResponse } from "../../../api/client";
import { rowKey, type RowSelection } from "./code-review-analysis";

/** A selection as sent to staging: whole hunks or single change rows of the hunk document. */
export type DiffSelectionItem = { hunkIndex: number; rowIndex?: number };

/** Every change row a selection covers, with whole-hunk items expanded to their rows. */
export function selectedRowKeys(document: DiffDocumentResponse, selection: DiffSelectionItem[]): Set<string> {
  const keys = new Set<string>();
  for (const item of selection) {
    if (item.rowIndex !== undefined) {
      keys.add(rowKey(item.hunkIndex, item.rowIndex));
      continue;
    }
    document.hunks[item.hunkIndex]?.rows.forEach((row, rowIndex) => {
      if (row.kind === "change") keys.add(rowKey(item.hunkIndex, rowIndex));
    });
  }
  return keys;
}

/** Row selections in diff order, for a set of `hunkIndex:rowIndex` keys. */
export function rowSelectionsFor(keys: Iterable<string>): RowSelection[] {
  return [...keys]
    .map((key) => {
      const [hunkIndex, rowIndex] = key.split(":").map(Number);
      return { hunkIndex: hunkIndex ?? 0, rowIndex: rowIndex ?? 0 };
    })
    .sort((a, b) => a.hunkIndex - b.hunkIndex || a.rowIndex - b.rowIndex);
}
