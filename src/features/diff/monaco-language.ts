const SYNTAX_GRAMMARS: Record<string, { language: string; grammar: string }> = {
  cjs: { language: "javascript", grammar: "javascript" },
  js: { language: "javascript", grammar: "javascript" },
  jsx: { language: "javascript", grammar: "tsx" },
  mjs: { language: "javascript", grammar: "javascript" },
  mts: { language: "typescript", grammar: "typescript" },
  rs: { language: "rust", grammar: "rust" },
  ts: { language: "typescript", grammar: "typescript" },
  tsx: { language: "typescript", grammar: "tsx" },
};

export interface MonacoLanguage {
  id: string;
  treeSitterGrammar: string | null;
  supported: boolean;
}

export function monacoLanguageForPath(path: string): MonacoLanguage {
  const pathParts = path.split(/[\\/]/);
  const fileName = pathParts[pathParts.length - 1] ?? "";
  const fileParts = fileName.split(".");
  const extension = fileParts.length > 1 ? fileParts[fileParts.length - 1]?.toLowerCase() ?? "" : "";
  const syntax = SYNTAX_GRAMMARS[extension];
  return syntax
    ? { id: syntax.language, treeSitterGrammar: syntax.grammar, supported: true }
    : { id: "plaintext", treeSitterGrammar: null, supported: false };
}
