import { Language, Parser } from "@willbooster/web-tree-sitter";
import runtimeWasmUrl from "../../../../node_modules/@willbooster/web-tree-sitter/web-tree-sitter.wasm?url";
import type { LanguageDefinition } from "./builtin-languages";
import { reportLanguageFailure } from "./language-registry";
import { extractDeclarations } from "./code-structure";
import { extractMarkdownSections } from "./markdown-structure";
import type { SourceDeclaration, SyntaxNodeLike } from "./structure-common";
import { extractWithRules } from "./structure-rules";

let runtimeInitialization: Promise<void> | null = null;
const loadedLanguages = new Map<string, Promise<Language>>();

async function initializeRuntime() {
  if (!runtimeInitialization) {
    runtimeInitialization = Parser.init({ locateFile: () => runtimeWasmUrl }).catch((error: unknown) => {
      runtimeInitialization = null;
      throw error;
    });
  }
  await runtimeInitialization;
}

/** Loads a language's tree-sitter grammar once per definition version. */
export async function loadGrammar(definition: LanguageDefinition): Promise<Language> {
  const source = definition.grammar;
  if (!source) throw new Error(`${definition.name} has no tree-sitter grammar.`);
  await initializeRuntime();
  const key = `${definition.id}\u0000${definition.version}`;
  let loading = loadedLanguages.get(key);
  if (!loading) {
    loading = ("url" in source ? Language.load(source.url) : source.bytes().then((bytes) => Language.load(bytes))).catch((error: unknown) => {
      loadedLanguages.delete(key);
      throw error;
    });
    loadedLanguages.set(key, loading);
  }
  return loading;
}

/**
 * A parser for the language. A grammar built for an incompatible tree-sitter version loads but is refused
 * here; for a plugin, that reason is recorded so Settings can show it.
 */
export async function createParser(definition: LanguageDefinition): Promise<Parser> {
  let parser: Parser | undefined;
  try {
    // Loading the grammar initializes the runtime, which must happen before any Parser exists.
    const language = await loadGrammar(definition);
    parser = new Parser();
    parser.setLanguage(language);
    return parser;
  } catch (error) {
    parser?.delete();
    if (definition.source === "plugin") reportLanguageFailure(definition.id, `The grammar could not be used: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/** Declarations of a parsed file, by the language's adapter. */
export function declarationsFromTree(definition: LanguageDefinition, root: SyntaxNodeLike): SourceDeclaration[] {
  switch (definition.structure.type) {
    case "script":
      return extractDeclarations(root, definition.id === "tsx" || definition.id === "jsx" ? "tsx" : definition.id === "typescript" ? "typescript" : "javascript");
    case "rust":
      return extractDeclarations(root, "rust");
    case "rules":
      return extractWithRules(root, definition.structure.rules);
    case "markdown":
      return [];
  }
}

/** Declarations of a language read without a parser, such as Markdown sections. */
export function declarationsFromText(definition: LanguageDefinition, text: string): SourceDeclaration[] | undefined {
  return definition.structure.type === "markdown" ? extractMarkdownSections(text) : undefined;
}

/** Loads and test-parses a plugin's grammar, returning why it cannot be used, if it cannot. */
export async function checkLanguage(definition: LanguageDefinition): Promise<string | undefined> {
  try {
    const parser = await createParser(definition);
    const tree = parser.parse("");
    tree?.delete();
    parser.delete();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
