import type { DiffDocumentResponse } from "../../../api/client";

export interface FullFileSides {
  original: string;
  modified: string;
}

/** Rebuilds both complete file sides from a `context=full` document, whose single hunk spans every line. */
export function fullFileSides(document: DiffDocumentResponse): FullFileSides {
  const original: string[] = [];
  const modified: string[] = [];
  for (const hunk of document.hunks) {
    for (const row of hunk.rows) {
      if (row.oldText !== null && row.oldText !== undefined) original.push(row.oldText);
      if (row.newText !== null && row.newText !== undefined) modified.push(row.newText);
    }
  }
  return { original: original.join("\n"), modified: modified.join("\n") };
}
