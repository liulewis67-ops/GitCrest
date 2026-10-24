import type { Parser, Tree } from "@willbooster/web-tree-sitter";
import { languageById, loadGrammarModule, type LanguageDefinition, type SourceDeclaration } from "../../languages";

export type TreeSitterParseResult =
  | { status: "parsed"; recovered: boolean }
  | { status: "unsupported"; reason: "language" | "tooLarge" | "parserUnavailable" };
const MAX_PARSE_CODE_UNITS = 250_000;

export type SourceStructureResult =
  | { status: "parsed"; original: SourceDeclaration[]; modified: SourceDeclaration[]; recovered: boolean }
  | { status: "unsupported"; reason: "language" | "tooLarge" | "parserUnavailable" };

/** Lists the declarations of both complete sides of a file; trees never leave this function. */
export async function parseSourceStructure(
  language: LanguageDefinition | undefined,
  original: string,
  modified: string,
): Promise<SourceStructureResult> {
  if (!language) return { status: "unsupported", reason: "language" };
  if (original.length + modified.length > MAX_PARSE_CODE_UNITS) return { status: "unsupported", reason: "tooLarge" };

  let loader: Awaited<ReturnType<typeof loadGrammarModule>> | undefined;
  try {
    loader = await loadGrammarModule();
  } catch {
    return { status: "unsupported", reason: "parserUnavailable" };
  }
  const fromText = [loader.declarationsFromText(language, original), loader.declarationsFromText(language, modified)];
  if (fromText[0] && fromText[1]) return { status: "parsed", original: fromText[0], modified: fromText[1], recovered: false };

  let parser: Parser | undefined;
  let originalTree: Tree | null | undefined;
  let modifiedTree: Tree | null | undefined;
  try {
    parser = await loader.createParser(language);
    originalTree = parser.parse(original);
    modifiedTree = parser.parse(modified);
    if (!originalTree || !modifiedTree) return { status: "unsupported", reason: "parserUnavailable" };
    return {
      status: "parsed",
      original: loader.declarationsFromTree(language, originalTree.rootNode),
      modified: loader.declarationsFromTree(language, modifiedTree.rootNode),
      recovered: originalTree.rootNode.hasError || modifiedTree.rootNode.hasError,
    };
  } catch {
    return { status: "unsupported", reason: "parserUnavailable" };
  } finally {
    originalTree?.delete();
    modifiedTree?.delete();
    parser?.delete();
  }
}

/** Parses a Git hunk excerpt with the language's grammar; failures explicitly select plain-text fallback. */
export async function parseDiffHunkSyntax(
  languageId: string | null,
  original: string,
  modified: string,
): Promise<TreeSitterParseResult> {
  const language = languageId ? languageById(languageId) : undefined;
  if (!language?.grammar) return { status: "unsupported", reason: "language" };
  if (original.length + modified.length > MAX_PARSE_CODE_UNITS) return { status: "unsupported", reason: "tooLarge" };

  let parser: Parser | undefined;
  let originalTree: Tree | null | undefined;
  let modifiedTree: Tree | null | undefined;
  try {
    const loader = await loadGrammarModule();
    parser = await loader.createParser(language);
    originalTree = parser.parse(original);
    modifiedTree = parser.parse(modified);
    if (!originalTree || !modifiedTree) return { status: "unsupported", reason: "parserUnavailable" };
    return { status: "parsed", recovered: originalTree.rootNode.hasError || modifiedTree.rootNode.hasError };
  } catch {
    return { status: "unsupported", reason: "parserUnavailable" };
  } finally {
    originalTree?.delete();
    modifiedTree?.delete();
    parser?.delete();
  }
}
