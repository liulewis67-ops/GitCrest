import { Language, Parser } from "@willbooster/web-tree-sitter";
import javascriptGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-javascript/tree-sitter-javascript.wasm?url";
import rustGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-rust/tree-sitter-rust.wasm?url";
import tsxGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-typescript/tree-sitter-tsx.wasm?url";
import typescriptGrammarUrl from "../../../../node_modules/@willbooster/tree-sitter-typescript/tree-sitter-typescript.wasm?url";
import runtimeWasmUrl from "../../../../node_modules/@willbooster/web-tree-sitter/web-tree-sitter.wasm?url";

export type TreeSitterGrammar = "javascript" | "rust" | "tsx" | "typescript";

export type TreeSitterParseResult =
  | { status: "parsed"; recovered: boolean }
  | { status: "unsupported"; reason: "language" | "tooLarge" | "parserUnavailable" };
const MAX_PARSE_CODE_UNITS = 250_000;

const grammarUrls: Record<TreeSitterGrammar, string> = {
  javascript: javascriptGrammarUrl,
  rust: rustGrammarUrl,
  tsx: tsxGrammarUrl,
  typescript: typescriptGrammarUrl,
};
let runtimeInitialization: Promise<void> | null = null;
const loadedLanguages = new Map<TreeSitterGrammar, Promise<Language>>();

async function loadLanguage(grammar: TreeSitterGrammar): Promise<Language> {
  if (!runtimeInitialization) {
    runtimeInitialization = Parser.init({ locateFile: () => runtimeWasmUrl }).catch((error: unknown) => {
      runtimeInitialization = null;
      throw error;
    });
  }
  await runtimeInitialization;

  let loading = loadedLanguages.get(grammar);
  if (!loading) {
    loading = Language.load(grammarUrls[grammar]).catch((error: unknown) => {
      loadedLanguages.delete(grammar);
      throw error;
    });
    loadedLanguages.set(grammar, loading);
  }
  return loading;
}

/** Parses a Git hunk excerpt with a bundled grammar; failures explicitly select plain-text fallback. */
export async function parseDiffHunkSyntax(
  grammar: string | null,
  original: string,
  modified: string,
): Promise<TreeSitterParseResult> {
  if (grammar !== "javascript" && grammar !== "rust" && grammar !== "tsx" && grammar !== "typescript") {
    return { status: "unsupported", reason: "language" };
  }
  if (original.length + modified.length > MAX_PARSE_CODE_UNITS) return { status: "unsupported", reason: "tooLarge" };

  let parser: Parser | undefined;
  let originalTree: ReturnType<Parser["parse"]> | undefined;
  let modifiedTree: ReturnType<Parser["parse"]> | undefined;
  try {
    const language = await loadLanguage(grammar);
    parser = new Parser();
    parser.setLanguage(language);
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
