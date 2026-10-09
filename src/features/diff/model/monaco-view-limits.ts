import type { DiffDocumentResponse } from "../../../api/client";

const MAX_MONACO_HUNKS = 50;
const MAX_MONACO_TEXT_UNITS = 1_000_000;

export function exceedsMonacoViewLimits(hunks: DiffDocumentResponse["hunks"]): boolean {
  if (hunks.length > MAX_MONACO_HUNKS) return true;
  const textUnits = hunks.reduce((total, hunk) => total + hunk.rows.reduce(
    (hunkTotal, row) => hunkTotal + (row.oldText?.length ?? 0) + (row.newText?.length ?? 0) + 1,
    0,
  ), 0);
  return textUnits > MAX_MONACO_TEXT_UNITS;
}
