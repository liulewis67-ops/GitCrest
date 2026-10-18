import { useI18n } from "../../../shared/i18n";
import { useMemo } from "react";
import { splitInlineDiff } from "../../diff";
import { diffLines, splitLines } from "../model/line-diff";

/** Beyond this many lines per side the diff is skipped and plain text is shown. */
const MAX_HIGHLIGHT_LINES = 2000;

type Change = { kind: "added" | "changed"; pair: string | null };
type Row = { type: "line"; number: number; text: string; change: Change | null } | { type: "removed"; count: number };

const MARKS = { added: "+", changed: "~" } as const;

/**
 * Renders one side of a conflict as numbered lines. When `reference` is given, lines that differ from it are tinted,
 * marked with a text symbol (never color alone), and changed words inside modified lines are highlighted.
 */
export function ConflictSideLines({ text, reference, startLine, emptyLabel }: {
  text: string;
  reference: string | null;
  startLine: number;
  emptyLabel?: string;
}) {
  const { t } = useI18n();
  const { rows, highlighted } = useMemo(() => buildRows(text, reference, startLine), [text, reference, startLine]);
  if (rows.length === 0) return <div className="conflictLineEmpty">{emptyLabel ?? t("sl.emptySide")}</div>;
  return <div className="conflictLines" data-highlighted={highlighted || undefined}>
    {rows.map((row, index) => row.type === "removed"
      ? <div className="conflictLine removed" key={`removed-${index}`}><span className="conflictLineNo" /><span className="conflictLineMark" role="img" aria-label={t("sl.removedLines")}>−</span><span className="conflictLineText">{t("sl.removedCount", { count: row.count, unit: row.count === 1 ? t("sl.lineOne") : t("sl.lineMany") })}</span></div>
      : <div className={`conflictLine${row.change ? ` ${row.change.kind}` : ""}`} key={row.number}>
        <span className="conflictLineNo">{row.number}</span>
        <span className="conflictLineMark" role={row.change ? "img" : undefined} aria-label={row.change ? (row.change.kind === "added" ? t("sl.addedLine") : t("sl.changedLine")) : undefined}>{row.change ? MARKS[row.change.kind] : ""}</span>
        <code className="conflictLineText">{renderText(row.text, row.change)}</code>
      </div>)}
  </div>;
}

function renderText(text: string, change: Change | null) {
  if (!change || change.pair === null) return text || " ";
  return splitInlineDiff(text, change.pair).map((segment, index) => segment.changed
    ? <mark className="conflictWord" key={index}>{segment.text}</mark>
    : segment.text);
}

function stripEol(line: string) {
  return line.replace(/\r?\n$/, "");
}

function buildRows(text: string, reference: string | null, startLine: number): { rows: Row[]; highlighted: boolean } {
  const lines = splitLines(text);
  const referenceLines = reference === null ? null : splitLines(reference);
  const hunks = referenceLines && lines.length <= MAX_HIGHLIGHT_LINES && referenceLines.length <= MAX_HIGHLIGHT_LINES
    ? diffLines(referenceLines, lines)
    : null;
  const changes = new Map<number, Change>();
  const removedBefore = new Map<number, number>();
  for (const hunk of hunks ?? []) {
    const replaced = hunk.aEnd - hunk.aStart;
    const inserted = hunk.bEnd - hunk.bStart;
    for (let offset = 0; offset < inserted; offset += 1) {
      const pair = offset < replaced ? stripEol(referenceLines![hunk.aStart + offset]) : null;
      changes.set(hunk.bStart + offset, { kind: pair === null ? "added" : "changed", pair });
    }
    if (replaced > inserted) removedBefore.set(hunk.bEnd, (removedBefore.get(hunk.bEnd) ?? 0) + replaced - inserted);
  }
  const rows: Row[] = [];
  lines.forEach((line, index) => {
    const removed = removedBefore.get(index);
    if (removed) rows.push({ type: "removed", count: removed });
    rows.push({ type: "line", number: startLine + index, text: stripEol(line), change: changes.get(index) ?? null });
  });
  const trailingRemoved = removedBefore.get(lines.length);
  if (trailingRemoved) rows.push({ type: "removed", count: trailingRemoved });
  return { rows, highlighted: hunks !== null };
}
