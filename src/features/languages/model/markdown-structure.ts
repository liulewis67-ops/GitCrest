import { compact, DeclarationCollector, type SourceDeclaration } from "./structure-common";

const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MAX_NAME_UNITS = 120;

interface Heading {
  level: number;
  name: string;
  /** First line of the heading: the text line of a setext heading, which sits above its underline. */
  start: number;
  /** Last line of the heading itself. */
  end: number;
}

/**
 * Markdown sections: each heading with the text and subsections under it, up to the next heading of
 * the same or a higher level. Headings are read line by line, so code fences and front matter are skipped
 * without a grammar.
 */
export function extractMarkdownSections(text: string): SourceDeclaration[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const headings = findHeadings(lines);
  const collector = new DeclarationCollector();
  const open: Array<{ level: number; declaration: SourceDeclaration }> = [];
  const lastLine = Math.max(1, lines.length - (lines[lines.length - 1] === "" ? 1 : 0));

  headings.forEach((heading, index) => {
    while (open.length && (open[open.length - 1]?.level ?? 0) >= heading.level) open.pop();
    const parent = open[open.length - 1]?.declaration ?? null;
    // The section runs until the next heading that is not nested inside it.
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level);
    const end = next ? next.start - 1 : lastLine;
    const ownKey = `section:${heading.name}`;
    const declaration = collector.add({
      baseKey: parent ? `${parent.key}/${ownKey}` : ownKey,
      kind: "section",
      name: heading.name,
      parentKey: parent?.key ?? null,
      range: { start: heading.start, end: Math.max(end, heading.end) },
      bodyStart: heading.end + 1,
      reliable: true,
    });
    open.push({ level: heading.level, declaration });
  });
  return collector.finish();
}

function findHeadings(lines: string[]): Heading[] {
  const headings: Heading[] = [];
  let fence: { marker: string; length: number } | null = null;
  let index = 0;
  // Front matter: a block opened by `---` on the first line and closed by `---` or `...`.
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((line, at) => at > 0 && (line.trim() === "---" || line.trim() === "..."));
    if (close > 0) index = close + 1;
  }
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (fenceMatch && fenceMatch[1]?.[0] === fence.marker && (fenceMatch[1]?.length ?? 0) >= fence.length && line.trim() === fenceMatch[1]) fence = null;
      continue;
    }
    if (fenceMatch?.[1]) {
      fence = { marker: fenceMatch[1][0] ?? "`", length: fenceMatch[1].length };
      continue;
    }
    const atx = ATX_HEADING.exec(line);
    if (atx?.[1]) {
      headings.push({ level: atx[1].length, name: headingName(atx[2] ?? ""), start: index + 1, end: index + 1 });
      continue;
    }
    // A paragraph line followed by `===` or `---` is a setext heading; after a blank line, `---` is a rule.
    const underline = SETEXT_UNDERLINE.exec(lines[index + 1] ?? "");
    const previous = headings[headings.length - 1];
    if (underline?.[1] && line.trim() !== "" && !/^ {0,3}([-*+>]|\d+[.)])\s/.test(line) && previous?.end !== index) {
      headings.push({ level: underline[1][0] === "=" ? 1 : 2, name: headingName(line), start: index + 1, end: index + 2 });
      index += 1;
    }
  }
  return headings;
}

function headingName(text: string): string {
  const name = compact(text) || "#";
  return name.length > MAX_NAME_UNITS ? `${name.slice(0, MAX_NAME_UNITS - 1)}…` : name;
}
