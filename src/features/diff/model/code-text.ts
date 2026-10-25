import type { LanguageSyntax } from "../../languages";

/**
 * Plain-text helpers for describing changes: comparing code by tokens, ignoring comments, and finding
 * the names a line mentions. They are deliberately language-light; anything they cannot be sure of is
 * left as an ordinary change.
 */

// String literals stay whole, so whitespace inside a string is never mistaken for formatting.
const TOKEN = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[\p{L}\p{N}_$]+|[^\s\p{L}\p{N}_$]/gu;
const WORD = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

export function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

export function sameTokens(left: string, right: string): boolean {
  const a = tokens(left);
  const b = tokens(right);
  return a.length === b.length && a.every((token, index) => token === b[index]);
}

/** Identifier-like words of a line, outside its comments. */
export function words(text: string, syntax?: LanguageSyntax): string[] {
  return stripComments(text, syntax).match(WORD) ?? [];
}

/** Removes comments, keeping strings intact; a block comment may span several of the joined lines. */
export function stripComments(text: string, syntax?: LanguageSyntax): string {
  return splitComments(text, syntax).code;
}

/** Separates a text into its code, with comments blanked out, and the comments themselves. */
export function splitComments(text: string, syntax?: LanguageSyntax): { code: string; comments: string } {
  const lineMarkers = syntax?.lineComments ?? [];
  const blockMarkers = syntax?.blockComments ?? [];
  if (lineMarkers.length === 0 && blockMarkers.length === 0) return { code: text, comments: "" };
  let code = "";
  let comments = "";
  let index = 0;
  let quote: string | null = null;
  while (index < text.length) {
    const character = text[index] ?? "";
    if (quote) {
      code += character;
      if (character === "\\") {
        code += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (character === quote || character === "\n") quote = null;
      index += 1;
      continue;
    }
    if (character === "\"" || character === "'" || character === "`") {
      quote = character;
      code += character;
      index += 1;
      continue;
    }
    const block = blockMarkers.find(([open]) => text.startsWith(open, index));
    if (block) {
      const close = text.indexOf(block[1], index + block[0].length);
      const end = close === -1 ? text.length : close + block[1].length;
      comments += `${text.slice(index, end)}\n`;
      // Keep line breaks so line-based callers still line up.
      code += text.slice(index, end).replace(/[^\n]/g, " ");
      index = end;
      continue;
    }
    if (lineMarkers.some((marker) => text.startsWith(marker, index))) {
      const newline = text.indexOf("\n", index);
      const end = newline === -1 ? text.length : newline;
      comments += `${text.slice(index, end)}\n`;
      index = end;
      continue;
    }
    code += character;
    index += 1;
  }
  return { code, comments };
}

/** Compiles a language's debug patterns, skipping any that are not valid regular expressions. */
export function compilePatterns(patterns: readonly string[] | undefined): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns ?? []) {
    try {
      compiled.push(new RegExp(pattern, "u"));
    } catch {
      // Plugin patterns are validated when loaded; a bad one simply never matches.
    }
  }
  return compiled;
}

/** Keywords that only modify a declaration: visibility, static-ness, async-ness, export and the like. */
export const MODIFIER_WORDS = new Set([
  "public", "private", "protected", "internal", "static", "async", "export", "default", "abstract", "final",
  "override", "readonly", "const", "pub", "unsafe", "virtual", "sealed", "extern", "inline", "mut", "crate",
  "synchronized", "transient", "volatile", "native", "partial", "new", "open", "suspend", "declare", "required",
]);

/** A line that holds only an annotation, decorator or attribute, such as `@Override` or `#[test]`. */
export function isAnnotationLine(text: string): boolean {
  return /^\s*(?:@[\p{L}_$]|#!?\[|\[[\p{L}_])/u.test(text);
}
