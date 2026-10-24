import { languageForPath } from "../../languages";



// Monarch-only highlighting for the full-file viewer; languages with a tree-sitter grammar take precedence.
const HIGHLIGHT_LANGUAGES: Record<string, string> = {
  bash: "shell", bat: "bat", c: "cpp", cc: "cpp", cmd: "bat", conf: "ini", cpp: "cpp", cs: "csharp", css: "css",
  cxx: "cpp", dart: "dart", go: "go", gql: "graphql", gradle: "java", graphql: "graphql", h: "cpp", hpp: "cpp",
  htm: "html", html: "html", ini: "ini", java: "java", json: "json", jsonc: "json", kt: "kotlin", kts: "kotlin",
  less: "less", lua: "lua", markdown: "markdown", md: "markdown", php: "php", properties: "ini", proto: "protobuf",
  ps1: "powershell", psm1: "powershell", py: "python", rb: "ruby", scala: "scala", scss: "scss", sh: "shell",
  sql: "sql", svg: "xml", swift: "swift", toml: "ini", vue: "html", xml: "xml", yaml: "yaml", yml: "yaml", zsh: "shell",
};
const HIGHLIGHT_FILE_NAMES: Record<string, string> = { dockerfile: "dockerfile", makefile: "shell" };

/** Picks the Monaco language used to colour a whole file, falling back to plain text. */
export function monacoHighlightLanguageForPath(path: string): string {
  const syntax = monacoLanguageForPath(path);
  if (syntax.supported && syntax.id !== "plaintext") return syntax.id;
  const pathParts = path.split(/[\\/]/);
  const fileName = (pathParts[pathParts.length - 1] ?? "").toLowerCase();
  const fileParts = fileName.split(".");
  const extension = fileParts.length > 1 ? fileParts[fileParts.length - 1] ?? "" : "";
  return HIGHLIGHT_FILE_NAMES[fileName] ?? HIGHLIGHT_LANGUAGES[extension] ?? "plaintext";
}

export interface MonacoLanguage {
  id: string;
  treeSitterGrammar: string | null;
  supported: boolean;
}

/** The Monaco language of a file, and the language id whose tree-sitter grammar checks its hunks. */
export function monacoLanguageForPath(path: string): MonacoLanguage {
  const language = languageForPath(path);
  return language?.grammar
    ? { id: language.monacoLanguage, treeSitterGrammar: language.id, supported: true }
    : { id: "plaintext", treeSitterGrammar: null, supported: false };
}

/** Whether the file's changes can be grouped by code structure, by a built-in language or a plugin. */
export function hasCodeStructureSupport(path: string): boolean {
  return languageForPath(path) !== undefined;
}
