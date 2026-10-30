import type { DiffDocumentResponse } from "../../../api/client";

export interface LfsPointer {
  /** The object id the pointer names, without the `sha256:` prefix. */
  oid: string;
  size: number;
}

export interface LfsPointerChange {
  kind: "added" | "removed" | "changed";
  before?: LfsPointer;
  after?: LfsPointer;
}

const VERSION = /^version https:\/\/git-lfs\.github\.com\/spec\/v\d+$/;
const OID = /^oid sha256:([0-9a-f]{64})$/;
const SIZE = /^size (\d{1,15})$/;
/** A pointer is a few short `key value` lines; anything bigger is a real text file. */
const MAX_POINTER_LINES = 12;

/** The pointer a text holds, or nothing when it is not exactly a Git LFS pointer file. */
export function parseLfsPointer(text: string): LfsPointer | undefined {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 3 || lines.length > MAX_POINTER_LINES || !VERSION.test(lines[0])) return undefined;
  let oid: string | undefined;
  let size: number | undefined;
  for (const line of lines.slice(1)) {
    if (!/^[a-z][a-z0-9.-]* \S.*$/.test(line)) return undefined;
    const oidMatch = OID.exec(line);
    const sizeMatch = SIZE.exec(line);
    if (oidMatch) oid = oidMatch[1];
    else if (sizeMatch) size = Number(sizeMatch[1]);
  }
  return oid !== undefined && size !== undefined ? { oid, size } : undefined;
}

function sideText(document: DiffDocumentResponse, side: "old" | "new"): string {
  const lines: string[] = [];
  for (const hunk of document.hunks) {
    for (const row of hunk.rows) {
      const text = side === "old" ? row.oldText : row.newText;
      if (text !== null && text !== undefined) lines.push(text);
    }
  }
  return lines.join("\n");
}

/**
 * When a diff only moves a Git LFS pointer (the file's content lives in LFS), the three pointer
 * lines say what changed far less clearly than the object and size do. Nothing else qualifies:
 * both sides must be a pointer or empty, and at least one must be a pointer.
 */
export function lfsPointerChange(document: DiffDocumentResponse): LfsPointerChange | undefined {
  if (document.status !== "text" || document.hunks.length === 0) return undefined;
  const oldText = sideText(document, "old");
  const newText = sideText(document, "new");
  const before = oldText ? parseLfsPointer(oldText) : undefined;
  const after = newText ? parseLfsPointer(newText) : undefined;
  if ((oldText && !before) || (newText && !after) || (!before && !after)) return undefined;
  return { kind: !before ? "added" : !after ? "removed" : "changed", ...(before ? { before } : {}), ...(after ? { after } : {}) };
}

export function formatLfsSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}
