import type { BlameDocumentResponse } from "../../../api/client";
import { getLocale } from "../../../shared/i18n";

export type BlameLine = BlameDocumentResponse["lines"][number];
/** Finds the blame for one line of a diff's new side, given its number and text. */
export type BlameLookup = (lineNumber: number | null | undefined, text: string | null | undefined) => BlameLine | undefined;

const UNCOMMITTED = /^0+$/;

/**
 * Blame describes one version of the file; a diff's new side can differ from it (a staged file blamed
 * from the working tree, or a file edited since). A line is annotated only when its text still matches,
 * and lines no commit owns yet stay blank, as in an editor's gutter.
 */
export function createBlameLookup(document: BlameDocumentResponse): BlameLookup {
  const byLine = new Map(document.lines.map((line) => [line.lineNumber, line]));
  return (lineNumber, text) => {
    if (lineNumber === null || lineNumber === undefined || text === null || text === undefined) return undefined;
    const line = byLine.get(lineNumber);
    if (!line || UNCOMMITTED.test(line.commitOid)) return undefined;
    return withoutCarriageReturn(line.text) === withoutCarriageReturn(text) ? line : undefined;
  };
}

function withoutCarriageReturn(text: string) {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

const dateFormatters = new Map<string, { day: Intl.DateTimeFormat; full: Intl.DateTimeFormat }>();

function blameDateFormatter() {
  const language = getLocale() === "zh" ? "zh-CN" : undefined;
  const cacheKey = language ?? "default";
  let formatter = dateFormatters.get(cacheKey);
  if (!formatter) {
    formatter = {
      day: new Intl.DateTimeFormat(language, { dateStyle: "short" }),
      full: new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }),
    };
    dateFormatters.set(cacheKey, formatter);
  }
  return formatter;
}

const GUTTER_AUTHOR_CHARS = 12;

/** The same day and author as plain text, for gutters that draw text only (Monaco's line numbers). */
export function blameGutterLabel(line?: BlameLine): string {
  if (!line) return "";
  const author = line.authorName.length > GUTTER_AUTHOR_CHARS ? `${line.authorName.slice(0, GUTTER_AUTHOR_CHARS - 1)}…` : line.authorName;
  return `${blameDateFormatter().day.format(new Date(line.committedAtMs))} ${author}`;
}

/** The day a line was committed and its author; the commit, its subject and the exact time are in the tooltip. */
export function BlameAnnotation({ line }: { line?: BlameLine }) {
  if (!line) return <span className="blameAnnotation" />;
  const dates = blameDateFormatter();
  const committedAt = new Date(line.committedAtMs);
  return <span className="blameAnnotation" title={`${line.commitOid.slice(0, 8)} ${line.summary}\n${line.authorName} <${line.authorEmail}>\n${dates.full.format(committedAt)}`}>
    <span className="blameDate">{dates.day.format(committedAt)}</span>
    <span className="blameAuthor">{line.authorName}</span>
  </span>;
}
